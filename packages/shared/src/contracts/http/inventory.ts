import { z } from "zod";
import { PackFactorMinorWireSchema } from "./catalog.js";
import { QuantityWireSchema, UnitCodeWireSchema } from "./quantity.js";
import { PageQuerySchema } from "./tenancy.js";

/**
 * Build 2 inventory and stocktake wire contracts (ADR-008, plan 004 Slices 5
 * and 6). Every object is strict: unknown fields are rejected on input and can
 * never appear on output. Length bounds are transport limits only; the exact
 * rules (trimming, NFC, code-point lengths, known units, the stock unit, unit
 * scale, line counts per variant, reason codes per kind) are enforced
 * server-side by the domain.
 *
 * Quantities are base-10 strings, never JSON numbers. No request names a
 * location: every inventory route works at the business's default location,
 * resolved server-side. Responses never carry the business ID, the recording
 * membership, the device, the correlation ID or storage names.
 */

const IdWireSchema = z.uuid();
const InstantWireSchema = z.iso.datetime();
const BusinessDateWireSchema = z.iso.date();
const nextCursor = z.string().min(1).max(256).nullable();
/** A body ID is a claim: a malformed or foreign ID is answered with NOT_FOUND server-side. */
const IdClaimWireSchema = z.string().max(64);
/** Versions of persisted rows start at 1. */
const PersistedVersionWireSchema = z.number().int().min(1);
/** Version 0 stands for "no row yet" (a threshold, a balance, a stocktake line). */
const NonNegativeVersionWireSchema = z.number().int().min(0);
const NoteWireSchema = z.string().max(2000);
const ReasonNoteWireSchema = z.string().max(2000);
const ReferenceWireSchema = z.string().max(256);
const MAX_DOCUMENT_LINES = 200;
const MAX_STOCKTAKE_LINES = 1000;
const MAX_STALE_IDS = 50;

/** A positive amount of minor units as a canonical base-10 integer string (at most 10^15, checked server-side). */
const PositiveMinorWireSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, "must be a positive base-10 integer string of minor units");
/** An amount of minor units of 0 or more as a canonical base-10 integer string. */
const NonNegativeMinorWireSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/, "must be a base-10 integer string of minor units, 0 or more");
/** An unsigned decimal in stock units, e.g. "1.5"; the unit's scale is checked server-side, never rounded. */
const DecimalWireSchema = z.string().regex(/^[0-9]{1,16}(\.[0-9]{1,16})?$/, "must be an unsigned decimal string");
/** Whole packs: a positive base-10 integer string. */
const PackCountWireSchema = z.string().regex(/^[1-9][0-9]{0,15}$/, "must be a positive base-10 integer string");

export const InventoryMovementTypeWireSchema = z.enum([
  "OPENING",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT",
  "WRITE_OFF",
  "COUNT_CORRECTION",
]);
export const InventoryMovementSourceKindWireSchema = z.enum([
  "OPENING_BATCH",
  "GOODS_RECEIPT",
  "ADJUSTMENT",
  "STOCKTAKE",
]);
export const InventoryDocumentStatusWireSchema = z.enum(["POSTED", "REVERSED"]);
export const StockLineDirectionWireSchema = z.enum(["INCREASE", "DECREASE"]);
export const AdjustmentReasonCodeWireSchema = z.enum(["FOUND_STOCK", "DATA_ENTRY_CORRECTION", "OTHER"]);
export const WriteOffReasonCodeWireSchema = z.enum(["DAMAGED", "EXPIRED", "SPOILED", "THEFT_OR_LOSS", "OTHER"]);
export const StocktakeStatusWireSchema = z.enum(["DRAFT", "POSTED", "CANCELLED"]);
export const StocktakeLineStatusWireSchema = z.enum(["COUNTED", "REMOVED"]);
export const StocktakeVisibilityWireSchema = z.enum(["FULL", "BLIND"]);
const ProductStatusWireSchema = z.enum(["ACTIVE", "ARCHIVED"]);

// ---- Quantity inputs -----------------------------------------------------

/** A direct quantity of 0 or more: exactly one of `quantityMinor` or `decimal`, with `unit`. */
export const DirectNonNegativeQuantityWireSchema = z.union([
  z.strictObject({ quantityMinor: NonNegativeMinorWireSchema, unit: UnitCodeWireSchema }),
  z.strictObject({ decimal: DecimalWireSchema, unit: UnitCodeWireSchema }),
]);
export type DirectNonNegativeQuantityWire = z.infer<typeof DirectNonNegativeQuantityWireSchema>;

/**
 * One stock-document line: `variantId` and exactly one positive quantity form,
 * `quantityMinor` with `unit`, `decimal` with `unit`, or `packId` with `packCount`.
 */
export const StockLineWireSchema = z.union([
  z.strictObject({ variantId: IdClaimWireSchema, quantityMinor: PositiveMinorWireSchema, unit: UnitCodeWireSchema }),
  z.strictObject({ variantId: IdClaimWireSchema, decimal: DecimalWireSchema, unit: UnitCodeWireSchema }),
  z.strictObject({ variantId: IdClaimWireSchema, packId: IdClaimWireSchema, packCount: PackCountWireSchema }),
]);
export type StockLineWire = z.infer<typeof StockLineWireSchema>;

/** An adjustment line: an explicit direction and a positive magnitude in one of the stock-line forms. */
export const AdjustmentLineWireSchema = z.union([
  z.strictObject({
    variantId: IdClaimWireSchema,
    direction: StockLineDirectionWireSchema,
    quantityMinor: PositiveMinorWireSchema,
    unit: UnitCodeWireSchema,
  }),
  z.strictObject({
    variantId: IdClaimWireSchema,
    direction: StockLineDirectionWireSchema,
    decimal: DecimalWireSchema,
    unit: UnitCodeWireSchema,
  }),
  z.strictObject({
    variantId: IdClaimWireSchema,
    direction: StockLineDirectionWireSchema,
    packId: IdClaimWireSchema,
    packCount: PackCountWireSchema,
  }),
]);
export type AdjustmentLineWire = z.infer<typeof AdjustmentLineWireSchema>;

/**
 * A stocktake count, exactly one form: a direct quantity of 0 or more, or
 * whole packs of one pack with an optional loose direct quantity of 0 or more.
 */
export const StocktakeCountWireSchema = z.union([
  z.strictObject({ quantityMinor: NonNegativeMinorWireSchema, unit: UnitCodeWireSchema }),
  z.strictObject({ decimal: DecimalWireSchema, unit: UnitCodeWireSchema }),
  z.strictObject({
    packId: IdClaimWireSchema,
    packCount: PackCountWireSchema,
    loose: DirectNonNegativeQuantityWireSchema.optional(),
  }),
]);
export type StocktakeCountWire = z.infer<typeof StocktakeCountWireSchema>;

// ---- Paths ---------------------------------------------------------------

export const InventoryItemPathSchema = z.strictObject({ businessId: z.string(), variantId: z.string() });
export const OpeningBatchPathSchema = z.strictObject({ businessId: z.string(), openingBatchId: z.string() });
export const GoodsReceiptPathSchema = z.strictObject({ businessId: z.string(), goodsReceiptId: z.string() });
export const AdjustmentPathSchema = z.strictObject({ businessId: z.string(), adjustmentId: z.string() });
export const StocktakePathSchema = z.strictObject({ businessId: z.string(), stocktakeId: z.string() });
export const StocktakeLinePathSchema = z.strictObject({
  businessId: z.string(),
  stocktakeId: z.string(),
  variantId: z.string(),
});

// ---- Queries -------------------------------------------------------------

/**
 * `GET .../inventory/balances`: keyset page, an optional search term (name
 * contains, or exact SKU or barcode) and `lowStock=true` (exactly "true" or
 * "false"; absent means every item).
 */
export const InventoryItemListQuerySchema = PageQuerySchema.extend({
  q: z.string().min(1).max(480).optional(),
  lowStock: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type InventoryItemListParams = z.infer<typeof InventoryItemListQuerySchema>;

/** `GET .../inventory/stocktakes`: keyset page and an optional status. */
export const StocktakeListQuerySchema = PageQuerySchema.extend({ status: StocktakeStatusWireSchema.optional() });
export type StocktakeListParams = z.infer<typeof StocktakeListQuerySchema>;

// ---- Requests ------------------------------------------------------------

const documentLines = <T extends z.ZodType>(line: T) => z.array(line).min(1).max(MAX_DOCUMENT_LINES);

/** `POST .../inventory/opening-stock` (`inventory:opening`; requires `Idempotency-Key`). */
export const RecordOpeningStockRequestSchema = z.strictObject({
  lines: documentLines(StockLineWireSchema),
  note: NoteWireSchema.optional(),
});
export type RecordOpeningStockRequest = z.infer<typeof RecordOpeningStockRequestSchema>;

/** `POST .../inventory/goods-receipts` (`inventory:receive`; requires `Idempotency-Key`). No supplier, cost or order. */
export const PostGoodsReceiptRequestSchema = z.strictObject({
  lines: documentLines(StockLineWireSchema),
  reference: ReferenceWireSchema.optional(),
  note: NoteWireSchema.optional(),
});
export type PostGoodsReceiptRequest = z.infer<typeof PostGoodsReceiptRequestSchema>;

/** `POST .../inventory/adjustments` (`inventory:adjust`; requires `Idempotency-Key`). */
export const RecordAdjustmentRequestSchema = z.strictObject({
  lines: documentLines(AdjustmentLineWireSchema),
  reasonCode: AdjustmentReasonCodeWireSchema,
  reasonNote: ReasonNoteWireSchema.optional(),
  note: NoteWireSchema.optional(),
});
export type RecordAdjustmentRequest = z.infer<typeof RecordAdjustmentRequestSchema>;

/** `POST .../inventory/write-offs` (`inventory:adjust`; requires `Idempotency-Key`). Positive magnitudes only. */
export const RecordWriteOffRequestSchema = z.strictObject({
  lines: documentLines(StockLineWireSchema),
  reasonCode: WriteOffReasonCodeWireSchema,
  reasonNote: ReasonNoteWireSchema.optional(),
  note: NoteWireSchema.optional(),
});
export type RecordWriteOffRequest = z.infer<typeof RecordWriteOffRequestSchema>;

/** `POST .../goods-receipts/:id/reverse` and `.../adjustments/:id/reverse` (`inventory:adjust`). */
export const ReverseDocumentRequestSchema = z.strictObject({
  reason: ReasonNoteWireSchema.regex(/\S/, "a reversal reason is required"),
});
export type ReverseDocumentRequest = z.infer<typeof ReverseDocumentRequestSchema>;

/** `PUT .../inventory/items/:variantId/threshold` (`inventory:threshold`). No pack form. */
export const SetLowStockThresholdRequestSchema = z.strictObject({
  expectedVersion: NonNegativeVersionWireSchema,
  threshold: DirectNonNegativeQuantityWireSchema,
});
export type SetLowStockThresholdRequest = z.infer<typeof SetLowStockThresholdRequestSchema>;

/** `POST .../inventory/items/:variantId/threshold/clear` (`inventory:threshold`). */
export const ClearLowStockThresholdRequestSchema = z.strictObject({ expectedVersion: NonNegativeVersionWireSchema });
export type ClearLowStockThresholdRequest = z.infer<typeof ClearLowStockThresholdRequestSchema>;

/** `POST .../inventory/stocktakes` (`inventory:count`; requires `Idempotency-Key`). */
export const CreateStocktakeRequestSchema = z.strictObject({ note: NoteWireSchema.optional() });
export type CreateStocktakeRequest = z.infer<typeof CreateStocktakeRequestSchema>;

/**
 * `PUT .../stocktakes/:stocktakeId/lines/:variantId` (`inventory:count`).
 * `expectedVersion` is the line version last read; omitted or 0 means "no line yet".
 */
export const RecordStocktakeCountRequestSchema = z.strictObject({
  count: StocktakeCountWireSchema,
  expectedVersion: NonNegativeVersionWireSchema.optional(),
});
export type RecordStocktakeCountRequest = z.infer<typeof RecordStocktakeCountRequestSchema>;

/** `POST .../stocktakes/:stocktakeId/lines/:variantId/remove` (`inventory:count`). */
export const RemoveStocktakeLineRequestSchema = z.strictObject({ expectedVersion: PersistedVersionWireSchema });
export type RemoveStocktakeLineRequest = z.infer<typeof RemoveStocktakeLineRequestSchema>;

/** `POST .../stocktakes/:stocktakeId/post` (`inventory:count-post`). */
export const PostStocktakeRequestSchema = z.strictObject({ expectedVersion: PersistedVersionWireSchema });
export type PostStocktakeRequest = z.infer<typeof PostStocktakeRequestSchema>;

/** `POST .../stocktakes/:stocktakeId/cancel` (`inventory:count-post`). The reason is recorded on the audit only. */
export const CancelStocktakeRequestSchema = z.strictObject({
  expectedVersion: PersistedVersionWireSchema,
  reason: ReasonNoteWireSchema.optional(),
});
export type CancelStocktakeRequest = z.infer<typeof CancelStocktakeRequestSchema>;

// ---- Responses: items and movements ----------------------------------------

/** A stock item at the default location. `lowStock` is derived on read; archived items are never low. */
export const InventoryItemResponseSchema = z.strictObject({
  productId: IdWireSchema,
  variantId: IdWireSchema,
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  productStatus: ProductStatusWireSchema,
  stockUnit: UnitCodeWireSchema,
  onHand: QuantityWireSchema,
  /** 0 when the item has no balance row yet. */
  balanceVersion: NonNegativeVersionWireSchema,
  threshold: QuantityWireSchema.nullable(),
  /** 0 when no threshold row exists; a cleared threshold keeps its row's version. */
  thresholdVersion: NonNegativeVersionWireSchema,
  lowStock: z.boolean(),
});
export type InventoryItemResponse = z.infer<typeof InventoryItemResponseSchema>;

export const InventoryItemsResponseSchema = z.strictObject({ items: z.array(InventoryItemResponseSchema), nextCursor });
export type InventoryItemsResponse = z.infer<typeof InventoryItemsResponseSchema>;

/** The pack a pack-entry movement was recorded in, as it was at the time. */
export const PackSnapshotWireSchema = z.strictObject({
  packId: IdWireSchema,
  name: z.string(),
  count: PackCountWireSchema,
  factorMinor: PackFactorMinorWireSchema,
});

/**
 * One movement. Who recorded it, from which device and under which
 * correlation ID stay in the audit trail and are not part of the wire.
 */
export const InventoryMovementResponseSchema = z.strictObject({
  movementId: IdWireSchema,
  type: InventoryMovementTypeWireSchema,
  delta: QuantityWireSchema,
  balanceAfter: QuantityWireSchema,
  balanceVersion: PersistedVersionWireSchema,
  source: z.strictObject({ kind: InventoryMovementSourceKindWireSchema, id: IdWireSchema }),
  pack: PackSnapshotWireSchema.nullable(),
  reversesMovementId: IdWireSchema.nullable(),
  reasonCode: z.union([AdjustmentReasonCodeWireSchema, WriteOffReasonCodeWireSchema]).nullable(),
  reasonNote: z.string().nullable(),
  sourceChannel: z.string().min(1).max(64),
  occurredAt: InstantWireSchema,
  businessDate: BusinessDateWireSchema,
});
export type InventoryMovementResponse = z.infer<typeof InventoryMovementResponseSchema>;

/** `GET .../inventory/items/:variantId/movements`: newest first. */
export const InventoryMovementsResponseSchema = z.strictObject({
  items: z.array(InventoryMovementResponseSchema),
  nextCursor,
});
export type InventoryMovementsResponse = z.infer<typeof InventoryMovementsResponseSchema>;

/** A movement of a document, which may cover several stock items. */
export const DocumentMovementResponseSchema = InventoryMovementResponseSchema.extend({ variantId: IdWireSchema });
export type DocumentMovementResponse = z.infer<typeof DocumentMovementResponseSchema>;

// ---- Responses: documents ------------------------------------------------

const documentHeader = {
  id: IdWireSchema,
  locationId: IdWireSchema,
  note: z.string().nullable(),
  occurredAt: InstantWireSchema,
  businessDate: BusinessDateWireSchema,
};

const reversalState = {
  status: InventoryDocumentStatusWireSchema,
  reversedAt: InstantWireSchema.nullable(),
  reversalReason: z.string().nullable(),
};

export const OpeningBatchHeaderWireSchema = z.strictObject(documentHeader);
export const GoodsReceiptHeaderWireSchema = z.strictObject({
  ...documentHeader,
  reference: z.string().nullable(),
  ...reversalState,
});
export const AdjustmentHeaderWireSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...documentHeader,
    kind: z.literal("ADJUSTMENT"),
    reasonCode: AdjustmentReasonCodeWireSchema,
    reasonNote: z.string().nullable(),
    ...reversalState,
  }),
  z.strictObject({
    ...documentHeader,
    kind: z.literal("WRITE_OFF"),
    reasonCode: WriteOffReasonCodeWireSchema,
    reasonNote: z.string().nullable(),
    ...reversalState,
  }),
]);

/**
 * `POST .../inventory/opening-stock` (201) and `GET .../inventory/opening-batches/:id`.
 * A create returns its original movements; a read returns every movement of the document.
 */
export const OpeningBatchResponseSchema = z.strictObject({
  document: OpeningBatchHeaderWireSchema,
  movements: z.array(DocumentMovementResponseSchema),
});
export type OpeningBatchResponse = z.infer<typeof OpeningBatchResponseSchema>;

/**
 * `POST .../inventory/goods-receipts` (201) and `GET .../inventory/goods-receipts/:id`.
 * A keyed replay returns the creation snapshot (POSTED) even after a reversal.
 */
export const GoodsReceiptResponseSchema = z.strictObject({
  document: GoodsReceiptHeaderWireSchema,
  movements: z.array(DocumentMovementResponseSchema),
});
export type GoodsReceiptResponse = z.infer<typeof GoodsReceiptResponseSchema>;

/** `POST .../inventory/adjustments`, `POST .../inventory/write-offs` (201) and `GET .../inventory/adjustments/:id`. */
export const AdjustmentResponseSchema = z.strictObject({
  document: AdjustmentHeaderWireSchema,
  movements: z.array(DocumentMovementResponseSchema),
});
export type AdjustmentResponse = z.infer<typeof AdjustmentResponseSchema>;

/** `POST .../goods-receipts/:id/reverse`: the REVERSED receipt and the reversal movements this call wrote. */
export const GoodsReceiptReversalResponseSchema = z.strictObject({
  document: GoodsReceiptHeaderWireSchema,
  reversalMovements: z.array(DocumentMovementResponseSchema),
  changed: z.boolean(),
});
export type GoodsReceiptReversalResponse = z.infer<typeof GoodsReceiptReversalResponseSchema>;

/** `POST .../adjustments/:id/reverse`: the REVERSED document and the reversal movements this call wrote. */
export const AdjustmentReversalResponseSchema = z.strictObject({
  document: AdjustmentHeaderWireSchema,
  reversalMovements: z.array(DocumentMovementResponseSchema),
  changed: z.boolean(),
});
export type AdjustmentReversalResponse = z.infer<typeof AdjustmentReversalResponseSchema>;

/** `PUT .../threshold` and `POST .../threshold/clear`. Version 0 means no threshold row exists. */
export const LowStockThresholdResponseSchema = z.strictObject({
  variantId: IdWireSchema,
  locationId: IdWireSchema,
  threshold: QuantityWireSchema.nullable(),
  version: NonNegativeVersionWireSchema,
  changed: z.boolean(),
});
export type LowStockThresholdResponse = z.infer<typeof LowStockThresholdResponseSchema>;

// ---- Responses: stocktakes -------------------------------------------------

/**
 * `POST .../inventory/stocktakes` (201): the immutable DRAFT version-1
 * creation snapshot, also on replay after the stocktake has moved on.
 */
export const StocktakeCreationResponseSchema = z.strictObject({
  stocktakeId: IdWireSchema,
  locationId: IdWireSchema,
  status: z.literal("DRAFT"),
  version: z.literal(1),
  note: z.string().nullable(),
  createdAt: InstantWireSchema,
});
export type StocktakeCreationResponse = z.infer<typeof StocktakeCreationResponseSchema>;

const stocktakeHeader = {
  stocktakeId: IdWireSchema,
  locationId: IdWireSchema,
  status: StocktakeStatusWireSchema,
  version: PersistedVersionWireSchema,
  note: z.string().nullable(),
  createdAt: InstantWireSchema,
  postedAt: InstantWireSchema.nullable(),
  businessDate: BusinessDateWireSchema.nullable(),
  cancelledAt: InstantWireSchema.nullable(),
  countedLineCount: z.number().int().min(0).max(MAX_STOCKTAKE_LINES),
  /** Posting totals of a POSTED stocktake; shown in both views (they reveal no quantity). */
  posting: z
    .strictObject({
      correctionMovementCount: z.number().int().min(0).max(MAX_STOCKTAKE_LINES),
      zeroVarianceCount: z.number().int().min(0).max(MAX_STOCKTAKE_LINES),
    })
    .nullable(),
};

export const StocktakeFullSchema = z.strictObject({ visibility: z.literal("FULL"), ...stocktakeHeader });
export const StocktakeBlindSchema = z.strictObject({ visibility: z.literal("BLIND"), ...stocktakeHeader });
/** A stocktake header: FULL with `inventory:count-post`, BLIND otherwise. */
export const StocktakeResponseSchema = z.discriminatedUnion("visibility", [StocktakeFullSchema, StocktakeBlindSchema]);
export type StocktakeResponse = z.infer<typeof StocktakeResponseSchema>;

const stocktakeLine = {
  variantId: IdWireSchema,
  status: StocktakeLineStatusWireSchema,
  countedQuantity: QuantityWireSchema,
  stockUnit: UnitCodeWireSchema,
  version: PersistedVersionWireSchema,
  countedAt: InstantWireSchema,
};

/** A line as the counter sees it: `expectedAtCount` and `variance` do not exist. */
export const StocktakeLineBlindSchema = z.strictObject({ visibility: z.literal("BLIND"), ...stocktakeLine });
/** `variance` is set on COUNTED lines of a POSTED stocktake only. */
export const StocktakeLineFullSchema = z.strictObject({
  visibility: z.literal("FULL"),
  ...stocktakeLine,
  expectedAtCount: QuantityWireSchema,
  variance: QuantityWireSchema.nullable(),
});
export const StocktakeLineResponseSchema = z.discriminatedUnion("visibility", [
  StocktakeLineFullSchema,
  StocktakeLineBlindSchema,
]);
export type StocktakeLineResponse = z.infer<typeof StocktakeLineResponseSchema>;

const oneVisibility = (items: readonly { readonly visibility: string }[]) =>
  items.every((item) => item.visibility === items[0]?.visibility);

/** `GET .../inventory/stocktakes`: headers only; there are no lines in this list. */
export const StocktakesResponseSchema = z
  .strictObject({ items: z.array(StocktakeResponseSchema), nextCursor })
  .refine((page) => oneVisibility(page.items), { message: "a page has one visibility" });
export type StocktakesResponse = z.infer<typeof StocktakesResponseSchema>;

/** `GET .../inventory/stocktakes/:stocktakeId/lines`: COUNTED and REMOVED lines by variant ID. */
export const StocktakeLinesResponseSchema = z
  .strictObject({ items: z.array(StocktakeLineResponseSchema), nextCursor })
  .refine((page) => oneVisibility(page.items), { message: "a page has one visibility" });
export type StocktakeLinesResponse = z.infer<typeof StocktakeLinesResponseSchema>;

/** `PUT .../lines/:variantId` and `POST .../lines/:variantId/remove`: the header and the line, in one visibility. */
export const StocktakeLineChangeResponseSchema = z
  .strictObject({ stocktake: StocktakeResponseSchema, line: StocktakeLineResponseSchema, changed: z.boolean() })
  .refine((body) => body.stocktake.visibility === body.line.visibility, {
    message: "the stocktake and its line have one visibility",
  });
export type StocktakeLineChangeResponse = z.infer<typeof StocktakeLineChangeResponseSchema>;

/** `POST .../stocktakes/:stocktakeId/post`: the COUNT_CORRECTION movements this call wrote; none for a no-op. */
export const PostStocktakeResponseSchema = z.strictObject({
  stocktake: StocktakeFullSchema,
  movements: z.array(DocumentMovementResponseSchema),
  changed: z.boolean(),
});
export type PostStocktakeResponse = z.infer<typeof PostStocktakeResponseSchema>;

/** `POST .../stocktakes/:stocktakeId/cancel`. */
export const CancelStocktakeResponseSchema = z.strictObject({ stocktake: StocktakeFullSchema, changed: z.boolean() });
export type CancelStocktakeResponse = z.infer<typeof CancelStocktakeResponseSchema>;

// ---- Errors --------------------------------------------------------------

/**
 * The `details` of a STOCKTAKE_STALE error: the first 50 stale variant IDs in
 * ascending order and the total number of stale lines. No quantity, balance
 * version, stock unit, business or location is exposed.
 */
export const StocktakeStaleDetailsSchema = z
  .strictObject({
    staleVariantIds: z.array(IdWireSchema).min(1).max(MAX_STALE_IDS),
    staleLineCount: z.number().int().min(1).max(MAX_STOCKTAKE_LINES),
  })
  .refine((details) => details.staleVariantIds.every((id, index, ids) => index === 0 || (ids[index - 1] ?? "") < id), {
    message: "staleVariantIds are unique and ascending",
  })
  .refine((details) => details.staleLineCount >= details.staleVariantIds.length, {
    message: "staleLineCount covers every listed ID",
  });
export type StocktakeStaleDetails = z.infer<typeof StocktakeStaleDetailsSchema>;

/** The full STOCKTAKE_STALE error body: the generic envelope with its strict details. */
export const StocktakeStaleErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("STOCKTAKE_STALE"),
    message: z.string().min(1).max(1000),
    details: StocktakeStaleDetailsSchema,
  }),
});
export type StocktakeStaleErrorEnvelope = z.infer<typeof StocktakeStaleErrorEnvelopeSchema>;
