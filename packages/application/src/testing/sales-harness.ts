import type { CurrencyDefinition, MembershipRole, ProductVariantId, ValuationStatus } from "@tali/domain";
import { AuditRecorder } from "../audit/audit-recorder.js";
import type { BusinessAuditRecord } from "../audit/audit-writer.js";
import { taliAuditRegistry } from "../audit/tali-audit-registry.js";
import type { LocationBoundContext } from "../context/business-context.js";
import { KeyedIdempotency } from "../idempotency/keyed-idempotency.js";
import type { GetSale, ListSales, RecordSale, ReverseSale } from "../modules/sales/index.js";
import { createGetSale, createListSales, createRecordSale, createReverseSale } from "../modules/sales/index.js";
import { createNoTaxSnapshotResolver } from "../modules/sales/tax-resolver.js";
import type { CatalogHarness } from "./catalog-harness.js";
import { createCatalogHarness } from "./catalog-harness.js";
import { InMemorySalesStore } from "./in-memory-sales-store.js";

export interface SalesHarness {
  readonly catalog: CatalogHarness;
  readonly salesStore: InMemorySalesStore;
  readonly recordSale: RecordSale;
  readonly reverseSale: ReverseSale;
  readonly getSale: GetSale;
  readonly listSales: ListSales;
  businessWithRoles(
    name: string,
    currencyCode?: string,
  ): Promise<Readonly<Record<MembershipRole, LocationBoundContext>>>;
  product(
    context: LocationBoundContext,
    props?: { readonly name?: string; readonly stockUnit?: string; readonly trackInventory?: boolean },
  ): Promise<{ readonly productId: string; readonly variantId: string; readonly version: number }>;
  price(
    context: LocationBoundContext,
    productId: string,
    expectedVersion: number,
    amountMinor: string,
  ): Promise<number>;
  putStock(
    context: LocationBoundContext,
    variantId: string,
    props: { readonly quantityMinor: bigint; readonly valueMinor: bigint; readonly status: ValuationStatus },
  ): void;
  saleAudit(): readonly BusinessAuditRecord[];
}

export function createSalesHarness(options: {
  readonly currencies: readonly CurrencyDefinition[];
  readonly start?: string;
}): SalesHarness {
  const catalog = createCatalogHarness(options);
  const { tenancy } = catalog;
  const salesStore = new InMemorySalesStore(tenancy.unitOfWork);
  tenancy.unitOfWork.enlist(salesStore);
  const { clock, ids, hasher, unitOfWork } = tenancy;
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: tenancy.auditWriter, clock, ids });
  const idempotency = new KeyedIdempotency({ businessStore: tenancy.businessIdempotencyStore, clock, ids });
  const shared = {
    unitOfWork,
    memberships: tenancy.store.membershipRepository,
    products: catalog.catalog.productRepository,
    units: catalog.catalog.unitRepository,
    sales: salesStore.sales,
    receiptNumbers: salesStore.receiptNumbers,
    inventory: salesStore.inventory,
    tax: createNoTaxSnapshotResolver(),
    accounts: tenancy.ledger,
    journals: tenancy.ledger,
    idempotency,
    hasher,
    audit,
    ids,
    clock,
  };
  let productSequence = 0;
  return {
    catalog,
    salesStore,
    recordSale: createRecordSale(shared),
    reverseSale: createReverseSale(shared),
    getSale: createGetSale({ unitOfWork, memberships: shared.memberships, sales: shared.sales }),
    listSales: createListSales({ unitOfWork, memberships: shared.memberships, sales: shared.sales }),
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
      return {
        productId: outcome.item.product.id,
        variantId: outcome.item.variant.id,
        version: outcome.item.product.version,
      };
    },
    async price(context, productId, expectedVersion, amountMinor) {
      const outcome = await catalog.setSellingPrice.execute(context, {
        productId,
        expectedVersion,
        price: { amountMinor, currency: context.currency },
      });
      return outcome.item.variant.priceVersion;
    },
    putStock(context, variantId, props) {
      salesStore.putStock({
        businessId: context.businessId,
        locationId: context.locationId,
        variantId: variantId as ProductVariantId,
        quantityMinor: props.quantityMinor,
        valueMinor: props.valueMinor,
        status: props.status,
      });
    },
    saleAudit() {
      return tenancy.auditWriter.businessRecords.filter((record) => record.action.startsWith("sale."));
    },
  };
}
