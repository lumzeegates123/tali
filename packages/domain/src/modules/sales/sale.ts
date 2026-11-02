import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/currency.js";
import type { Money } from "../../kernel/money.js";
import type { Quantity } from "../../kernel/quantity.js";
import type { BusinessDate } from "../../kernel/time.js";
import { codePointLength, isWellFormedText } from "../../text.js";
import type { BusinessId, MembershipId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { DeviceId } from "../device/index.js";
import type { InventoryMovementId } from "../inventory/index.js";
import type { JournalEntryId } from "../ledger/index.js";
import type { LocationId } from "../location/index.js";
import {
  discountValueOf,
  lineDiscountAmount,
  lineGross,
  priceSaleLine,
  sumMoney,
  type LineDiscount,
} from "./amounts.js";
import type { SaleId } from "./ids.js";
import { parseOnlineReceiptNumber } from "./receipt-number.js";
import {
  aggregateCostStatus,
  type PlannedSaleStockEffect,
  type SaleCostStatus,
  type SaleLineCostStatus,
} from "./stock-plan.js";
import { noTaxSnapshot, type SaleTaxSnapshot } from "./tax.js";
import { createSaleTender, sumTenderAmounts, type SaleTender } from "./tender.js";

function validInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

export const SALE_STATUSES = ["POSTED", "REVERSED"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const MAX_SALE_LINES = 200;
export const SALE_REVERSAL_REASON_MAX_LENGTH = 500;

export interface SaleLine {
  readonly lineNumber: number;
  readonly variantId: ProductVariantId;
  readonly productName: string;
  readonly sku?: string;
  readonly tracked: boolean;
  readonly quantity: Quantity;
  readonly unitScale: number;
  readonly unitPrice: Money;
  readonly priceVersion: number;
  readonly gross: Money;
  readonly discountKind: LineDiscount["kind"];
  readonly discountValue: bigint;
  readonly discountAmount: Money;
  readonly net: Money;
  readonly tax: SaleTaxSnapshot;
  readonly taxAmount: Money;
  readonly total: Money;
  readonly costStatus: SaleLineCostStatus;
  readonly cost?: Money;
  readonly valuationVersionRead?: number;
  readonly movementId?: InventoryMovementId;
}

export interface Sale {
  readonly businessId: BusinessId;
  readonly id: SaleId;
  readonly locationId: LocationId;
  readonly receiptNumber: string;
  readonly status: SaleStatus;
  readonly currency: CurrencyCode;
  readonly lines: readonly SaleLine[];
  readonly tenders: readonly SaleTender[];
  readonly grossTotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly costStatus: SaleCostStatus;
  readonly cogsTotal: Money;
  readonly stockEffects: readonly PlannedSaleStockEffect[];
  readonly recordedByMembershipId: MembershipId;
  readonly deviceId?: DeviceId;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
  readonly recordedAt: Date;
  readonly deviceReportedAt?: Date;
  readonly journalEntryId?: JournalEntryId;
  readonly reversedAt?: Date;
  readonly reversedByMembershipId?: MembershipId;
  readonly reversalReason?: string;
  readonly reversalJournalEntryId?: JournalEntryId;
  readonly reversalTenderUnwoundConfirmed?: true;
}

export interface SaleLineDraft {
  readonly lineNumber: number;
  readonly variantId: ProductVariantId;
  readonly productName: string;
  readonly sku?: string;
  readonly tracked: boolean;
  readonly quantity: Quantity;
  readonly unitScale: number;
  readonly unitPrice: Money;
  readonly priceVersion: number;
  readonly discount: LineDiscount;
  /** When omitted, the line snapshots NONE. */
  readonly tax?: SaleTaxSnapshot;
  readonly costStatus: SaleLineCostStatus;
  readonly cost?: Money;
  readonly valuationVersionRead?: number;
  readonly movementId?: InventoryMovementId;
}

export function parseSaleReversalReason(value: string): string {
  if (typeof value !== "string" || !isWellFormedText(value)) {
    throw new DomainError("INVALID_VALUE", "reversal reason must be well-formed text", "reason");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || codePointLength(trimmed) > SALE_REVERSAL_REASON_MAX_LENGTH) {
    throw new DomainError("INVALID_VALUE", "reversal reason must be 1 to 500 characters", "reason");
  }
  return trimmed;
}

export function buildSaleLine(draft: SaleLineDraft, currency: CurrencyCode): SaleLine {
  if (!Number.isSafeInteger(draft.lineNumber) || draft.lineNumber < 1 || draft.lineNumber > MAX_SALE_LINES) {
    throw new DomainError("INVALID_VALUE", "line number must be from 1 to 200", "lineNumber");
  }
  if (draft.quantity.amountMinor <= 0n) {
    throw new DomainError("INVALID_VALUE", "sale quantity must be positive", "quantity");
  }
  if (draft.unitPrice.currency !== currency || !draft.unitPrice.isPositive()) {
    throw new DomainError("INVALID_VALUE", "unit price must be a positive amount in the sale currency", "unitPrice");
  }
  if (!Number.isSafeInteger(draft.priceVersion) || draft.priceVersion < 1) {
    throw new DomainError("INVALID_VALUE", "price version must be a positive integer", "priceVersion");
  }
  const gross = lineGross(draft.unitPrice, draft.quantity.amountMinor, draft.unitScale);
  const net = gross.subtract(lineDiscountAmount(gross, draft.discount));
  const priced = priceSaleLine(gross, draft.discount, draft.tax ?? noTaxSnapshot(net));
  assertCost(draft, currency);
  return Object.freeze({
    lineNumber: draft.lineNumber,
    variantId: draft.variantId,
    productName: draft.productName,
    ...(draft.sku === undefined ? {} : { sku: draft.sku }),
    tracked: draft.tracked,
    quantity: draft.quantity,
    unitScale: draft.unitScale,
    unitPrice: draft.unitPrice,
    priceVersion: draft.priceVersion,
    gross: priced.gross,
    discountKind: draft.discount.kind,
    discountValue: discountValueOf(draft.discount),
    discountAmount: priced.discountAmount,
    net: priced.net,
    tax: priced.tax,
    taxAmount: priced.taxAmount,
    total: priced.total,
    costStatus: draft.costStatus,
    ...(draft.cost === undefined ? {} : { cost: draft.cost }),
    ...(draft.valuationVersionRead === undefined ? {} : { valuationVersionRead: draft.valuationVersionRead }),
    ...(draft.movementId === undefined ? {} : { movementId: draft.movementId }),
  });
}

function assertCost(draft: SaleLineDraft, currency: CurrencyCode): void {
  if (!draft.tracked) {
    if (draft.costStatus !== "NOT_APPLICABLE" || draft.cost !== undefined || draft.movementId !== undefined) {
      throw new DomainError("INVALID_VALUE", "an untracked line has no cost and no movement", "costStatus");
    }
    return;
  }
  if (draft.movementId === undefined) {
    throw new DomainError("INVALID_VALUE", "a tracked line requires a movement id", "movementId");
  }
  if (draft.costStatus === "VALUED") {
    if (draft.cost === undefined || draft.cost.currency !== currency || draft.cost.isNegative()) {
      throw new DomainError("INVALID_VALUE", "a valued line requires a non-negative cost", "cost");
    }
    return;
  }
  if (draft.costStatus !== "UNVALUED" || draft.cost !== undefined) {
    throw new DomainError("INVALID_VALUE", "an unvalued tracked line has no cost", "costStatus");
  }
}

export interface CreateSaleProps {
  readonly businessId: BusinessId;
  readonly id: SaleId;
  readonly locationId: LocationId;
  readonly receiptNumber: string;
  readonly currency: CurrencyCode;
  readonly lines: readonly SaleLine[];
  readonly tenders: readonly Parameters<typeof createSaleTender>[0][];
  readonly stockEffects: readonly PlannedSaleStockEffect[];
  readonly recordedByMembershipId: MembershipId;
  readonly deviceId?: DeviceId;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
  readonly recordedAt: Date;
  readonly deviceReportedAt?: Date;
}

export function createSale(props: CreateSaleProps): Sale {
  assertLines(props.lines, props.currency);
  const tenders = props.tenders.map((tender, index) => {
    if (tender.tenderNumber !== index + 1) {
      throw new DomainError("INVALID_VALUE", "tender numbers must be 1..N in order", "tenderNumber");
    }
    return createSaleTender(tender);
  });
  if (tenders.length < 1 || tenders.length > 10) {
    throw new DomainError("INVALID_VALUE", "a sale has 1 to 10 tenders", "tenders");
  }
  const grossTotal = sumMoney(
    props.currency,
    props.lines.map((line) => line.gross),
  );
  const discountTotal = sumMoney(
    props.currency,
    props.lines.map((line) => line.discountAmount),
  );
  const taxTotal = sumMoney(
    props.currency,
    props.lines.map((line) => line.taxAmount),
  );
  const total = sumMoney(
    props.currency,
    props.lines.map((line) => line.total),
  );
  if (!total.isPositive() || !sumTenderAmounts(props.currency, tenders).equals(total)) {
    throw new DomainError("INVALID_VALUE", "tender amounts must equal the positive sale total", "tenders");
  }
  assertStockEffects(props.lines, props.stockEffects);
  assertTaxModes(props.lines);
  if (props.sourceChannel.trim().length === 0 || props.correlationId.trim().length === 0) {
    throw new DomainError("INVALID_VALUE", "source channel and correlation id are required", "sourceChannel");
  }
  return Object.freeze({
    businessId: props.businessId,
    id: props.id,
    locationId: props.locationId,
    receiptNumber: parseOnlineReceiptNumber(props.receiptNumber),
    status: "POSTED" as const,
    currency: props.currency,
    lines: Object.freeze([...props.lines]),
    tenders: Object.freeze(tenders),
    grossTotal,
    discountTotal,
    taxTotal,
    total,
    costStatus: aggregateCostStatus(props.lines),
    cogsTotal: sumMoney(
      props.currency,
      props.lines.flatMap((line) => (line.cost === undefined ? [] : [line.cost])),
    ),
    stockEffects: Object.freeze([...props.stockEffects]),
    recordedByMembershipId: props.recordedByMembershipId,
    ...(props.deviceId === undefined ? {} : { deviceId: props.deviceId }),
    sourceChannel: props.sourceChannel,
    correlationId: props.correlationId,
    occurredAt: validInstant(props.occurredAt, "occurredAt"),
    businessDate: props.businessDate,
    recordedAt: validInstant(props.recordedAt, "recordedAt"),
    ...(props.deviceReportedAt === undefined
      ? {}
      : { deviceReportedAt: validInstant(props.deviceReportedAt, "deviceReportedAt") }),
  });
}

function assertLines(lines: readonly SaleLine[], currency: CurrencyCode): void {
  if (lines.length < 1 || lines.length > MAX_SALE_LINES) {
    throw new DomainError("INVALID_VALUE", "a sale has 1 to 200 lines", "lines");
  }
  lines.forEach((line, index) => {
    if (line.lineNumber !== index + 1) {
      throw new DomainError("INVALID_VALUE", "line numbers must be 1..N in request order", "lineNumber");
    }
    if (line.unitPrice.currency !== currency || line.total.currency !== currency) {
      throw new DomainError("INVALID_VALUE", "line currency must match the sale", "currency");
    }
  });
}

function assertStockEffects(lines: readonly SaleLine[], effects: readonly PlannedSaleStockEffect[]): void {
  const tracked = lines.filter((line) => line.tracked);
  if (effects.length !== tracked.length) {
    throw new DomainError("INVALID_VALUE", "each tracked line has one stock effect", "stockEffects");
  }
  tracked.forEach((line, index) => {
    const effect = effects[index];
    if (effect === undefined || effect.lineNumber !== line.lineNumber || effect.movementId !== line.movementId) {
      throw new DomainError("INVALID_VALUE", "stock effects must follow tracked lines", "stockEffects");
    }
  });
}

function assertTaxModes(lines: readonly SaleLine[]): void {
  const modes = new Set(lines.map((line) => line.tax.taxPricingMode).filter((mode) => mode !== undefined));
  if (modes.size > 1) {
    throw new DomainError("INVALID_VALUE", "a sale cannot mix inclusive and exclusive tax", "taxPricingMode");
  }
}

export function withOriginalJournal(sale: Sale, journalEntryId: JournalEntryId): Sale {
  if (sale.status !== "POSTED" || sale.journalEntryId !== undefined) {
    throw new DomainError("INVALID_TRANSITION", "the original journal is set once on a posted sale", "journalEntryId");
  }
  return Object.freeze({ ...sale, journalEntryId });
}

export function reverseSale(
  sale: Sale,
  reversal: {
    readonly reversedAt: Date;
    readonly reversedByMembershipId: MembershipId;
    readonly reason: string;
    readonly reversalJournalEntryId: JournalEntryId;
    readonly tenderUnwoundConfirmed: boolean;
  },
): Sale {
  if (sale.status !== "POSTED" || sale.journalEntryId === undefined) {
    throw new DomainError("INVALID_TRANSITION", "only a posted sale with a journal can be reversed", "status");
  }
  if (!reversal.tenderUnwoundConfirmed) {
    throw new DomainError("INVALID_VALUE", "tender unwind must be confirmed", "tenderUnwoundConfirmed");
  }
  return Object.freeze({
    ...sale,
    status: "REVERSED" as const,
    reversedAt: validInstant(reversal.reversedAt, "reversedAt"),
    reversedByMembershipId: reversal.reversedByMembershipId,
    reversalReason: parseSaleReversalReason(reversal.reason),
    reversalJournalEntryId: reversal.reversalJournalEntryId,
    reversalTenderUnwoundConfirmed: true as const,
  });
}
