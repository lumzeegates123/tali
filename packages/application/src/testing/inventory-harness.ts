import type { CatalogProduct, CurrencyDefinition, MembershipRole, ProductVariantId } from "@tali/domain";
import { AuditRecorder } from "../audit/audit-recorder.js";
import type { BusinessAuditRecord } from "../audit/audit-writer.js";
import { taliAuditRegistry } from "../audit/tali-audit-registry.js";
import type { LocationBoundContext } from "../context/business-context.js";
import { KeyedIdempotency } from "../idempotency/keyed-idempotency.js";
import type {
  ClearLowStockThreshold,
  PostGoodsReceipt,
  RecordAdjustment,
  RecordOpeningStock,
  RecordWriteOff,
  ReverseAdjustment,
  ReverseGoodsReceipt,
  SetLowStockThreshold,
} from "../modules/inventory/index.js";
import {
  createClearLowStockThreshold,
  createPostGoodsReceipt,
  createRecordAdjustment,
  createRecordOpeningStock,
  createRecordWriteOff,
  createReverseAdjustment,
  createReverseGoodsReceipt,
  createSetLowStockThreshold,
} from "../modules/inventory/index.js";
import type { CatalogHarness } from "./catalog-harness.js";
import { createCatalogHarness } from "./catalog-harness.js";
import { InMemoryInventoryStore } from "./in-memory-inventory-store.js";

/**
 * Wraps a port so every method call is appended to `log` as `name.method`
 * before it runs. Calls run against the original object, so private state and
 * failure injection behave as without the wrapper.
 */
function logged<T extends object>(name: string, target: T, log: string[]): T {
  return new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        log.push(`${name}.${String(property)}`);
        return Reflect.apply(value, object, args) as unknown;
      };
    },
  });
}

/** Every Slice 5 inventory use case composed over the catalog harness's fakes, with a call log of every port call. */
export interface InventoryHarness {
  readonly catalog: CatalogHarness;
  readonly inventory: InMemoryInventoryStore;
  /**
   * Every repository, idempotency-store and audit-writer call made by the
   * inventory use cases, in order (for example `idempotency.find`,
   * `products.lockVariantsForShare`). Tests may clear it.
   */
  readonly calls: string[];
  readonly recordOpeningStock: RecordOpeningStock;
  readonly postGoodsReceipt: PostGoodsReceipt;
  readonly recordAdjustment: RecordAdjustment;
  readonly recordWriteOff: RecordWriteOff;
  readonly reverseGoodsReceipt: ReverseGoodsReceipt;
  readonly reverseAdjustment: ReverseAdjustment;
  readonly setLowStockThreshold: SetLowStockThreshold;
  readonly clearLowStockThreshold: ClearLowStockThreshold;
  /** A business with one ACTIVE member per role, each context bound to the business's default location. */
  businessWithRoles(
    name: string,
    currencyCode?: string,
  ): Promise<Readonly<Record<MembershipRole, LocationBoundContext>>>;
  /** Creates an ACTIVE product through CreateProduct as the given member. */
  product(
    context: LocationBoundContext,
    props?: { readonly name?: string; readonly stockUnit?: string; readonly trackInventory?: boolean },
  ): Promise<CatalogProduct>;
  /** The stored balance of a stock item at the context's location in minor units; "0" when no row exists. */
  stock(context: LocationBoundContext, variantId: string): string;
  /** The inventory audit records written so far, oldest first. */
  inventoryAudit(): readonly BusinessAuditRecord[];
  /** A comparable fingerprint of every inventory row, audit record and idempotency record, to prove "nothing written". */
  state(): string;
}

export function createInventoryHarness(options: {
  readonly currencies: readonly CurrencyDefinition[];
  readonly start?: string;
}): InventoryHarness {
  const catalog = createCatalogHarness(options);
  const { tenancy } = catalog;
  const { unitOfWork, clock, ids, hasher } = tenancy;
  const inventory = new InMemoryInventoryStore({ unitOfWork, catalog: catalog.catalog, tenancy: tenancy.store });
  const calls: string[] = [];
  const audit = new AuditRecorder({
    registry: taliAuditRegistry,
    writer: logged("audit", tenancy.auditWriter, calls),
    clock,
    ids,
  });
  const idempotency = new KeyedIdempotency({
    businessStore: logged("idempotency", tenancy.businessIdempotencyStore, calls),
    clock,
    ids,
  });
  const shared = {
    unitOfWork,
    memberships: logged("memberships", tenancy.store.membershipRepository, calls),
    products: logged("products", catalog.catalog.productRepository, calls),
    packs: logged("packs", catalog.catalog.packRepository, calls),
    units: logged("units", catalog.catalog.unitRepository, calls),
    movements: logged("movements", inventory.movementRepository, calls),
    balances: logged("balances", inventory.balanceRepository, calls),
    idempotency,
    hasher,
    audit,
    ids,
    clock,
  };
  const openings = logged("openings", inventory.openingRepository, calls);
  const receipts = logged("goodsReceipts", inventory.receiptRepository, calls);
  const adjustments = logged("adjustments", inventory.adjustmentRepository, calls);
  const thresholds = logged("thresholds", inventory.thresholdRepository, calls);
  let productSequence = 0;

  return {
    catalog,
    inventory,
    calls,
    recordOpeningStock: createRecordOpeningStock({ ...shared, openings }),
    postGoodsReceipt: createPostGoodsReceipt({ ...shared, receipts }),
    recordAdjustment: createRecordAdjustment({ ...shared, adjustments }),
    recordWriteOff: createRecordWriteOff({ ...shared, adjustments }),
    reverseGoodsReceipt: createReverseGoodsReceipt({ ...shared, receipts }),
    reverseAdjustment: createReverseAdjustment({ ...shared, adjustments }),
    setLowStockThreshold: createSetLowStockThreshold({ ...shared, thresholds }),
    clearLowStockThreshold: createClearLowStockThreshold({ ...shared, thresholds }),
    async businessWithRoles(name, currencyCode) {
      const contexts = await catalog.businessWithRoles(name, currencyCode);
      const bound: Partial<Record<MembershipRole, LocationBoundContext>> = {};
      for (const [role, context] of Object.entries(contexts) as [MembershipRole, (typeof contexts)[MembershipRole]][]) {
        bound[role] = await tenancy.defaultLocations.resolveDefaultLocation(context);
      }
      return bound as Readonly<Record<MembershipRole, LocationBoundContext>>;
    },
    async product(context, props = {}) {
      productSequence += 1;
      const outcome = await catalog.createProduct.execute(context, {
        name: props.name ?? `Product ${productSequence}`,
        stockUnit: props.stockUnit ?? "PIECE",
        trackInventory: props.trackInventory ?? true,
        idempotencyKey: ids.newId("IdempotencyKey"),
      });
      return outcome.item;
    },
    stock(context, variantId) {
      const balance = inventory.balanceOf(context.businessId, context.locationId, variantId as ProductVariantId);
      return balance?.quantity.toMinorUnitsString() ?? "0";
    },
    inventoryAudit() {
      return tenancy.auditWriter.businessRecords.filter((record) => record.action.startsWith("inventory."));
    },
    state() {
      return JSON.stringify({
        movements: inventory.movements.map((m) => [m.id, m.variantId, m.delta.toMinorUnitsString(), m.balanceVersion]),
        balances: inventory.balances.map((b) => [b.variantId, b.quantity.toMinorUnitsString(), b.version]),
        openings: inventory.openings.map((o) => o.id),
        receipts: inventory.receipts.map((r) => [r.id, r.status]),
        adjustments: inventory.adjustments.map((a) => [a.id, a.status]),
        thresholds: inventory.thresholds.map((t) => [t.id, t.version, t.threshold?.toMinorUnitsString() ?? null]),
        audit: tenancy.auditWriter.businessRecords.length,
        keys: tenancy.businessIdempotencyStore.records.length,
      });
    },
  };
}
