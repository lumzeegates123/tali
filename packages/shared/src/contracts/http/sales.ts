import { z } from "zod";
import { CurrencyCodeWireSchema, MinorUnitsStringSchema, MoneyWireSchema } from "./money.js";
import { QuantityMinorStringSchema, QuantityWireSchema, UnitCodeWireSchema } from "./quantity.js";

/**
 * Build 3 sales wire contracts (ADR-011, plan 005 Slice 6). Every object is
 * strict: unknown fields are rejected on input and can never appear on output.
 * Length bounds are transport limits only; prices, discounts, tenders, stock
 * and permissions are decided server-side by the application.
 *
 * A request never names a location, a price, a total, a tax, a cost, a receipt
 * number, a status, a device or a channel: the sale is recorded at the
 * business's default location from the current server-side price. Money and
 * quantities are base-10 strings, never JSON numbers. Responses never carry
 * the business ID, the recording membership, the device, the correlation ID,
 * the source channel, the journal entry or movement IDs, or margin.
 */

const IdWireSchema = z.uuid();
const InstantWireSchema = z.iso.datetime();
const BusinessDateWireSchema = z.iso.date();
const nextCursor = z.string().min(1).max(256).nullable();
/** A body ID is a claim: a malformed or foreign ID is answered with NOT_FOUND server-side. */
const IdClaimWireSchema = z.string().max(64);
const PersistedVersionWireSchema = z.number().int().min(1).max(2_147_483_647);
const MAX_SALE_LINES = 200;
const MAX_SALE_TENDERS = 10;
const MAX_DETAIL_ITEMS = 200;
const MAX_BASIS_POINTS = 9999;
const QUANTITY_MINOR_MAX = 10n ** 15n;

/** A positive quantity in the unit's minor units: canonical, at most 10^15. */
const PositiveQuantityMinorWireSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, "must be a positive canonical base-10 integer string of minor units")
  .refine((value) => !/^[1-9][0-9]{0,15}$/.test(value) || BigInt(value) <= QUANTITY_MINOR_MAX, {
    message: "must be at most 10^15",
  });
const BasisPointsWireSchema = z.number().int().min(1).max(MAX_BASIS_POINTS);

export const TenderMethodWireSchema = z.enum(["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"]);
export const TenderVerificationStatusWireSchema = z.enum(["NOT_APPLICABLE", "NOT_VERIFIED"]);
export const SaleStatusWireSchema = z.enum(["POSTED", "REVERSED"]);
export const SaleCostStatusWireSchema = z.enum(["VALUED", "PARTIAL", "UNVALUED", "NOT_APPLICABLE"]);
export const SaleLineCostStatusWireSchema = z.enum(["VALUED", "UNVALUED", "NOT_APPLICABLE"]);
export const SaleTaxKindWireSchema = z.enum(["NONE", "STANDARD", "ZERO_RATED", "EXEMPT"]);

// ---- Paths ---------------------------------------------------------------

export const SalePathSchema = z.strictObject({ businessId: z.string(), saleId: z.string() });

// ---- Requests ------------------------------------------------------------

/** A line discount: a fixed amount or basis points (1 to 9999). "No discount" is the absence of the field. */
export const SaleDiscountRequestWireSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("FIXED"), amount: MoneyWireSchema }),
  z.strictObject({ kind: z.literal("BASIS_POINTS"), basisPoints: BasisPointsWireSchema }),
]);
export type SaleDiscountRequestWire = z.infer<typeof SaleDiscountRequestWireSchema>;

/** One line: the variant, a positive quantity in its stock unit and the price version the cashier saw. */
export const SaleLineRequestWireSchema = z.strictObject({
  variantId: IdClaimWireSchema,
  quantity: z.strictObject({ quantityMinor: PositiveQuantityMinorWireSchema, unit: UnitCodeWireSchema }),
  expectedPriceVersion: PersistedVersionWireSchema,
  discount: SaleDiscountRequestWireSchema.optional(),
});
export type SaleLineRequestWire = z.infer<typeof SaleLineRequestWireSchema>;

/** One tender. `cashReceived` is for CASH only; the server computes any change. */
export const SaleTenderRequestWireSchema = z.strictObject({
  method: TenderMethodWireSchema,
  amount: MoneyWireSchema,
  reference: z.string().max(256).optional(),
  cashReceived: MoneyWireSchema.optional(),
});
export type SaleTenderRequestWire = z.infer<typeof SaleTenderRequestWireSchema>;

/**
 * `POST .../sales` (`sales:create`; requires `Idempotency-Key`, which must
 * equal `saleId`). `deviceReportedAt` is evidence only, never the sale time.
 */
export const RecordSaleRequestSchema = z.strictObject({
  saleId: IdClaimWireSchema,
  deviceReportedAt: InstantWireSchema.optional(),
  lines: z.array(SaleLineRequestWireSchema).min(1).max(MAX_SALE_LINES),
  tenders: z.array(SaleTenderRequestWireSchema).min(1).max(MAX_SALE_TENDERS),
});
export type RecordSaleRequest = z.infer<typeof RecordSaleRequestSchema>;

/**
 * `POST .../sales/:saleId/reversal` (`sales:reverse`; requires `Idempotency-Key`).
 * The server requires `tenderUnwoundConfirmed` to be true and bounds the reason.
 */
export const ReverseSaleRequestSchema = z.strictObject({
  reason: z.string().max(2000).regex(/\S/, "a reversal reason is required"),
  tenderUnwoundConfirmed: z.boolean(),
});
export type ReverseSaleRequest = z.infer<typeof ReverseSaleRequestSchema>;

// ---- Responses -------------------------------------------------------------

export const SaleDiscountWireSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("NONE") }),
  z.strictObject({ kind: z.literal("FIXED"), amount: MoneyWireSchema }),
  z.strictObject({ kind: z.literal("BASIS_POINTS"), basisPoints: BasisPointsWireSchema }),
]);
export type SaleDiscountWire = z.infer<typeof SaleDiscountWireSchema>;

/** `costStatus` and `cost` exist only with `inventory:cost-read`; `cost` is null when the line has no known cost. */
export const SaleLineResponseSchema = z
  .strictObject({
    lineNumber: z.number().int().min(1).max(MAX_SALE_LINES),
    variantId: IdWireSchema,
    productName: z.string(),
    sku: z.string().nullable(),
    tracked: z.boolean(),
    quantity: QuantityWireSchema,
    unitScale: z.number().int().min(0).max(3),
    unitPrice: MoneyWireSchema,
    priceVersion: PersistedVersionWireSchema,
    gross: MoneyWireSchema,
    discount: SaleDiscountWireSchema,
    discountAmount: MoneyWireSchema,
    net: MoneyWireSchema,
    taxKind: SaleTaxKindWireSchema,
    tax: MoneyWireSchema,
    total: MoneyWireSchema,
    costStatus: SaleLineCostStatusWireSchema.optional(),
    cost: MoneyWireSchema.nullable().optional(),
  })
  .refine((line) => (line.costStatus === undefined) === (line.cost === undefined), {
    message: "costStatus and cost appear together",
  });
export type SaleLineResponse = z.infer<typeof SaleLineResponseSchema>;

export const SaleTenderResponseSchema = z.strictObject({
  tenderNumber: z.number().int().min(1).max(MAX_SALE_TENDERS),
  method: TenderMethodWireSchema,
  amount: MoneyWireSchema,
  reference: z.string().nullable(),
  verificationStatus: TenderVerificationStatusWireSchema,
  cashReceived: MoneyWireSchema.nullable(),
  changeGiven: MoneyWireSchema.nullable(),
});
export type SaleTenderResponse = z.infer<typeof SaleTenderResponseSchema>;

type Money = z.infer<typeof MoneyWireSchema>;

function moneyOf(sale: {
  readonly grossTotal: Money;
  readonly discountTotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly cogsTotal?: Money | undefined;
  readonly lines: readonly SaleLineResponse[];
  readonly tenders: readonly SaleTenderResponse[];
}): Money[] {
  const amounts: (Money | null | undefined)[] = [sale.grossTotal, sale.discountTotal, sale.taxTotal, sale.total];
  amounts.push(sale.cogsTotal);
  for (const line of sale.lines) {
    amounts.push(line.unitPrice, line.gross, line.discountAmount, line.net, line.tax, line.total, line.cost);
    if (line.discount.kind === "FIXED") amounts.push(line.discount.amount);
  }
  for (const tender of sale.tenders) amounts.push(tender.amount, tender.cashReceived, tender.changeGiven);
  return amounts.filter((amount): amount is Money => amount !== undefined && amount !== null);
}

/**
 * A sale as recorded. `costStatus` and `cogsTotal` (and every line's cost)
 * exist only with `inventory:cost-read`; they are absent, not null, otherwise.
 * `reversalTenderUnwoundConfirmed` is true on a REVERSED sale and null before.
 */
export const SaleResponseSchema = z
  .strictObject({
    saleId: IdWireSchema,
    locationId: IdWireSchema,
    receiptNumber: z.string().min(1).max(64),
    status: SaleStatusWireSchema,
    currency: CurrencyCodeWireSchema,
    grossTotal: MoneyWireSchema,
    discountTotal: MoneyWireSchema,
    taxTotal: MoneyWireSchema,
    total: MoneyWireSchema,
    costStatus: SaleCostStatusWireSchema.optional(),
    cogsTotal: MoneyWireSchema.optional(),
    occurredAt: InstantWireSchema,
    businessDate: BusinessDateWireSchema,
    recordedAt: InstantWireSchema,
    deviceReportedAt: InstantWireSchema.nullable(),
    reversedAt: InstantWireSchema.nullable(),
    reversalTenderUnwoundConfirmed: z.literal(true).nullable(),
    lines: z.array(SaleLineResponseSchema).min(1).max(MAX_SALE_LINES),
    tenders: z.array(SaleTenderResponseSchema).min(1).max(MAX_SALE_TENDERS),
  })
  .refine((sale) => (sale.costStatus === undefined) === (sale.cogsTotal === undefined), {
    message: "costStatus and cogsTotal appear together",
  })
  .refine((sale) => sale.lines.every((line) => (line.costStatus === undefined) === (sale.costStatus === undefined)), {
    message: "the sale and its lines show cost together",
  })
  .refine((sale) => moneyOf(sale).every((money) => money.currency === sale.currency), {
    message: "every amount is in the sale currency",
  })
  .refine((sale) => (sale.status === "REVERSED") === (sale.reversedAt !== null), {
    message: "reversedAt is set exactly on a REVERSED sale",
  });
export type SaleResponse = z.infer<typeof SaleResponseSchema>;

/** `GET .../sales`: ascending by sale ID (keyset cursor); a CASHIER sees only the sales they recorded. */
export const SalesResponseSchema = z.strictObject({ items: z.array(SaleResponseSchema), nextCursor });
export type SalesResponse = z.infer<typeof SalesResponseSchema>;

// ---- Errors --------------------------------------------------------------

const ascendingUnique = (ids: readonly string[]) =>
  ids.every((id, index) => index === 0 || (ids[index - 1] ?? "") < id);
const variantIdList = z
  .array(IdWireSchema)
  .min(1)
  .max(MAX_DETAIL_ITEMS)
  .refine(ascendingUnique, { message: "variantIds are unique and ascending" });
const NonNegativeMinorWireSchema = MinorUnitsStringSchema.refine((value) => !value.startsWith("-"), {
  message: "must not be negative",
});

/** PRICE_NOT_SET: the variants of the sale that have no selling price. */
export const PriceNotSetDetailsSchema = z.strictObject({ variantIds: variantIdList });
export type PriceNotSetDetails = z.infer<typeof PriceNotSetDetailsSchema>;

/** PRICE_CHANGED: the current price and version of every line whose expected version is stale. */
export const PriceChangedDetailsSchema = z.strictObject({
  changes: z
    .array(
      z.strictObject({
        variantId: IdWireSchema,
        currentPriceMinor: NonNegativeMinorWireSchema,
        currentPriceVersion: PersistedVersionWireSchema,
      }),
    )
    .min(1)
    .max(MAX_DETAIL_ITEMS)
    .refine((changes) => ascendingUnique(changes.map((change) => change.variantId)), {
      message: "changes are unique and ascending by variantId",
    }),
});
export type PriceChangedDetails = z.infer<typeof PriceChangedDetailsSchema>;

/** PRODUCT_ARCHIVED: the archived variants of the sale. */
export const ProductArchivedDetailsSchema = z.strictObject({ variantIds: variantIdList });
export type ProductArchivedDetails = z.infer<typeof ProductArchivedDetailsSchema>;

/** INSUFFICIENT_STOCK on a sale: what is available of each short variant, in its stock unit. */
export const InsufficientStockDetailsSchema = z.strictObject({
  shortages: z
    .array(z.strictObject({ variantId: IdWireSchema, availableQuantityMinor: QuantityMinorStringSchema }))
    .min(1)
    .max(MAX_DETAIL_ITEMS)
    .refine((shortages) => ascendingUnique(shortages.map((shortage) => shortage.variantId)), {
      message: "shortages are unique and ascending by variantId",
    }),
});
export type InsufficientStockDetails = z.infer<typeof InsufficientStockDetailsSchema>;

/** DISCOUNT_EXCEEDS_LINE: the first line whose discount is not below its gross. */
export const DiscountExceedsLineDetailsSchema = z.strictObject({
  lineNumber: z.number().int().min(1).max(MAX_SALE_LINES),
});
export type DiscountExceedsLineDetails = z.infer<typeof DiscountExceedsLineDetailsSchema>;

/** TENDER_TOTAL_MISMATCH: the total the server computed, in minor units of the business currency. */
export const TenderTotalMismatchDetailsSchema = z.strictObject({ serverTotalMinor: NonNegativeMinorWireSchema });
export type TenderTotalMismatchDetails = z.infer<typeof TenderTotalMismatchDetailsSchema>;

const envelope = <C extends string, D extends z.ZodType>(code: C, details: D) =>
  z.strictObject({
    error: z.strictObject({ code: z.literal(code), message: z.string().min(1).max(1000), details }),
  });

export const PriceNotSetErrorEnvelopeSchema = envelope("PRICE_NOT_SET", PriceNotSetDetailsSchema);
export const PriceChangedErrorEnvelopeSchema = envelope("PRICE_CHANGED", PriceChangedDetailsSchema);
export const ProductArchivedErrorEnvelopeSchema = envelope("PRODUCT_ARCHIVED", ProductArchivedDetailsSchema);
export const InsufficientStockErrorEnvelopeSchema = envelope("INSUFFICIENT_STOCK", InsufficientStockDetailsSchema);
export const DiscountExceedsLineErrorEnvelopeSchema = envelope(
  "DISCOUNT_EXCEEDS_LINE",
  DiscountExceedsLineDetailsSchema,
);
export const TenderTotalMismatchErrorEnvelopeSchema = envelope(
  "TENDER_TOTAL_MISMATCH",
  TenderTotalMismatchDetailsSchema,
);
