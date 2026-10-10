import type {
  AdjustmentSnapshot,
  AdjustmentView,
  CreateStocktakeOutcome,
  DocumentMovementView,
  GoodsReceiptSnapshot,
  GoodsReceiptView,
  InventoryAdjustmentOutcome,
  InventoryDocumentResult,
  InventoryItemView,
  InventoryMovementView,
  OpeningBatchView,
  Page,
  PostGoodsReceiptOutcome,
  PostStocktakeResult,
  RecordOpeningStockOutcome,
  ReverseAdjustment,
  ReverseGoodsReceipt,
  StocktakeChangeResult,
  StocktakeLineChangeResult,
  StocktakeLineView,
  StocktakeView,
  ThresholdChangeResult,
} from "@tali/application";
import {
  type AdjustmentResponse,
  AdjustmentResponseSchema,
  type AdjustmentReversalResponse,
  AdjustmentReversalResponseSchema,
  type CancelStocktakeResponse,
  CancelStocktakeResponseSchema,
  type DocumentMovementResponse,
  type GoodsReceiptResponse,
  GoodsReceiptResponseSchema,
  type GoodsReceiptReversalResponse,
  GoodsReceiptReversalResponseSchema,
  type InventoryItemResponse,
  InventoryItemResponseSchema,
  type InventoryItemsResponse,
  InventoryItemsResponseSchema,
  type InventoryMovementResponse,
  type InventoryMovementsResponse,
  InventoryMovementsResponseSchema,
  type LowStockThresholdResponse,
  LowStockThresholdResponseSchema,
  type OpeningBatchResponse,
  OpeningBatchResponseSchema,
  type PostStocktakeResponse,
  PostStocktakeResponseSchema,
  type QuantityWire,
  type StocktakeCreationResponse,
  StocktakeCreationResponseSchema,
  StocktakeLineBlindSchema,
  type StocktakeLineChangeResponse,
  StocktakeLineChangeResponseSchema,
  StocktakeLineFullSchema,
  type StocktakeLineResponse,
  type StocktakeLinesResponse,
  StocktakeLinesResponseSchema,
  type StocktakeResponse,
  StocktakeResponseSchema,
  type StocktakesResponse,
  StocktakesResponseSchema,
} from "@tali/shared";

/**
 * Inventory and stocktake results to wire DTOs (ADR-008, plan 004 Slices 5
 * and 6). Each mapper builds a fresh object from the fields it names, writes
 * every bigint as a canonical base-10 string and every absent optional field
 * as an explicit null, and parses the result with the strict shared response
 * schema. The business ID, recording membership, device, correlation ID,
 * recorded-at time and balance versions captured at count time never reach
 * the wire. A BLIND stocktake line is built without the expected quantity and
 * variance keys and parsed with the BLIND schema, which rejects them.
 */
type Quantity = InventoryItemView["onHand"];
type MovementRecord = PostStocktakeResult["movements"][number];
type GoodsReceiptRecord = Awaited<ReturnType<ReverseGoodsReceipt["execute"]>>["document"];
type AdjustmentRecord = Awaited<ReturnType<ReverseAdjustment["execute"]>>["document"];

/** The header fields a document's creation snapshot, read view and stored record all carry. */
interface OpeningHeader {
  readonly id: string;
  readonly locationId: string;
  readonly note?: string;
  readonly occurredAt: Date;
  readonly businessDate: OpeningBatchView["businessDate"];
}
interface ReversalFields {
  readonly status: GoodsReceiptView["status"];
  readonly reversedAt?: Date;
  readonly reversalReason?: string;
}
interface GoodsReceiptHeader extends OpeningHeader, ReversalFields {
  readonly reference?: string;
}
interface AdjustmentHeader extends OpeningHeader, ReversalFields {
  readonly kind: AdjustmentView["kind"];
  readonly reasonCode: AdjustmentView["reasonCode"];
  readonly reasonNote?: string;
}

function quantity(value: Quantity): QuantityWire {
  return { quantityMinor: value.toMinorUnitsString(), unit: value.unit };
}

function item(view: InventoryItemView): InventoryItemResponse {
  return {
    productId: view.productId,
    variantId: view.variantId,
    name: view.name,
    sku: view.sku?.value ?? null,
    barcode: view.barcode?.value ?? null,
    productStatus: view.productStatus,
    stockUnit: view.stockUnit,
    onHand: quantity(view.onHand),
    balanceVersion: view.balanceVersion,
    threshold: view.threshold === undefined ? null : quantity(view.threshold),
    thresholdVersion: view.thresholdVersion,
    lowStock: view.lowStock,
  };
}

function movement(view: InventoryMovementView): InventoryMovementResponse {
  return {
    movementId: view.movementId,
    type: view.type,
    delta: quantity(view.delta),
    balanceAfter: quantity(view.balanceAfter),
    balanceVersion: view.balanceVersion,
    source: { kind: view.source.kind, id: view.source.id },
    pack:
      view.pack === undefined
        ? null
        : {
            packId: view.pack.packId,
            name: view.pack.name,
            count: view.pack.count.toString(10),
            factorMinor: view.pack.factorMinor.toString(10),
          },
    reversesMovementId: view.reversesMovementId ?? null,
    reasonCode: view.reasonCode ?? null,
    reasonNote: view.reasonNote ?? null,
    sourceChannel: view.sourceChannel,
    occurredAt: view.occurredAt.toISOString(),
    businessDate: view.businessDate.toString(),
  };
}

function documentMovement(view: DocumentMovementView): DocumentMovementResponse {
  return { ...movement(view), variantId: view.variantId };
}

/** A stored movement (a write's own result) seen through the same public fields as a read. */
function recordedMovement(record: MovementRecord): DocumentMovementResponse {
  return documentMovement({
    movementId: record.id,
    variantId: record.variantId,
    type: record.type,
    delta: record.delta,
    balanceAfter: record.balanceAfter,
    balanceVersion: record.balanceVersion,
    source: record.source,
    ...(record.pack === undefined ? {} : { pack: record.pack }),
    ...(record.reversesMovementId === undefined ? {} : { reversesMovementId: record.reversesMovementId }),
    ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
    ...(record.reasonNote === undefined ? {} : { reasonNote: record.reasonNote }),
    sourceChannel: record.sourceChannel,
    occurredAt: record.occurredAt,
    businessDate: record.businessDate,
  });
}

function openingHeader(header: OpeningHeader) {
  return {
    id: header.id,
    locationId: header.locationId,
    note: header.note ?? null,
    occurredAt: header.occurredAt.toISOString(),
    businessDate: header.businessDate.toString(),
  };
}

function reversal(header: ReversalFields) {
  return {
    status: header.status,
    reversedAt: header.reversedAt?.toISOString() ?? null,
    reversalReason: header.reversalReason ?? null,
  };
}

function goodsReceiptHeader(header: GoodsReceiptHeader) {
  return { ...openingHeader(header), reference: header.reference ?? null, ...reversal(header) };
}

function adjustmentHeader(header: AdjustmentHeader) {
  return {
    ...openingHeader(header),
    kind: header.kind,
    reasonCode: header.reasonCode,
    reasonNote: header.reasonNote ?? null,
    ...reversal(header),
  };
}

function stocktake(view: StocktakeView): StocktakeResponse {
  return {
    visibility: view.visibility,
    stocktakeId: view.stocktakeId,
    locationId: view.locationId,
    status: view.status,
    version: view.version,
    note: view.note ?? null,
    createdAt: view.createdAt.toISOString(),
    postedAt: view.postedAt?.toISOString() ?? null,
    businessDate: view.businessDate?.toString() ?? null,
    cancelledAt: view.cancelledAt?.toISOString() ?? null,
    countedLineCount: view.countedLineCount,
    posting:
      view.posting === undefined
        ? null
        : {
            correctionMovementCount: view.posting.correctionMovementCount,
            zeroVarianceCount: view.posting.zeroVarianceCount,
          },
  };
}

/** A FULL line with its expected quantity and variance, or a fresh BLIND line that never had those keys. */
function stocktakeLine(view: StocktakeLineView): StocktakeLineResponse {
  const common = {
    variantId: view.variantId,
    status: view.status,
    countedQuantity: quantity(view.countedQuantity),
    stockUnit: view.stockUnit,
    version: view.version,
    countedAt: view.countedAt.toISOString(),
  };
  if (view.visibility === "BLIND") return StocktakeLineBlindSchema.parse({ visibility: "BLIND", ...common });
  return StocktakeLineFullSchema.parse({
    visibility: "FULL",
    ...common,
    expectedAtCount: quantity(view.expectedAtCount),
    variance: view.variance === undefined ? null : quantity(view.variance),
  });
}

export function toInventoryItemResponse(view: InventoryItemView): InventoryItemResponse {
  return InventoryItemResponseSchema.parse(item(view));
}

export function toInventoryItemsResponse(page: Page<InventoryItemView>): InventoryItemsResponse {
  return InventoryItemsResponseSchema.parse({ items: page.items.map(item), nextCursor: page.nextCursor });
}

export function toInventoryMovementsResponse(page: Page<InventoryMovementView>): InventoryMovementsResponse {
  return InventoryMovementsResponseSchema.parse({ items: page.items.map(movement), nextCursor: page.nextCursor });
}

export function toOpeningBatchCreatedResponse(outcome: RecordOpeningStockOutcome): OpeningBatchResponse {
  return OpeningBatchResponseSchema.parse({
    document: openingHeader(outcome.document),
    movements: outcome.movements.map(recordedMovement),
  });
}

export function toOpeningBatchResponse(result: InventoryDocumentResult<OpeningBatchView>): OpeningBatchResponse {
  return OpeningBatchResponseSchema.parse({
    document: openingHeader(result.document),
    movements: result.movements.map(documentMovement),
  });
}

export function toGoodsReceiptCreatedResponse(outcome: PostGoodsReceiptOutcome): GoodsReceiptResponse {
  const snapshot: GoodsReceiptSnapshot = outcome.document;
  return GoodsReceiptResponseSchema.parse({
    document: goodsReceiptHeader(snapshot),
    movements: outcome.movements.map(recordedMovement),
  });
}

export function toGoodsReceiptResponse(result: InventoryDocumentResult<GoodsReceiptView>): GoodsReceiptResponse {
  return GoodsReceiptResponseSchema.parse({
    document: goodsReceiptHeader(result.document),
    movements: result.movements.map(documentMovement),
  });
}

export function toAdjustmentCreatedResponse(outcome: InventoryAdjustmentOutcome): AdjustmentResponse {
  const snapshot: AdjustmentSnapshot = outcome.document;
  return AdjustmentResponseSchema.parse({
    document: adjustmentHeader(snapshot),
    movements: outcome.movements.map(recordedMovement),
  });
}

export function toAdjustmentResponse(result: InventoryDocumentResult<AdjustmentView>): AdjustmentResponse {
  return AdjustmentResponseSchema.parse({
    document: adjustmentHeader(result.document),
    movements: result.movements.map(documentMovement),
  });
}

export function toGoodsReceiptReversalResponse(result: {
  readonly document: GoodsReceiptRecord;
  readonly reversalMovements: readonly MovementRecord[];
  readonly changed: boolean;
}): GoodsReceiptReversalResponse {
  return GoodsReceiptReversalResponseSchema.parse({
    document: goodsReceiptHeader(result.document),
    reversalMovements: result.reversalMovements.map(recordedMovement),
    changed: result.changed,
  });
}

export function toAdjustmentReversalResponse(result: {
  readonly document: AdjustmentRecord;
  readonly reversalMovements: readonly MovementRecord[];
  readonly changed: boolean;
}): AdjustmentReversalResponse {
  return AdjustmentReversalResponseSchema.parse({
    document: adjustmentHeader(result.document),
    reversalMovements: result.reversalMovements.map(recordedMovement),
    changed: result.changed,
  });
}

export function toLowStockThresholdResponse(result: ThresholdChangeResult): LowStockThresholdResponse {
  return LowStockThresholdResponseSchema.parse({
    variantId: result.variantId,
    locationId: result.locationId,
    threshold: result.threshold === undefined ? null : quantity(result.threshold),
    version: result.version,
    changed: result.changed,
  });
}

/** The stored creation snapshot as created; current state is never looked up for it. */
export function toStocktakeCreationResponse(outcome: CreateStocktakeOutcome): StocktakeCreationResponse {
  const snapshot = outcome.stocktake;
  return StocktakeCreationResponseSchema.parse({
    stocktakeId: snapshot.stocktakeId,
    locationId: snapshot.locationId,
    status: snapshot.status,
    version: snapshot.version,
    note: snapshot.note ?? null,
    createdAt: snapshot.createdAt.toISOString(),
  });
}

export function toStocktakeResponse(view: StocktakeView): StocktakeResponse {
  return StocktakeResponseSchema.parse(stocktake(view));
}

export function toStocktakesResponse(page: Page<StocktakeView>): StocktakesResponse {
  return StocktakesResponseSchema.parse({ items: page.items.map(stocktake), nextCursor: page.nextCursor });
}

export function toStocktakeLinesResponse(page: Page<StocktakeLineView>): StocktakeLinesResponse {
  return StocktakeLinesResponseSchema.parse({ items: page.items.map(stocktakeLine), nextCursor: page.nextCursor });
}

export function toStocktakeLineChangeResponse(result: StocktakeLineChangeResult): StocktakeLineChangeResponse {
  return StocktakeLineChangeResponseSchema.parse({
    stocktake: stocktake(result.stocktake),
    line: stocktakeLine(result.line),
    changed: result.changed,
  });
}

export function toPostStocktakeResponse(result: PostStocktakeResult): PostStocktakeResponse {
  return PostStocktakeResponseSchema.parse({
    stocktake: stocktake(result.stocktake),
    movements: result.movements.map(recordedMovement),
    changed: result.changed,
  });
}

export function toCancelStocktakeResponse(result: StocktakeChangeResult): CancelStocktakeResponse {
  return CancelStocktakeResponseSchema.parse({ stocktake: stocktake(result.stocktake), changed: result.changed });
}
