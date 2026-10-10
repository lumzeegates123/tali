import type {
  GoodsReceipt,
  GoodsReceiptId,
  GoodsReceiptReference,
  InventoryAdjustment,
  InventoryAdjustmentId,
  InventoryAdjustmentKind,
  InventoryMovementSource,
  InventoryNote,
  InventoryReasonCode,
  InventoryReasonNote,
  LocationId,
  OpeningBatch,
  OpeningBatchId,
  Stocktake,
  StocktakeId,
} from "@tali/domain";
import {
  BusinessDate,
  parseAdjustmentReason,
  parseGoodsReceiptId,
  parseGoodsReceiptReference,
  parseInventoryAdjustmentId,
  parseInventoryAdjustmentKind,
  parseInventoryNote,
  parseLocationId,
  parseOpeningBatchId,
  parseStocktakeId,
} from "@tali/domain";
import type { IdempotentResultCodec } from "../../idempotency/keyed-idempotency.js";
import type { JsonObject } from "../../idempotency/result-json.js";
import { instantAt, integerAt, objectAt, optionalTextAt, textAt } from "../../idempotency/result-json.js";
import type { JsonValue } from "../../ports/queue-provider.js";

/**
 * The compact, state-independent header snapshot a keyed inventory document
 * stores for replay (plan decision D5). It is built before any lock or read,
 * so it never contains stock: the movements are read with `listOriginals` on
 * both the fresh and the replay path. A replay after a reversal still returns
 * this POSTED creation snapshot.
 */
interface StockDocumentSnapshotBase {
  readonly locationId: LocationId;
  readonly note?: InventoryNote;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
  readonly status: "POSTED";
  readonly lineCount: number;
}

export interface OpeningBatchSnapshot extends StockDocumentSnapshotBase {
  readonly kind: "OPENING_BATCH";
  readonly id: OpeningBatchId;
}

export interface GoodsReceiptSnapshot extends StockDocumentSnapshotBase {
  readonly kind: "GOODS_RECEIPT";
  readonly id: GoodsReceiptId;
  readonly reference?: GoodsReceiptReference;
}

export interface AdjustmentSnapshot extends StockDocumentSnapshotBase {
  readonly kind: InventoryAdjustmentKind;
  readonly id: InventoryAdjustmentId;
  readonly reasonCode: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
}

export type StockDocumentSnapshot = OpeningBatchSnapshot | GoodsReceiptSnapshot | AdjustmentSnapshot;

function base(header: OpeningBatch | GoodsReceipt | InventoryAdjustment, lineCount: number) {
  return {
    locationId: header.locationId,
    ...(header.note === undefined ? {} : { note: header.note }),
    occurredAt: header.occurredAt,
    businessDate: header.businessDate,
    status: "POSTED" as const,
    lineCount,
  };
}

export function openingBatchSnapshot(header: OpeningBatch, lineCount: number): OpeningBatchSnapshot {
  return Object.freeze({ kind: "OPENING_BATCH", id: header.id, ...base(header, lineCount) });
}

export function goodsReceiptSnapshot(header: GoodsReceipt, lineCount: number): GoodsReceiptSnapshot {
  return Object.freeze({
    kind: "GOODS_RECEIPT",
    id: header.id,
    ...(header.reference === undefined ? {} : { reference: header.reference }),
    ...base(header, lineCount),
  });
}

export function adjustmentSnapshot(header: InventoryAdjustment, lineCount: number): AdjustmentSnapshot {
  return Object.freeze({
    kind: header.kind,
    id: header.id,
    reasonCode: header.reasonCode,
    ...(header.reasonNote === undefined ? {} : { reasonNote: header.reasonNote }),
    ...base(header, lineCount),
  });
}

/** The document whose movements a snapshot's `listOriginals` reads. */
export function sourceOfSnapshot(snapshot: StockDocumentSnapshot): InventoryMovementSource {
  switch (snapshot.kind) {
    case "OPENING_BATCH":
      return { kind: "OPENING_BATCH", id: snapshot.id };
    case "GOODS_RECEIPT":
      return { kind: "GOODS_RECEIPT", id: snapshot.id };
    case "ADJUSTMENT":
    case "WRITE_OFF":
      return { kind: "ADJUSTMENT", id: snapshot.id };
  }
}

function encodeBase(snapshot: StockDocumentSnapshot): JsonObject {
  return {
    kind: snapshot.kind,
    id: snapshot.id,
    locationId: snapshot.locationId,
    ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
    occurredAt: snapshot.occurredAt.toISOString(),
    businessDate: snapshot.businessDate.toString(),
    status: snapshot.status,
    lineCount: snapshot.lineCount,
  };
}

function decodeBase(stored: JsonValue, kinds: readonly string[]) {
  const root = objectAt(objectAt(stored, "result")["document"], "document");
  const kind = textAt(root, "kind");
  if (!kinds.includes(kind)) throw new Error(`stored result "kind" is not one of ${kinds.join(", ")}`);
  if (textAt(root, "status") !== "POSTED") throw new Error('stored result "status" is not POSTED');
  const lineCount = integerAt(root, "lineCount");
  if (lineCount < 1) throw new Error('stored result "lineCount" is not positive');
  const note = optionalTextAt(root, "note");
  return {
    root,
    kind,
    common: {
      locationId: parseLocationId(textAt(root, "locationId")),
      ...(note === undefined ? {} : { note: parseInventoryNote(note) }),
      occurredAt: instantAt(root, "occurredAt"),
      businessDate: BusinessDate.parse(textAt(root, "businessDate")),
      status: "POSTED" as const,
      lineCount,
    },
  };
}

export const openingBatchSnapshotCodec: IdempotentResultCodec<OpeningBatchSnapshot> = {
  encode: (snapshot) => ({ document: encodeBase(snapshot) }),
  decode(stored) {
    const { root, common } = decodeBase(stored, ["OPENING_BATCH"]);
    return Object.freeze({ kind: "OPENING_BATCH", id: parseOpeningBatchId(textAt(root, "id")), ...common });
  },
};

export const goodsReceiptSnapshotCodec: IdempotentResultCodec<GoodsReceiptSnapshot> = {
  encode: (snapshot) => ({
    document: {
      ...encodeBase(snapshot),
      ...(snapshot.reference === undefined ? {} : { reference: snapshot.reference }),
    },
  }),
  decode(stored) {
    const { root, common } = decodeBase(stored, ["GOODS_RECEIPT"]);
    const reference = optionalTextAt(root, "reference");
    return Object.freeze({
      kind: "GOODS_RECEIPT",
      id: parseGoodsReceiptId(textAt(root, "id")),
      ...(reference === undefined ? {} : { reference: parseGoodsReceiptReference(reference) }),
      ...common,
    });
  },
};

/**
 * The immutable creation snapshot CreateStocktake stores for replay (Slice 6
 * plan section 8): the DRAFT version-1 header as created. A replay returns it
 * unchanged after counts, posting or cancellation; current state is read with
 * GetStocktake, never through the creation key.
 */
export interface StocktakeCreationSnapshot {
  readonly stocktakeId: StocktakeId;
  readonly locationId: LocationId;
  readonly status: "DRAFT";
  readonly version: 1;
  readonly note?: InventoryNote;
  readonly createdAt: Date;
}

export function stocktakeCreationSnapshot(stocktake: Stocktake): StocktakeCreationSnapshot {
  if (stocktake.status !== "DRAFT" || stocktake.version !== 1) {
    throw new Error("a stocktake creation snapshot is taken of the new DRAFT version 1");
  }
  return Object.freeze({
    stocktakeId: stocktake.id,
    locationId: stocktake.locationId,
    status: "DRAFT",
    version: 1,
    ...(stocktake.note === undefined ? {} : { note: stocktake.note }),
    createdAt: stocktake.createdAt,
  });
}

export const stocktakeCreationSnapshotCodec: IdempotentResultCodec<StocktakeCreationSnapshot> = {
  encode: (snapshot) => ({
    stocktake: {
      stocktakeId: snapshot.stocktakeId,
      locationId: snapshot.locationId,
      status: snapshot.status,
      version: snapshot.version,
      ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
      createdAt: snapshot.createdAt.toISOString(),
    },
  }),
  decode(stored) {
    const root = objectAt(objectAt(stored, "result")["stocktake"], "stocktake");
    if (textAt(root, "status") !== "DRAFT") throw new Error('stored result "status" is not DRAFT');
    if (integerAt(root, "version") !== 1) throw new Error('stored result "version" is not 1');
    const note = optionalTextAt(root, "note");
    return Object.freeze({
      stocktakeId: parseStocktakeId(textAt(root, "stocktakeId")),
      locationId: parseLocationId(textAt(root, "locationId")),
      status: "DRAFT",
      version: 1,
      ...(note === undefined ? {} : { note: parseInventoryNote(note) }),
      createdAt: instantAt(root, "createdAt"),
    });
  },
};

export const adjustmentSnapshotCodec: IdempotentResultCodec<AdjustmentSnapshot> = {
  encode: (snapshot) => ({
    document: {
      ...encodeBase(snapshot),
      reasonCode: snapshot.reasonCode,
      ...(snapshot.reasonNote === undefined ? {} : { reasonNote: snapshot.reasonNote }),
    },
  }),
  decode(stored) {
    const { root, kind, common } = decodeBase(stored, ["ADJUSTMENT", "WRITE_OFF"]);
    const parsedKind = parseInventoryAdjustmentKind(kind);
    const reason = parseAdjustmentReason({
      kind: parsedKind,
      reasonCode: textAt(root, "reasonCode"),
      reasonNote: optionalTextAt(root, "reasonNote"),
    });
    return Object.freeze({
      kind: parsedKind,
      id: parseInventoryAdjustmentId(textAt(root, "id")),
      ...reason,
      ...common,
    });
  },
};
