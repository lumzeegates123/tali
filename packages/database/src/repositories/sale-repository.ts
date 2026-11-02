import { ConflictError, type SaleRepository } from "@tali/application";
import type {
  CurrencyCode,
  LineDiscount,
  PlannedSaleStockEffect,
  Sale,
  SaleLine,
  SaleLineCostStatus,
  SaleTaxSnapshot,
  TenderMethod,
} from "@tali/domain";
import {
  Money,
  Quantity,
  SALE_LINE_COST_STATUSES,
  SALE_TAX_KINDS,
  SALE_TAX_PRICING_MODES,
  SALE_TAX_ROUNDING_MODES,
  TENDER_METHODS,
  buildSaleLine,
  createSale,
  parseBusinessId,
  parseCurrencyCode,
  parseDeviceId,
  parseInventoryMovementId,
  parseJournalEntryId,
  parseLocationId,
  parseMembershipId,
  parseProductVariantId,
  parseSaleId,
  parseUnitCode,
  parseValuationStatus,
  reverseSale,
  withOriginalJournal,
} from "@tali/domain";
import type {
  InventoryMovement as MovementRow,
  InventoryMovementValuation as FactRow,
  Sale as SaleRow,
  SaleLine as SaleLineRow,
  SaleTender as SaleTenderRow,
} from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { fromDateColumn, toDateColumn } from "./inventory-rows.js";
import { keysetArgs, toPage } from "./pagination.js";

export const SALE_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  sales_pkey: "a sale with this identity already exists",
  sales_business_id_id_key: "a sale with this identity already exists",
  sales_business_id_receipt_number_key: "this receipt number is already issued",
});

const SALE_INCLUDE = {
  lines: { orderBy: { lineNumber: "asc" }, include: { movement: { include: { valuation: true } } } },
  tenders: { orderBy: { tenderNumber: "asc" } },
} as const;

type StoredLine = SaleLineRow & { readonly movement: (MovementRow & { readonly valuation: FactRow | null }) | null };
type StoredSale = SaleRow & { readonly lines: readonly StoredLine[]; readonly tenders: readonly SaleTenderRow[] };

class StoredSaleError extends Error {
  constructor(saleId: string, detail: string) {
    super(`stored sale ${saleId} is inconsistent: ${detail}`);
    this.name = "StoredSaleError";
  }
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string,
  fail: (detail: string) => never,
  what: string,
): T {
  if (!(values as readonly string[]).includes(value)) fail(`unknown ${what}`);
  return value as T;
}

function discountOf(line: SaleLineRow, currency: CurrencyCode, fail: (detail: string) => never): LineDiscount {
  switch (line.discountKind) {
    case "NONE":
      return { kind: "NONE" };
    case "FIXED":
      return { kind: "FIXED", amount: Money.ofMinor(line.discountValue, currency) };
    case "BASIS_POINTS":
      return { kind: "BASIS_POINTS", basisPoints: Number(line.discountValue) };
    default:
      return fail(`line ${line.lineNumber} has an unknown discount kind`);
  }
}

function taxOf(line: SaleLineRow, currency: CurrencyCode, fail: (detail: string) => never): SaleTaxSnapshot {
  const taxKind = oneOf(SALE_TAX_KINDS, line.taxKind, fail, "tax kind");
  return {
    ...(line.taxTreatmentId === null ? {} : { taxTreatmentId: line.taxTreatmentId }),
    ...(line.taxName === null ? {} : { taxName: line.taxName }),
    taxKind,
    ...(line.taxRateBps === null ? {} : { taxRateBps: line.taxRateBps }),
    ...(line.taxPricingMode === null
      ? {}
      : { taxPricingMode: oneOf(SALE_TAX_PRICING_MODES, line.taxPricingMode, fail, "tax pricing mode") }),
    ...(line.taxRoundingMode === null
      ? {}
      : { taxRoundingMode: oneOf(SALE_TAX_ROUNDING_MODES, line.taxRoundingMode, fail, "tax rounding mode") }),
    taxableBase: Money.ofMinor(line.taxableBaseMinor, currency),
    tax: Money.ofMinor(line.taxMinor, currency),
  };
}

/** Rebuilds a line through the domain and requires every stored amount to match the rebuilt one. */
function toLine(row: StoredLine, currency: CurrencyCode, fail: (detail: string) => never): SaleLine {
  const costStatus: SaleLineCostStatus = oneOf(SALE_LINE_COST_STATUSES, row.costStatus, fail, "line cost status");
  const line = buildSaleLine(
    {
      lineNumber: row.lineNumber,
      variantId: parseProductVariantId(row.variantId),
      productName: row.productName,
      ...(row.sku === null ? {} : { sku: row.sku }),
      tracked: row.tracked,
      quantity: Quantity.ofMinor(row.quantityMinor, parseUnitCode(row.unit)),
      unitScale: row.unitScale,
      unitPrice: Money.ofMinor(row.unitPriceMinor, currency),
      priceVersion: row.priceVersion,
      discount: discountOf(row, currency, fail),
      tax: taxOf(row, currency, fail),
      costStatus,
      ...(row.costMinor === null ? {} : { cost: Money.ofMinor(row.costMinor, currency) }),
      ...(row.valuationVersionRead === null ? {} : { valuationVersionRead: row.valuationVersionRead }),
      ...(row.movementId === null ? {} : { movementId: parseInventoryMovementId(row.movementId) }),
    },
    currency,
  );
  if (
    line.gross.amountMinor !== row.grossMinor ||
    line.discountValue !== row.discountValue ||
    line.discountAmount.amountMinor !== row.discountMinor ||
    line.net.amountMinor !== row.netMinor ||
    line.taxAmount.amountMinor !== row.taxMinor ||
    line.total.amountMinor !== row.totalMinor
  ) {
    fail(`line ${row.lineNumber} amounts do not match their snapshot`);
  }
  return line;
}

/** The original stock effect of a tracked line, read back from its SALE movement and valuation fact. */
function toEffect(sale: StoredSale, line: StoredLine, fail: (detail: string) => never): PlannedSaleStockEffect {
  const movement = line.movement;
  const fact = movement?.valuation ?? null;
  const at = `line ${line.lineNumber}`;
  if (movement === null || fact === null || line.valuationVersionRead === null) {
    return fail(`${at} has no SALE movement, valuation fact or valuation version`);
  }
  if (
    movement.type !== "SALE" ||
    movement.reversesMovementId !== null ||
    movement.saleId !== sale.id ||
    movement.locationId !== sale.locationId ||
    movement.variantId !== line.variantId ||
    movement.quantityDeltaMinor !== -line.quantityMinor ||
    fact.currency !== sale.currency
  ) {
    fail(`${at} movement does not belong to the line`);
  }
  const valued = line.costStatus === "VALUED";
  const costMinor = line.costMinor ?? 0n;
  const factMatches = valued
    ? fact.costBasis === "WEIGHTED_AVERAGE" &&
      fact.valueDeltaMinor === -costMinor &&
      fact.journalEntryId === sale.journalEntryId &&
      fact.suppliedCostMinor === null
    : line.costStatus === "UNVALUED" &&
      fact.costBasis === "NOT_VALUED" &&
      fact.valueDeltaMinor === 0n &&
      fact.journalEntryId === null &&
      fact.suppliedCostMinor === null;
  if (!factMatches) fail(`${at} valuation fact does not match the line cost`);
  return Object.freeze({
    lineNumber: line.lineNumber,
    movementId: parseInventoryMovementId(movement.id),
    variantId: parseProductVariantId(movement.variantId),
    quantityDeltaMinor: movement.quantityDeltaMinor,
    quantityAfterMinor: movement.balanceAfterMinor,
    balanceVersionRead: movement.balanceVersion - 1,
    nextBalanceVersion: movement.balanceVersion,
    costStatus: valued ? ("VALUED" as const) : ("UNVALUED" as const),
    ...(valued ? { costMinor } : {}),
    valuationVersionRead: line.valuationVersionRead,
    valueDeltaMinor: fact.valueDeltaMinor,
    nextValueMinor: fact.valueAfterMinor,
    nextValuationStatus: parseValuationStatus(fact.statusAfter),
    nextValuationVersion: line.valuationVersionRead + 1,
  });
}

/**
 * Restores a stored sale through the domain constructors and compares every
 * stored total, status and snapshot with the rebuilt aggregate. Any mismatch
 * or malformed row fails closed: a sale is never returned from data the
 * domain would not have produced.
 */
function toSale(row: StoredSale): Sale {
  const fail = (detail: string): never => {
    throw new StoredSaleError(row.id, detail);
  };
  try {
    const currency = parseCurrencyCode(row.currency);
    const money = (minor: bigint) => Money.ofMinor(minor, currency);
    const created = createSale({
      businessId: parseBusinessId(row.businessId),
      id: parseSaleId(row.id),
      locationId: parseLocationId(row.locationId),
      receiptNumber: row.receiptNumber,
      currency,
      lines: row.lines.map((line) => toLine(line, currency, fail)),
      tenders: row.tenders.map((tender) => ({
        tenderNumber: tender.tenderNumber,
        method: oneOf<TenderMethod>(TENDER_METHODS, tender.method, fail, "tender method"),
        amount: money(tender.amountMinor),
        ...(tender.reference === null ? {} : { reference: tender.reference }),
        ...(tender.cashReceivedMinor === null ? {} : { cashReceived: money(tender.cashReceivedMinor) }),
      })),
      stockEffects: row.lines.filter((line) => line.tracked).map((line) => toEffect(row, line, fail)),
      recordedByMembershipId: parseMembershipId(row.recordedByMembershipId),
      ...(row.deviceId === null ? {} : { deviceId: parseDeviceId(row.deviceId) }),
      sourceChannel: row.sourceChannel,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
      businessDate: fromDateColumn(row.businessDate),
      recordedAt: row.recordedAt,
      ...(row.deviceReportedAt === null ? {} : { deviceReportedAt: row.deviceReportedAt }),
    });
    if (
      created.receiptNumber !== row.receiptNumber ||
      created.grossTotal.amountMinor !== row.grossTotalMinor ||
      created.discountTotal.amountMinor !== row.discountTotalMinor ||
      created.taxTotal.amountMinor !== row.taxTotalMinor ||
      created.total.amountMinor !== row.totalMinor ||
      created.costStatus !== row.costStatus ||
      created.cogsTotal.amountMinor !== row.cogsTotalMinor
    ) {
      fail("header totals or cost status do not match the lines");
    }
    created.tenders.forEach((tender, index) => {
      const stored = row.tenders[index];
      if (
        stored === undefined ||
        tender.verificationStatus !== stored.verificationStatus ||
        (tender.changeGiven?.amountMinor ?? null) !== stored.changeGivenMinor
      ) {
        fail(`tender ${index + 1} does not match its snapshot`);
      }
    });
    const posted = withOriginalJournal(created, parseJournalEntryId(row.journalEntryId));
    if (row.status === "POSTED") {
      if (
        row.reversedAt !== null ||
        row.reversedByMembershipId !== null ||
        row.reversalReason !== null ||
        row.reversalJournalEntryId !== null ||
        row.reversalTenderUnwoundConfirmed !== null
      ) {
        fail("a posted sale carries reversal fields");
      }
      return posted;
    }
    if (row.status !== "REVERSED") return fail("unknown status");
    if (
      row.reversedAt === null ||
      row.reversedByMembershipId === null ||
      row.reversalReason === null ||
      row.reversalJournalEntryId === null ||
      row.reversalTenderUnwoundConfirmed !== true
    ) {
      return fail("a reversed sale lacks reversal fields");
    }
    const reversed = reverseSale(posted, {
      reversedAt: row.reversedAt,
      reversedByMembershipId: parseMembershipId(row.reversedByMembershipId),
      reason: row.reversalReason,
      reversalJournalEntryId: parseJournalEntryId(row.reversalJournalEntryId),
      tenderUnwoundConfirmed: true,
    });
    if (reversed.reversalReason !== row.reversalReason) fail("reversal reason is not normalized");
    return reversed;
  } catch (error) {
    if (error instanceof StoredSaleError) throw error;
    throw new StoredSaleError(row.id, error instanceof Error ? error.message : "unreadable row");
  }
}

function headerColumns(sale: Sale) {
  if (sale.status !== "POSTED" || sale.journalEntryId === undefined) {
    throw new Error("a sale is inserted POSTED with its original journal id");
  }
  return {
    businessId: sale.businessId,
    id: sale.id,
    locationId: sale.locationId,
    receiptNumber: sale.receiptNumber,
    status: sale.status,
    currency: sale.currency,
    grossTotalMinor: sale.grossTotal.amountMinor,
    discountTotalMinor: sale.discountTotal.amountMinor,
    taxTotalMinor: sale.taxTotal.amountMinor,
    totalMinor: sale.total.amountMinor,
    costStatus: sale.costStatus,
    cogsTotalMinor: sale.cogsTotal.amountMinor,
    recordedByMembershipId: sale.recordedByMembershipId,
    deviceId: sale.deviceId ?? null,
    sourceChannel: sale.sourceChannel,
    correlationId: sale.correlationId,
    occurredAt: sale.occurredAt,
    businessDate: toDateColumn(sale.businessDate),
    recordedAt: sale.recordedAt,
    deviceReportedAt: sale.deviceReportedAt ?? null,
    journalEntryId: sale.journalEntryId,
  };
}

function lineColumns(sale: Sale, line: SaleLine) {
  return {
    businessId: sale.businessId,
    saleId: sale.id,
    lineNumber: line.lineNumber,
    variantId: line.variantId,
    productName: line.productName,
    sku: line.sku ?? null,
    tracked: line.tracked,
    quantityMinor: line.quantity.amountMinor,
    unit: line.quantity.unit,
    unitScale: line.unitScale,
    unitPriceMinor: line.unitPrice.amountMinor,
    priceVersion: line.priceVersion,
    grossMinor: line.gross.amountMinor,
    discountKind: line.discountKind,
    discountValue: line.discountValue,
    discountMinor: line.discountAmount.amountMinor,
    netMinor: line.net.amountMinor,
    taxTreatmentId: line.tax.taxTreatmentId ?? null,
    taxName: line.tax.taxName ?? null,
    taxKind: line.tax.taxKind,
    taxRateBps: line.tax.taxRateBps ?? null,
    taxPricingMode: line.tax.taxPricingMode ?? null,
    taxRoundingMode: line.tax.taxRoundingMode ?? null,
    taxableBaseMinor: line.tax.taxableBase.amountMinor,
    taxMinor: line.taxAmount.amountMinor,
    totalMinor: line.total.amountMinor,
    costStatus: line.costStatus,
    costMinor: line.cost?.amountMinor ?? null,
    valuationVersionRead: line.valuationVersionRead ?? null,
    movementId: line.movementId ?? null,
  };
}

/**
 * Sales (tenant-owned; ADR-011). Every lookup is by (business_id, id): another
 * business's sale is not found. Header, lines and tenders are written once;
 * the only update is the POSTED to REVERSED transition, guarded by the stored
 * status. Authorization, location checks and every amount are the use case's
 * and the domain's; this adapter persists and restores only.
 */
export function createSaleRepository(): SaleRepository {
  return {
    async insert(scope, sale) {
      const client = transactionClient(scope);
      const header = headerColumns(sale);
      await translatingUniqueViolations(SALE_CONFLICTS, () => client.sale.create({ data: header }));
      await client.saleLine.createMany({ data: sale.lines.map((line) => lineColumns(sale, line)) });
      await client.saleTender.createMany({
        data: sale.tenders.map((tender) => ({
          businessId: sale.businessId,
          saleId: sale.id,
          tenderNumber: tender.tenderNumber,
          method: tender.method,
          amountMinor: tender.amount.amountMinor,
          reference: tender.reference ?? null,
          verificationStatus: tender.verificationStatus,
          cashReceivedMinor: tender.cashReceived?.amountMinor ?? null,
          changeGivenMinor: tender.changeGiven?.amountMinor ?? null,
        })),
      });
    },

    async findById(scope, businessId, saleId) {
      const row = await transactionClient(scope).sale.findUnique({
        where: { businessId_id: { businessId, id: saleId } },
        include: SALE_INCLUDE,
      });
      return row === null ? undefined : toSale(row);
    },

    async findByIdForUpdate(scope, businessId, saleId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM sales WHERE business_id = ${businessId}::uuid AND id = ${saleId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.sale.findUnique({
        where: { businessId_id: { businessId, id: saleId } },
        include: SALE_INCLUDE,
      });
      return row === null ? undefined : toSale(row);
    },

    async markReversed(scope, sale) {
      if (
        sale.status !== "REVERSED" ||
        sale.reversedAt === undefined ||
        sale.reversedByMembershipId === undefined ||
        sale.reversalReason === undefined ||
        sale.reversalJournalEntryId === undefined ||
        sale.reversalTenderUnwoundConfirmed !== true
      ) {
        throw new Error("only a reversed sale with every reversal field is written");
      }
      const { count } = await transactionClient(scope).sale.updateMany({
        where: { businessId: sale.businessId, id: sale.id, status: "POSTED" },
        data: {
          status: sale.status,
          reversedAt: sale.reversedAt,
          reversedByMembershipId: sale.reversedByMembershipId,
          reversalReason: sale.reversalReason,
          reversalJournalEntryId: sale.reversalJournalEntryId,
          reversalTenderUnwoundConfirmed: true,
        },
      });
      if (count !== 1) throw new ConflictError("sale is no longer posted");
    },

    async list(scope, businessId, query) {
      const page = keysetArgs(query.page);
      const rows = await transactionClient(scope).sale.findMany({
        where: {
          businessId,
          locationId: query.locationId,
          ...(query.recordedByMembershipId === undefined
            ? {}
            : { recordedByMembershipId: query.recordedByMembershipId }),
          ...page.where,
        },
        orderBy: page.orderBy,
        take: page.take,
        include: SALE_INCLUDE,
      });
      return toPage(rows, query.page, (row) => row.id, toSale);
    },
  };
}
