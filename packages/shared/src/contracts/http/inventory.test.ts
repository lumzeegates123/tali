import { describe, expect, it } from "vitest";
import {
  AdjustmentResponseSchema,
  AdjustmentReversalResponseSchema,
  CancelStocktakeRequestSchema,
  CancelStocktakeResponseSchema,
  ClearLowStockThresholdRequestSchema,
  CreateStocktakeRequestSchema,
  GoodsReceiptResponseSchema,
  InventoryItemListQuerySchema,
  InventoryItemPathSchema,
  InventoryItemResponseSchema,
  InventoryMovementResponseSchema,
  InventoryMovementsResponseSchema,
  InventoryMovementTypeWireSchema,
  LowStockThresholdResponseSchema,
  OpeningBatchResponseSchema,
  PostGoodsReceiptRequestSchema,
  PostStocktakeRequestSchema,
  PostStocktakeResponseSchema,
  RecordAdjustmentRequestSchema,
  RecordOpeningStockRequestSchema,
  RecordStocktakeCountRequestSchema,
  RecordWriteOffRequestSchema,
  RemoveStocktakeLineRequestSchema,
  ReverseDocumentRequestSchema,
  SetLowStockThresholdRequestSchema,
  StocktakeCreationResponseSchema,
  StocktakeLineBlindSchema,
  StocktakeLineChangeResponseSchema,
  StocktakeLineFullSchema,
  StocktakeLinePathSchema,
  StocktakeLineResponseSchema,
  StocktakeLinesResponseSchema,
  StocktakeListQuerySchema,
  StocktakeResponseSchema,
  StocktakesResponseSchema,
  StocktakeStaleDetailsSchema,
  StocktakeStaleErrorEnvelopeSchema,
} from "./inventory.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const ID2 = "0190a000-0000-7000-8000-000000000002";
const AT = "2026-10-09T08:00:00.000Z";
const DAY = "2026-10-09";
const pieces = (quantityMinor: string) => ({ quantityMinor, unit: "PIECE" });

type Schema = { safeParse(value: unknown): { success: boolean } };
const ok = (schema: Schema, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(true);
};
const bad = (schema: Schema, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(false);
};

const movement = {
  movementId: ID,
  type: "PURCHASE_RECEIPT",
  delta: pieces("12"),
  balanceAfter: pieces("12"),
  balanceVersion: 1,
  source: { kind: "GOODS_RECEIPT", id: ID },
  pack: null,
  reversesMovementId: null,
  reasonCode: null,
  reasonNote: null,
  sourceChannel: "api",
  occurredAt: AT,
  businessDate: DAY,
};
const documentMovement = { ...movement, variantId: ID };
const item = {
  productId: ID,
  variantId: ID,
  name: "Peak Milk 400g",
  sku: null,
  barcode: "5012345678900",
  productStatus: "ACTIVE",
  stockUnit: "PIECE",
  onHand: pieces("0"),
  balanceVersion: 0,
  threshold: null,
  thresholdVersion: 0,
  lowStock: false,
};
const stocktake = {
  visibility: "FULL",
  stocktakeId: ID,
  locationId: ID,
  status: "DRAFT",
  version: 1,
  note: null,
  createdAt: AT,
  postedAt: null,
  businessDate: null,
  cancelledAt: null,
  countedLineCount: 0,
  posting: null,
};
const blindLine = {
  visibility: "BLIND",
  variantId: ID,
  status: "COUNTED",
  countedQuantity: pieces("7"),
  stockUnit: "PIECE",
  version: 1,
  countedAt: AT,
};
const fullLine = { ...blindLine, visibility: "FULL", expectedAtCount: pieces("10"), variance: null };

describe("inventory quantity inputs", () => {
  const line = (fields: Record<string, unknown>) => ({ lines: [{ variantId: ID, ...fields }] });

  it("accepts exactly one positive form per stock-document line", () => {
    ok(RecordOpeningStockRequestSchema, line({ quantityMinor: "1500", unit: "KG" }));
    ok(RecordOpeningStockRequestSchema, line({ decimal: "1.5", unit: "KG" }));
    ok(RecordOpeningStockRequestSchema, line({ packId: ID, packCount: "2" }));
  });

  it("rejects JSON numbers, zero, negatives, mixed forms and pack-with-unit lines", () => {
    for (const fields of [
      { quantityMinor: 12, unit: "PIECE" },
      { decimal: 1.5, unit: "KG" },
      { packId: ID, packCount: 2 },
      { quantityMinor: "0", unit: "PIECE" },
      { quantityMinor: "-1", unit: "PIECE" },
      { quantityMinor: "012", unit: "PIECE" },
      { decimal: "-1.5", unit: "KG" },
      { quantityMinor: "1", decimal: "1", unit: "PIECE" },
      { quantityMinor: "1", unit: "PIECE", packId: ID, packCount: "1" },
      { packId: ID, packCount: "1", unit: "PIECE" },
      { packId: ID, packCount: "0" },
      { quantityMinor: "1" },
      { quantityMinor: "1", unit: "piece" },
      { quantityMinor: "1", unit: "PIECE", locationId: ID },
    ]) {
      bad(RecordOpeningStockRequestSchema, line(fields));
    }
  });

  it("bounds a document to 1 to 200 lines and rejects unknown body fields", () => {
    bad(RecordOpeningStockRequestSchema, { lines: [] });
    const many = Array.from({ length: 201 }, () => ({ variantId: ID, quantityMinor: "1", unit: "PIECE" }));
    bad(RecordOpeningStockRequestSchema, { lines: many });
    ok(RecordOpeningStockRequestSchema, { lines: many.slice(0, 200) });
    bad(RecordOpeningStockRequestSchema, { ...line(pieces("1")), locationId: ID });
    bad(RecordOpeningStockRequestSchema, { ...line(pieces("1")), note: "x".repeat(2001) });
  });

  it("takes a reference on receipts only, bounded at the transport limit", () => {
    ok(PostGoodsReceiptRequestSchema, { ...line(pieces("1")), reference: "INV-1", note: "Morning delivery" });
    bad(PostGoodsReceiptRequestSchema, { ...line(pieces("1")), reference: "x".repeat(257) });
    bad(PostGoodsReceiptRequestSchema, { ...line(pieces("1")), supplierId: ID });
    bad(PostGoodsReceiptRequestSchema, { ...line(pieces("1")), cost: "100" });
    bad(RecordOpeningStockRequestSchema, { ...line(pieces("1")), reference: "INV-1" });
  });

  it("requires a direction on adjustments and the exact reason codes per kind", () => {
    const adjustment = { lines: [{ variantId: ID, direction: "DECREASE", ...pieces("1") }], reasonCode: "FOUND_STOCK" };
    ok(RecordAdjustmentRequestSchema, adjustment);
    ok(RecordAdjustmentRequestSchema, { ...adjustment, reasonCode: "OTHER", reasonNote: "Shelf recount" });
    bad(RecordAdjustmentRequestSchema, { ...adjustment, reasonCode: "DAMAGED" });
    bad(RecordAdjustmentRequestSchema, { ...adjustment, lines: [{ variantId: ID, ...pieces("1") }] });
    bad(RecordAdjustmentRequestSchema, { ...adjustment, lines: [{ variantId: ID, direction: "UP", ...pieces("1") }] });
    bad(RecordAdjustmentRequestSchema, {
      ...adjustment,
      lines: [{ variantId: ID, direction: "DECREASE", ...pieces("-1") }],
    });

    const writeOff = { ...line(pieces("1")), reasonCode: "DAMAGED" };
    ok(RecordWriteOffRequestSchema, writeOff);
    bad(RecordWriteOffRequestSchema, { ...writeOff, reasonCode: "FOUND_STOCK" });
    bad(RecordWriteOffRequestSchema, {
      ...writeOff,
      lines: [{ variantId: ID, direction: "DECREASE", ...pieces("1") }],
    });
    bad(RecordWriteOffRequestSchema, { ...writeOff, lines: [{ variantId: ID, ...pieces("-1") }] });
  });

  it("requires a nonblank reversal reason and no version", () => {
    ok(ReverseDocumentRequestSchema, { reason: "Entered twice" });
    bad(ReverseDocumentRequestSchema, {});
    bad(ReverseDocumentRequestSchema, { reason: "   " });
    bad(ReverseDocumentRequestSchema, { reason: "x".repeat(2001) });
    bad(ReverseDocumentRequestSchema, { reason: "x", expectedVersion: 1 });
  });

  it("takes a direct threshold of 0 or more with version 0 or more, never a pack or a number", () => {
    ok(SetLowStockThresholdRequestSchema, { expectedVersion: 0, threshold: pieces("0") });
    ok(SetLowStockThresholdRequestSchema, { expectedVersion: 3, threshold: { decimal: "2.5", unit: "KG" } });
    for (const body of [
      { expectedVersion: -1, threshold: pieces("1") },
      { expectedVersion: 1.5, threshold: pieces("1") },
      { expectedVersion: "1", threshold: pieces("1") },
      { expectedVersion: 0, threshold: { quantityMinor: 5, unit: "PIECE" } },
      { expectedVersion: 0, threshold: pieces("-1") },
      { expectedVersion: 0, threshold: { packId: ID, packCount: "1" } },
      { expectedVersion: 0, threshold: { quantityMinor: "1", decimal: "1", unit: "PIECE" } },
      { expectedVersion: 0 },
    ]) {
      bad(SetLowStockThresholdRequestSchema, body);
    }
    ok(ClearLowStockThresholdRequestSchema, { expectedVersion: 0 });
    bad(ClearLowStockThresholdRequestSchema, { expectedVersion: -1 });
    bad(ClearLowStockThresholdRequestSchema, {});
  });

  it("takes a count as a direct quantity of 0 or more or one pack with an optional loose part", () => {
    for (const count of [
      pieces("0"),
      { decimal: "0.250", unit: "KG" },
      { packId: ID, packCount: "3" },
      { packId: ID, packCount: "3", loose: pieces("0") },
      { packId: ID, packCount: "3", loose: { decimal: "0.5", unit: "KG" } },
    ]) {
      ok(RecordStocktakeCountRequestSchema, { count });
    }
    ok(RecordStocktakeCountRequestSchema, { count: pieces("1"), expectedVersion: 0 });
    ok(RecordStocktakeCountRequestSchema, { count: pieces("1"), expectedVersion: 4 });
    for (const count of [
      { quantityMinor: 3, unit: "PIECE" },
      pieces("-1"),
      { quantityMinor: "1", decimal: "1", unit: "PIECE" },
      { packId: ID, packCount: "0" },
      { packId: ID, packCount: "1", quantityMinor: "1", unit: "PIECE" },
      { packId: ID, packCount: "1", loose: { packId: ID, packCount: "1" } },
      { packId: ID, packCount: "1", loose: pieces("-1") },
      { packs: [{ packId: ID, packCount: "1" }] },
      { loose: pieces("1") },
    ]) {
      bad(RecordStocktakeCountRequestSchema, { count });
    }
    bad(RecordStocktakeCountRequestSchema, { count: pieces("1"), expectedVersion: -1 });
    bad(RecordStocktakeCountRequestSchema, { count: pieces("1"), expectedVersion: 1.5 });
    bad(RecordStocktakeCountRequestSchema, { count: pieces("1"), locationId: ID });
  });
});

describe("stocktake requests", () => {
  it("requires persisted versions of 1 or more for remove, post and cancel", () => {
    for (const schema of [RemoveStocktakeLineRequestSchema, PostStocktakeRequestSchema, CancelStocktakeRequestSchema]) {
      ok(schema, { expectedVersion: 1 });
      bad(schema, { expectedVersion: 0 });
      bad(schema, { expectedVersion: "1" });
      bad(schema, {});
      bad(schema, { expectedVersion: 1, locationId: ID });
    }
    ok(CancelStocktakeRequestSchema, { expectedVersion: 2, reason: "Started by mistake" });
    bad(CancelStocktakeRequestSchema, { expectedVersion: 2, reason: "x".repeat(2001) });
  });

  it("creates with an optional note and never a location", () => {
    ok(CreateStocktakeRequestSchema, {});
    ok(CreateStocktakeRequestSchema, { note: "Month end" });
    bad(CreateStocktakeRequestSchema, { locationId: ID });
  });
});

describe("inventory paths and queries", () => {
  it("extracts ID claims without validating them", () => {
    ok(InventoryItemPathSchema, { businessId: "x", variantId: "not-a-uuid" });
    ok(StocktakeLinePathSchema, { businessId: "x", stocktakeId: "y", variantId: "z" });
    bad(StocktakeLinePathSchema, { businessId: "x", stocktakeId: "y" });
    bad(InventoryItemPathSchema, { businessId: "x", variantId: "y", locationId: "z" });
  });

  it("parses lowStock as exactly true or false, absent meaning every item", () => {
    expect(InventoryItemListQuerySchema.parse({ lowStock: "true" }).lowStock).toBe(true);
    expect(InventoryItemListQuerySchema.parse({ lowStock: "false" }).lowStock).toBe(false);
    expect(InventoryItemListQuerySchema.parse({}).lowStock).toBeUndefined();
    for (const lowStock of ["1", "yes", "TRUE", "", "on"]) bad(InventoryItemListQuerySchema, { lowStock });
    expect(InventoryItemListQuerySchema.parse({ q: "milk", limit: "20", after: ID })).toEqual({
      q: "milk",
      limit: 20,
      after: ID,
    });
    bad(InventoryItemListQuerySchema, { q: "" });
    bad(InventoryItemListQuerySchema, { limit: "1000" });
    bad(InventoryItemListQuerySchema, { locationId: ID });
  });

  it("filters stocktakes by the three statuses only", () => {
    for (const status of ["DRAFT", "POSTED", "CANCELLED"]) ok(StocktakeListQuerySchema, { status });
    for (const status of ["REVERSED", "draft", ""]) bad(StocktakeListQuerySchema, { status });
    bad(StocktakeListQuerySchema, { variantId: ID });
  });
});

describe("inventory responses", () => {
  it("accepts an item with string quantities and rejects storage or tenant fields", () => {
    ok(InventoryItemResponseSchema, item);
    ok(InventoryItemResponseSchema, {
      ...item,
      productStatus: "ARCHIVED",
      threshold: pieces("3"),
      thresholdVersion: 2,
    });
    bad(InventoryItemResponseSchema, { ...item, onHand: { quantityMinor: 0, unit: "PIECE" } });
    for (const extra of ["businessId", "locationId", "skuNormalized", "barcodeNormalized", "trackInventory"]) {
      bad(InventoryItemResponseSchema, { ...item, [extra]: ID });
    }
  });

  it("accepts every movement type and source kind and rejects recording metadata", () => {
    for (const type of InventoryMovementTypeWireSchema.options)
      ok(InventoryMovementResponseSchema, { ...movement, type });
    ok(InventoryMovementResponseSchema, {
      ...movement,
      type: "COUNT_CORRECTION",
      source: { kind: "STOCKTAKE", id: ID },
      delta: pieces("-2"),
    });
    ok(InventoryMovementResponseSchema, {
      ...movement,
      pack: { packId: ID, name: "Crate", count: "2", factorMinor: "24" },
      reversesMovementId: ID2,
      reasonCode: "DAMAGED",
      reasonNote: "Crushed",
    });
    for (const extra of ["actorMembershipId", "deviceId", "correlationId", "businessId", "locationId", "recordedAt"]) {
      bad(InventoryMovementResponseSchema, { ...movement, [extra]: ID });
    }
    bad(InventoryMovementResponseSchema, { ...movement, source: { kind: "SALE", id: ID } });
    bad(InventoryMovementResponseSchema, { ...movement, balanceVersion: 0 });
    bad(InventoryMovementResponseSchema, {
      ...movement,
      pack: { packId: ID, name: "Crate", count: 2, factorMinor: "24" },
    });
    ok(InventoryMovementsResponseSchema, { items: [movement], nextCursor: null });
    bad(InventoryMovementsResponseSchema, { items: [movement] });
  });

  it("types each document header and shares it between create and read", () => {
    const header = { id: ID, locationId: ID, note: null, occurredAt: AT, businessDate: DAY };
    const reversal = { status: "POSTED", reversedAt: null, reversalReason: null };
    ok(OpeningBatchResponseSchema, { document: header, movements: [documentMovement] });
    bad(OpeningBatchResponseSchema, { document: { ...header, ...reversal }, movements: [] });
    ok(GoodsReceiptResponseSchema, { document: { ...header, reference: null, ...reversal }, movements: [] });
    ok(AdjustmentResponseSchema, {
      document: { ...header, kind: "WRITE_OFF", reasonCode: "EXPIRED", reasonNote: null, ...reversal },
      movements: [documentMovement],
    });
    bad(AdjustmentResponseSchema, {
      document: { ...header, kind: "WRITE_OFF", reasonCode: "FOUND_STOCK", reasonNote: null, ...reversal },
      movements: [],
    });
    bad(AdjustmentResponseSchema, {
      document: { ...header, kind: "ADJUSTMENT", reasonCode: "FOUND_STOCK", reasonNote: null, ...reversal, id2: ID },
      movements: [],
    });
    ok(AdjustmentReversalResponseSchema, {
      document: {
        ...header,
        kind: "ADJUSTMENT",
        reasonCode: "FOUND_STOCK",
        reasonNote: null,
        status: "REVERSED",
        reversedAt: AT,
        reversalReason: "Entered twice",
      },
      reversalMovements: [documentMovement],
      changed: true,
    });
    bad(OpeningBatchResponseSchema, { document: header, movements: [movement] });
  });

  it("returns one threshold shape whether set or cleared", () => {
    const body = { variantId: ID, locationId: ID, threshold: pieces("5"), version: 1, changed: true };
    ok(LowStockThresholdResponseSchema, body);
    ok(LowStockThresholdResponseSchema, { ...body, threshold: null, version: 0, changed: false });
    bad(LowStockThresholdResponseSchema, { ...body, threshold: { quantityMinor: 5, unit: "PIECE" } });
  });
});

describe("stocktake responses", () => {
  it("accepts the immutable DRAFT version-1 creation snapshot only", () => {
    const created = { stocktakeId: ID, locationId: ID, status: "DRAFT", version: 1, note: null, createdAt: AT };
    ok(StocktakeCreationResponseSchema, created);
    bad(StocktakeCreationResponseSchema, { ...created, status: "POSTED" });
    bad(StocktakeCreationResponseSchema, { ...created, version: 2 });
    bad(StocktakeCreationResponseSchema, { ...created, visibility: "FULL" });
  });

  it("discriminates headers by visibility; posting totals appear in both", () => {
    const posted = {
      ...stocktake,
      status: "POSTED",
      version: 3,
      postedAt: AT,
      businessDate: DAY,
      countedLineCount: 3,
      posting: { correctionMovementCount: 2, zeroVarianceCount: 1 },
    };
    ok(StocktakeResponseSchema, posted);
    ok(StocktakeResponseSchema, { ...posted, visibility: "BLIND" });
    bad(StocktakeResponseSchema, { ...stocktake, visibility: "PARTIAL" });
    bad(StocktakeResponseSchema, { ...stocktake, version: 0 });
    bad(StocktakeResponseSchema, { ...stocktake, status: "REVERSED" });
    bad(StocktakeResponseSchema, { ...stocktake, businessId: ID });
    ok(StocktakesResponseSchema, { items: [stocktake, stocktake], nextCursor: null });
    bad(StocktakesResponseSchema, { items: [stocktake, { ...stocktake, visibility: "BLIND" }], nextCursor: null });
  });

  it("BLIND lines carry neither expectedAtCount nor variance, not even as null", () => {
    ok(StocktakeLineBlindSchema, blindLine);
    bad(StocktakeLineBlindSchema, { ...blindLine, expectedAtCount: pieces("10") });
    bad(StocktakeLineBlindSchema, { ...blindLine, variance: pieces("-3") });
    bad(StocktakeLineBlindSchema, { ...blindLine, expectedAtCount: null });
    bad(StocktakeLineBlindSchema, { ...blindLine, variance: null });
    bad(StocktakeLineResponseSchema, { ...blindLine, expectedAtCount: pieces("10"), variance: null });
  });

  it("FULL lines carry expectedAtCount and a variance that is null until posting", () => {
    ok(StocktakeLineFullSchema, fullLine);
    ok(StocktakeLineFullSchema, { ...fullLine, variance: pieces("-3") });
    bad(StocktakeLineFullSchema, { ...fullLine, expectedAtCount: undefined });
    bad(StocktakeLineFullSchema, { ...blindLine, visibility: "FULL" });
    bad(StocktakeLineFullSchema, { ...fullLine, balanceVersionAtCount: 2 });
    ok(StocktakeLinesResponseSchema, { items: [fullLine], nextCursor: null });
    bad(StocktakeLinesResponseSchema, { items: [fullLine, blindLine], nextCursor: null });
  });

  it("keeps a line change in one visibility", () => {
    ok(StocktakeLineChangeResponseSchema, { stocktake, line: fullLine, changed: true });
    ok(StocktakeLineChangeResponseSchema, {
      stocktake: { ...stocktake, visibility: "BLIND" },
      line: blindLine,
      changed: true,
    });
    bad(StocktakeLineChangeResponseSchema, {
      stocktake: { ...stocktake, visibility: "BLIND" },
      line: fullLine,
      changed: true,
    });
    bad(StocktakeLineChangeResponseSchema, { stocktake, line: blindLine, changed: true });
  });

  it("post and cancel responses are FULL", () => {
    const correction = { ...documentMovement, type: "COUNT_CORRECTION", source: { kind: "STOCKTAKE", id: ID } };
    ok(PostStocktakeResponseSchema, { stocktake, movements: [correction], changed: true });
    bad(PostStocktakeResponseSchema, {
      stocktake: { ...stocktake, visibility: "BLIND" },
      movements: [],
      changed: false,
    });
    ok(CancelStocktakeResponseSchema, { stocktake, changed: false });
    bad(CancelStocktakeResponseSchema, { stocktake: { ...stocktake, visibility: "BLIND" }, changed: false });
  });
});

describe("STOCKTAKE_STALE details", () => {
  const ids = (count: number) =>
    Array.from({ length: count }, (_, index) => `0190a000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`);

  it("accepts 1 to 50 ascending IDs with a total of 1 to 1000 covering them", () => {
    ok(StocktakeStaleDetailsSchema, { staleVariantIds: [ID], staleLineCount: 1 });
    ok(StocktakeStaleDetailsSchema, { staleVariantIds: ids(50), staleLineCount: 1000 });
  });

  it("rejects malformed, unordered, oversized or leaky details", () => {
    for (const details of [
      { staleVariantIds: [], staleLineCount: 1 },
      { staleVariantIds: ids(51), staleLineCount: 51 },
      { staleVariantIds: [ID], staleLineCount: 1001 },
      { staleVariantIds: [ID], staleLineCount: 0 },
      { staleVariantIds: [ID, ID2], staleLineCount: 1 },
      { staleVariantIds: [ID2, ID], staleLineCount: 2 },
      { staleVariantIds: [ID, ID], staleLineCount: 2 },
      { staleVariantIds: ["not-a-uuid"], staleLineCount: 1 },
      { staleVariantIds: [ID], staleLineCount: 1.5 },
      { staleVariantIds: [ID], staleLineCount: 1, balanceVersions: [2] },
      { staleVariantIds: [ID], staleLineCount: 1, quantities: ["10"] },
      { staleVariantIds: [ID] },
    ]) {
      bad(StocktakeStaleDetailsSchema, details);
    }
  });

  it("is the details of a strict STOCKTAKE_STALE envelope", () => {
    const details = { staleVariantIds: [ID], staleLineCount: 1 };
    ok(StocktakeStaleErrorEnvelopeSchema, { error: { code: "STOCKTAKE_STALE", message: "stale", details } });
    bad(StocktakeStaleErrorEnvelopeSchema, { error: { code: "CONFLICT", message: "stale", details } });
    bad(StocktakeStaleErrorEnvelopeSchema, { error: { code: "STOCKTAKE_STALE", message: "stale" } });
  });
});
