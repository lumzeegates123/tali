import { hasPermission } from "../../authorization/permissions.js";
import type { LineDiscount, ProductName, ProductVariant, ProductVariantId, SaleId, SaleLine, Sku } from "@tali/domain";
import {
  BusinessDate,
  DomainError,
  KernelError,
  Money,
  Quantity,
  SALE_POSTED_RULE,
  SALE_POSTED_VERSION,
  TENDER_METHODS,
  buildSaleLine,
  createSale,
  lineDiscountAmount,
  lineGross,
  parseProductVariantId,
  parseSaleId,
  parseUnitCode,
  planSaleStock,
  salePostedPlan,
  withOriginalJournal,
  type PlannedSaleStockEffect,
  type TenderMethod,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import {
  DiscountExceedsLineError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
  PriceChangedError,
  PriceNotSetError,
  ProductArchivedError,
  TenderTotalMismatchError,
  ValidationError,
  type PriceChangeDetail,
} from "../../errors/application-error.js";
import { toApplicationError } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding, type CommandValue } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import type { IdempotencyKey } from "../../idempotency/idempotency-key.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import { objectAt, textAt } from "../../idempotency/result-json.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { JsonValue } from "../../ports/queue-provider.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { PRODUCT_NOT_FOUND } from "../catalog/index.js";
import type { ProductRepository, UnitReferenceRepository } from "../catalog/index.js";
import { inventoryPermissions, permissionsForRole, salesPermissions } from "../identity/index.js";
import { createLedgerPostingService, type LedgerPostingDependencies } from "../ledger/posting.js";
import { saleRecorded } from "./audit-actions.js";
import type { SaleReceiptNumberIssuer, SaleRepository, SalesInventoryPort } from "./ports.js";
import type { SaleTaxSnapshotResolver } from "./tax-resolver.js";
import { presentSale, type SaleView } from "./view.js";

export const RECORD_SALE_OPERATION = "sales.sale.record.v1";

export interface RecordSaleLineInput {
  readonly variantId: string;
  readonly quantityMinor: string;
  readonly unit: string;
  readonly expectedPriceVersion: number;
  readonly discount?:
    | { readonly kind: "NONE" }
    | { readonly kind: "FIXED"; readonly amountMinor: string }
    | { readonly kind: "BASIS_POINTS"; readonly basisPoints: number };
}

export interface RecordSaleTenderInput {
  readonly method: string;
  readonly amountMinor: string;
  readonly reference?: string;
  readonly cashReceivedMinor?: string;
}

export interface RecordSaleInput {
  readonly saleId: string;
  readonly idempotencyKey: string | undefined;
  readonly deviceReportedAt?: string;
  readonly lines: readonly RecordSaleLineInput[];
  readonly tenders: readonly RecordSaleTenderInput[];
}

export interface RecordSaleResult {
  readonly sale: SaleView;
  readonly replayed: boolean;
}

export interface RecordSale {
  execute(context: LocationBoundContext, input: RecordSaleInput): Promise<RecordSaleResult>;
}

interface ParsedLine {
  readonly variantId: ProductVariantId;
  readonly quantityMinor: bigint;
  readonly unit: ReturnType<typeof parseUnitCode>;
  readonly expectedPriceVersion: number;
  readonly discount: LineDiscount;
}

interface ParsedTender {
  readonly method: TenderMethod;
  readonly amountMinor: bigint;
  readonly reference?: string;
  readonly cashReceivedMinor?: bigint;
}

interface StoredSalePointer {
  readonly saleId: string;
}

const salePointerCodec = {
  encode(value: StoredSalePointer): JsonValue {
    return { saleId: value.saleId };
  },
  decode(stored: JsonValue): StoredSalePointer {
    return { saleId: textAt(objectAt(stored, "sale result"), "saleId") };
  },
};

export interface RecordSaleDependencies extends LedgerPostingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly units: UnitReferenceRepository;
  readonly sales: SaleRepository;
  readonly receiptNumbers: SaleReceiptNumberIssuer;
  readonly inventory: SalesInventoryPort;
  readonly tax: SaleTaxSnapshotResolver;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export function createRecordSale(dependencies: RecordSaleDependencies): RecordSale {
  const createPermission = salesPermissions.permissions["sales:create"];
  const discountPermission = salesPermissions.permissions["sales:discount"];
  const posting = createLedgerPostingService(dependencies);
  return {
    async execute(locationContext, input) {
      const actor = requireUserActor(locationContext, createPermission);
      const context = requireLocationBound(locationContext);
      const saleId = parseOrInvalid(() => parseSaleId(input.saleId), ["saleId"]);
      const key = requireIdempotencyKey(input.idempotencyKey);
      if ((key as string) !== (saleId as string)) {
        throw new ValidationError("Idempotency-Key must equal saleId", [
          { path: ["idempotencyKey"], message: "must equal saleId" },
        ]);
      }
      const deviceReportedAt = parseDeviceReportedAt(input.deviceReportedAt);
      const lines = parseLines(input.lines, context.currency);
      const tenders = parseTenders(input.tenders, context.currency);
      if (
        lines.some((line) => line.discount.kind !== "NONE") &&
        !hasPermission(context.permissions, discountPermission)
      ) {
        throw new PermissionDeniedError();
      }
      return dependencies.unitOfWork.run(async (scope) => {
        const command = canonicalCommandEncoding({
          operation: RECORD_SALE_OPERATION,
          commandSchemaVersion: 1,
          command: {
            locationId: context.locationId,
            saleId,
            ...(deviceReportedAt === undefined ? {} : { deviceReportedAt }),
            lines: lines.map(lineCommand),
            tenders: tenders.map(tenderCommand),
          },
        });
        const fingerprint = await dependencies.hasher.fingerprint(command);
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "sale",
          codec: salePointerCodec,
          plan: () =>
            Promise.resolve({
              result: { saleId },
              resourceId: saleId,
              apply: () =>
                recordInTransaction(
                  dependencies,
                  posting,
                  scope,
                  context,
                  saleId,
                  lines,
                  tenders,
                  deviceReportedAt,
                  key,
                  discountPermission,
                ),
            }),
        });
        const storedId = parseOrInvalid(() => parseSaleId(outcome.result.saleId), ["saleId"]);
        const sale = await dependencies.sales.findById(scope, context.businessId, storedId);
        if (sale === undefined || sale.locationId !== context.locationId) throw new NotFoundError("Sale not found");
        const includeCost = hasPermission(context.permissions, inventoryPermissions.permissions["inventory:cost-read"]);
        return { sale: presentSale(sale, includeCost), replayed: outcome.replayed };
      });
    },
  };
}

async function recordInTransaction(
  dependencies: RecordSaleDependencies,
  posting: ReturnType<typeof createLedgerPostingService>,
  scope: TransactionScope,
  context: LocationBoundContext,
  saleId: SaleId,
  lines: readonly ParsedLine[],
  tenders: readonly ParsedTender[],
  deviceReportedAt: Date | undefined,
  key: IdempotencyKey,
  discountPermission: (typeof salesPermissions.permissions)["sales:discount"],
): Promise<void> {
  const locked = await dependencies.products.lockVariantsForShare(
    scope,
    context.businessId,
    new Set(lines.map((line) => line.variantId)),
  );
  const membership = await requireActingMembership(
    scope,
    dependencies.memberships,
    context,
    salesPermissions.permissions["sales:create"],
  );
  if (
    lines.some((line) => line.discount.kind !== "NONE") &&
    !hasPermission(permissionsForRole(membership.role), discountPermission)
  ) {
    throw new PermissionDeniedError();
  }
  const built = await buildLines(dependencies, scope, context, lines, locked);
  const trackedIds = [...new Set(built.filter((line) => line.tracked).map((line) => line.variantId))];
  const positions = await dependencies.inventory.lockForSale(scope, context.businessId, context.locationId, trackedIds);
  const stockPlan = planSaleStock(
    built.flatMap((line) =>
      line.tracked && line.movementId !== undefined
        ? [
            {
              lineNumber: line.lineNumber,
              variantId: line.variantId,
              quantityMinor: line.quantity.amountMinor,
              movementId: line.movementId,
            },
          ]
        : [],
    ),
    new Map(positions.map((position) => [position.variantId, position])),
  );
  if (!stockPlan.ok) {
    throw new InsufficientStockError(
      undefined,
      stockPlan.shortages.map((shortage) => ({
        variantId: shortage.variantId,
        availableQuantityMinor: shortage.availableQuantityMinor.toString(),
      })),
    );
  }
  const priced = applyCosts(built, stockPlan.effects, context.currency);
  const total = Money.sum(
    context.currency,
    priced.map((line) => line.total),
  );
  const tenderTotal = Money.sum(
    context.currency,
    tenders.map((tender) => Money.ofMinor(tender.amountMinor, context.currency)),
  );
  if (!tenderTotal.equals(total)) throw new TenderTotalMismatchError(total.toMinorUnitsString());
  const occurredAt = dependencies.clock.now();
  const recordedAt = dependencies.clock.now();
  const journalEntryId = dependencies.ids.newId("JournalEntry");
  let sale;
  try {
    const created = createSale({
      businessId: context.businessId,
      id: saleId,
      locationId: context.locationId,
      receiptNumber: await dependencies.receiptNumbers.issue(scope, context.businessId),
      currency: context.currency,
      lines: priced,
      tenders: tenders.map((tender, index) => ({
        tenderNumber: index + 1,
        method: tender.method,
        amount: Money.ofMinor(tender.amountMinor, context.currency),
        ...(tender.reference === undefined ? {} : { reference: tender.reference }),
        ...(tender.cashReceivedMinor === undefined
          ? {}
          : { cashReceived: Money.ofMinor(tender.cashReceivedMinor, context.currency) }),
      })),
      stockEffects: stockPlan.effects,
      recordedByMembershipId: membership.id,
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      sourceChannel: context.sourceChannel,
      correlationId: context.correlationId,
      occurredAt,
      businessDate: BusinessDate.fromInstant(occurredAt, context.timeZone),
      recordedAt,
      ...(deviceReportedAt === undefined ? {} : { deviceReportedAt }),
    });
    sale = withOriginalJournal(created, journalEntryId);
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.field === "tenders" || error.field === "cashReceived" || error.field === "reference")
    ) {
      if (error.field === "tenders") throw new TenderTotalMismatchError(total.toMinorUnitsString());
      throw new ValidationError(error.message, [{ path: [error.field], message: error.message }]);
    }
    throw error instanceof DomainError || error instanceof KernelError ? toApplicationError(error) : error;
  }
  await dependencies.sales.insert(scope, sale);
  const posted = await posting.post(scope, context, {
    entryId: journalEntryId,
    plan: salePostedPlan(sale),
    source: { kind: "sale", id: sale.id },
    postingRule: SALE_POSTED_RULE,
    postingRuleVersion: SALE_POSTED_VERSION,
    description: `Sale ${sale.receiptNumber}`,
    occurredAt: sale.occurredAt,
  });
  await dependencies.inventory.applySalePlan(scope, {
    businessId: context.businessId,
    locationId: context.locationId,
    currency: context.currency,
    saleId: sale.id,
    journalEntryId: posted.entry.id,
    recording: {
      actorMembershipId: sale.recordedByMembershipId,
      ...(sale.deviceId === undefined ? {} : { deviceId: sale.deviceId }),
      sourceChannel: sale.sourceChannel,
      correlationId: sale.correlationId,
      occurredAt: sale.occurredAt,
      businessDate: sale.businessDate,
      recordedAt: sale.recordedAt,
    },
    effects: sale.stockEffects,
  });
  await dependencies.audit.recordBusinessEvent(scope, saleRecorded, {
    ...businessAuditEnvelope(context, key),
    locationId: context.locationId,
    entityId: sale.id,
    payload: {
      receiptNumber: sale.receiptNumber,
      lineCount: sale.lines.length,
      tenderCount: sale.tenders.length,
      totalMinor: sale.total.toMinorUnitsString(),
      discountTotalMinor: sale.discountTotal.toMinorUnitsString(),
      taxTotalMinor: sale.taxTotal.toMinorUnitsString(),
      costStatus: sale.costStatus,
      journalEntryId: posted.entry.id,
    },
  });
}

async function buildLines(
  dependencies: RecordSaleDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  lines: readonly ParsedLine[],
  locked: ReadonlyMap<ProductVariantId, ProductVariant>,
): Promise<SaleLine[]> {
  const archived: string[] = [];
  const unpriced: string[] = [];
  const changed: PriceChangeDetail[] = [];
  const prepared: {
    line: ParsedLine;
    variant: ProductVariant;
    scale: number;
    name: ProductName;
    sku?: Sku;
    index: number;
  }[] = [];
  for (const [index, line] of lines.entries()) {
    const variant = locked.get(line.variantId);
    if (variant === undefined || variant.businessId !== context.businessId) throw new NotFoundError(PRODUCT_NOT_FOUND);
    if (variant.stockUnit !== line.unit) {
      throw new ValidationError("quantity unit must be the variant stock unit", [
        { path: ["lines", index, "unit"], message: "stock unit required" },
      ]);
    }
    const unit = await dependencies.units.findByCode(scope, variant.stockUnit);
    if (unit === undefined) {
      throw new ValidationError("unknown stock unit", [{ path: ["lines", index, "unit"], message: "unknown" }]);
    }
    const product = await dependencies.products.findById(scope, context.businessId, variant.productId);
    if (product === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
    if (variant.status === "ARCHIVED") archived.push(variant.id);
    if (variant.sellingPrice === undefined || variant.priceVersion < 1) unpriced.push(variant.id);
    else if (variant.priceVersion !== line.expectedPriceVersion) {
      changed.push({
        variantId: variant.id,
        currentPriceMinor: variant.sellingPrice.toMinorUnitsString(),
        currentPriceVersion: variant.priceVersion,
      });
    }
    prepared.push({
      line,
      variant,
      scale: unit.scale,
      name: product.product.name,
      ...(variant.sku === undefined ? {} : { sku: variant.sku }),
      index,
    });
  }
  if (archived.length > 0) throw new ProductArchivedError(archived);
  if (unpriced.length > 0) throw new PriceNotSetError(unpriced);
  if (changed.length > 0) throw new PriceChangedError(changed);
  return prepared.map((row) => {
    const price = row.variant.sellingPrice;
    if (price === undefined) throw new PriceNotSetError([row.variant.id]);
    try {
      const gross = lineGross(price, row.line.quantityMinor, row.scale);
      const net = gross.subtract(lineDiscountAmount(gross, row.line.discount));
      return buildSaleLine(
        {
          lineNumber: row.index + 1,
          variantId: row.line.variantId,
          productName: row.name,
          ...(row.sku === undefined ? {} : { sku: row.sku.value }),
          tracked: row.variant.trackInventory,
          quantity: Quantity.ofMinor(row.line.quantityMinor, row.line.unit),
          unitScale: row.scale,
          unitPrice: price,
          priceVersion: row.variant.priceVersion,
          discount: row.line.discount,
          tax: dependencies.tax.resolve(net),
          costStatus: row.variant.trackInventory ? "UNVALUED" : "NOT_APPLICABLE",
          ...(row.variant.trackInventory ? { movementId: dependencies.ids.newId("InventoryMovement") } : {}),
        },
        context.currency,
      );
    } catch (error) {
      if (error instanceof DomainError && error.field === "discount") throw new DiscountExceedsLineError(row.index + 1);
      throw error instanceof DomainError || error instanceof KernelError ? toApplicationError(error) : error;
    }
  });
}

function applyCosts(
  lines: readonly SaleLine[],
  effects: readonly PlannedSaleStockEffect[],
  currency: LocationBoundContext["currency"],
): SaleLine[] {
  const byLine = new Map(effects.map((effect) => [effect.lineNumber, effect]));
  return lines.map((line) => {
    const effect = byLine.get(line.lineNumber);
    if (effect === undefined) return line;
    return buildSaleLine(
      {
        lineNumber: line.lineNumber,
        variantId: line.variantId,
        productName: line.productName,
        ...(line.sku === undefined ? {} : { sku: line.sku }),
        tracked: true,
        quantity: line.quantity,
        unitScale: line.unitScale,
        unitPrice: line.unitPrice,
        priceVersion: line.priceVersion,
        discount: discountOf(line),
        tax: line.tax,
        costStatus: effect.costStatus,
        ...(effect.costMinor === undefined ? {} : { cost: Money.ofMinor(effect.costMinor, currency) }),
        valuationVersionRead: effect.valuationVersionRead,
        movementId: effect.movementId,
      },
      currency,
    );
  });
}

function discountOf(line: SaleLine): LineDiscount {
  if (line.discountKind === "NONE") return { kind: "NONE" };
  if (line.discountKind === "FIXED") return { kind: "FIXED", amount: line.discountAmount };
  return { kind: "BASIS_POINTS", basisPoints: Number(line.discountValue) };
}

function parseDeviceReportedAt(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError("deviceReportedAt must be an instant", [
      { path: ["deviceReportedAt"], message: "invalid" },
    ]);
  }
  return parsed;
}

function parseLines(lines: readonly RecordSaleLineInput[], currency: LocationBoundContext["currency"]): ParsedLine[] {
  if (lines.length < 1 || lines.length > 200) {
    throw new ValidationError("a sale has 1 to 200 lines", [{ path: ["lines"], message: "out of range" }]);
  }
  return lines.map((line, index) => {
    const path = ["lines", index] as const;
    const variantId = parseOrInvalid(() => parseProductVariantId(line.variantId), [...path, "variantId"]);
    const quantityMinor = parseMinor(line.quantityMinor, currency, [...path, "quantityMinor"]);
    if (quantityMinor <= 0n) {
      throw new ValidationError("quantity must be positive", [
        { path: [...path, "quantityMinor"], message: "must be > 0" },
      ]);
    }
    const unit = parseOrInvalid(() => parseUnitCode(line.unit), [...path, "unit"]);
    if (!Number.isSafeInteger(line.expectedPriceVersion) || line.expectedPriceVersion < 0) {
      throw new ValidationError("expectedPriceVersion is invalid", [
        { path: [...path, "expectedPriceVersion"], message: "invalid" },
      ]);
    }
    return {
      variantId,
      quantityMinor,
      unit,
      expectedPriceVersion: line.expectedPriceVersion,
      discount: parseDiscount(line.discount, currency, [...path, "discount"]),
    };
  });
}

function parseTenders(
  tenders: readonly RecordSaleTenderInput[],
  currency: LocationBoundContext["currency"],
): ParsedTender[] {
  if (tenders.length < 1 || tenders.length > 10) {
    throw new ValidationError("a sale has 1 to 10 tenders", [{ path: ["tenders"], message: "out of range" }]);
  }
  return tenders.map((tender, index) => {
    const path = ["tenders", index] as const;
    if (!(TENDER_METHODS as readonly string[]).includes(tender.method)) {
      throw new ValidationError("unknown tender method", [{ path: [...path, "method"], message: "unknown" }]);
    }
    const amountMinor = parseMinor(tender.amountMinor, currency, [...path, "amountMinor"]);
    if (amountMinor <= 0n) {
      throw new ValidationError("tender amount must be positive", [
        { path: [...path, "amountMinor"], message: "must be > 0" },
      ]);
    }
    return {
      method: tender.method as TenderMethod,
      amountMinor,
      ...(tender.reference === undefined ? {} : { reference: tender.reference }),
      ...(tender.cashReceivedMinor === undefined
        ? {}
        : { cashReceivedMinor: parseMinor(tender.cashReceivedMinor, currency, [...path, "cashReceivedMinor"]) }),
    };
  });
}

function parseDiscount(
  discount: RecordSaleLineInput["discount"],
  currency: LocationBoundContext["currency"],
  path: readonly (string | number)[],
): LineDiscount {
  if (discount === undefined || discount.kind === "NONE") return { kind: "NONE" };
  if (discount.kind === "FIXED") {
    return {
      kind: "FIXED",
      amount: Money.ofMinor(parseMinor(discount.amountMinor, currency, [...path, "amountMinor"]), currency),
    };
  }
  return { kind: "BASIS_POINTS", basisPoints: discount.basisPoints };
}

function parseMinor(
  value: string,
  currency: LocationBoundContext["currency"],
  path: readonly (string | number)[],
): bigint {
  try {
    return Money.fromMinorUnitsString(value, currency).amountMinor;
  } catch (error) {
    throw invalidAt(error, path);
  }
}

function parseOrInvalid<T>(parse: () => T, path: readonly (string | number)[]): T {
  try {
    return parse();
  } catch (error) {
    throw invalidAt(error, path);
  }
}

function invalidAt(error: unknown, path: readonly (string | number)[]): ValidationError {
  const message = error instanceof Error ? error.message : "invalid";
  return new ValidationError(message, [{ path, message }]);
}

function lineCommand(line: ParsedLine): CommandValue {
  return {
    variantId: line.variantId,
    quantityMinor: line.quantityMinor,
    unit: line.unit,
    expectedPriceVersion: line.expectedPriceVersion,
    discountKind: line.discount.kind,
    ...(line.discount.kind === "FIXED" ? { discountAmountMinor: line.discount.amount.amountMinor } : {}),
    ...(line.discount.kind === "BASIS_POINTS" ? { basisPoints: line.discount.basisPoints } : {}),
  };
}

function tenderCommand(tender: ParsedTender): CommandValue {
  return {
    method: tender.method,
    amountMinor: tender.amountMinor,
    ...(tender.reference === undefined ? {} : { reference: tender.reference }),
    ...(tender.cashReceivedMinor === undefined ? {} : { cashReceivedMinor: tender.cashReceivedMinor }),
  };
}
