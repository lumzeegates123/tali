import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import { BusinessDate, parseTimeZoneId } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import { parseLocationId } from "../location/index.js";
import type { InventoryAdjustmentKind, InventoryReasonNote } from "./index.js";
import {
  ADJUSTMENT_REASON_CODES,
  createGoodsReceipt,
  createInventoryAdjustment,
  createInventoryRecording,
  createOpeningBatch,
  INVENTORY_ADJUSTMENT_KINDS,
  parseAdjustmentReason,
  parseGoodsReceiptId,
  parseGoodsReceiptReference,
  parseInventoryAdjustmentId,
  parseInventoryNote,
  parseInventoryReasonNote,
  parseOpeningBatchId,
  reasonCodesFor,
  restoreGoodsReceipt,
  restoreInventoryAdjustment,
  restoreOpeningBatch,
  reverseGoodsReceipt,
  reverseInventoryAdjustment,
  WRITE_OFF_REASON_CODES,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const locationId = parseLocationId(uuid(2));
const actorMembershipId = parseMembershipId(uuid(4));
const reverserId = parseMembershipId(uuid(5));
const now = new Date("2026-10-08T10:00:00.000Z");
const later = new Date("2026-10-08T12:00:00.000Z");
const recording = createInventoryRecording({
  actorMembershipId,
  sourceChannel: "mobile",
  correlationId: "req-doc",
  now,
  timeZone: parseTimeZoneId("Africa/Lagos"),
});
const reason = parseInventoryReasonNote("Delivered to the wrong shop", "reason");

function expectDomainError(action: () => unknown, code: DomainErrorCode, field?: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  if (field !== undefined) expect((caught as DomainError).field).toBe(field);
}

describe("inventory text", () => {
  it("notes and reasons are 1 to 500 characters after trimming and NFC normalization", () => {
    expect(parseInventoryNote("  First stock take  ")).toBe("First stock take");
    expect(parseInventoryNote("x".repeat(500))).toHaveLength(500);
    expect(parseInventoryReasonNote("e\u0301")).toBe("\u00e9");
    expect(parseInventoryReasonNote("\u{1F4E6}".repeat(500))).toHaveLength(1000);
    for (const bad of ["", "   ", "\n\t", "x".repeat(501), "\uD800"]) {
      expectDomainError(() => parseInventoryNote(bad), "INVALID_VALUE", "note");
      expectDomainError(() => parseInventoryReasonNote(bad), "INVALID_VALUE", "reasonNote");
    }
  });

  it("a goods-receipt reference is 1 to 64 characters after trimming", () => {
    expect(parseGoodsReceiptReference(" DN-0042 ")).toBe("DN-0042");
    expect(parseGoodsReceiptReference("r".repeat(64))).toHaveLength(64);
    for (const bad of ["", "  ", "r".repeat(65)]) {
      expectDomainError(() => parseGoodsReceiptReference(bad), "INVALID_VALUE", "reference");
    }
  });
});

describe("OpeningBatch", () => {
  it("is a header only, with no status, and records actor, channel and time", () => {
    const batch = createOpeningBatch({
      id: parseOpeningBatchId(uuid(20)),
      businessId,
      locationId,
      note: parseInventoryNote("Shop opening"),
      recording,
    });
    expect(batch).toMatchObject({ businessId, locationId, note: "Shop opening", actorMembershipId });
    expect(batch).not.toHaveProperty("status");
    expect(batch.businessDate.equals(BusinessDate.of(2026, 10, 8))).toBe(true);
    expect(Object.isFrozen(batch)).toBe(true);
    expect(batch.occurredAt).not.toBe(recording.occurredAt);
  });

  it("restores and validates stored values", () => {
    const stored = { id: parseOpeningBatchId(uuid(20)), businessId, locationId, ...recording };
    expect(restoreOpeningBatch(stored).note).toBeUndefined();
    expectDomainError(() => restoreOpeningBatch({ ...stored, note: "   " }), "INVALID_VALUE", "note");
    expectDomainError(
      () => restoreOpeningBatch({ ...stored, recordedAt: new Date(now.getTime() - 1) }),
      "INVALID_VALUE",
      "recordedAt",
    );
  });
});

describe("GoodsReceipt", () => {
  const receipt = createGoodsReceipt({
    id: parseGoodsReceiptId(uuid(21)),
    businessId,
    locationId,
    reference: parseGoodsReceiptReference("DN-1"),
    recording,
  });

  it("is created POSTED with its optional reference", () => {
    expect(receipt).toMatchObject({ status: "POSTED", reference: "DN-1" });
    expect(receipt.reversedAt).toBeUndefined();
  });

  it("goes POSTED to REVERSED with who, when and the required reason", () => {
    const reversed = reverseGoodsReceipt({ receipt, reversedByMembershipId: reverserId, reason, now: later });
    expect(reversed).toMatchObject({
      status: "REVERSED",
      reversedByMembershipId: reverserId,
      reversalReason: "Delivered to the wrong shop",
      reference: "DN-1",
    });
    expect(reversed.reversedAt).toEqual(later);
    expect(receipt.status).toBe("POSTED");
  });

  it("never creates a second REVERSED transition", () => {
    const reversed = reverseGoodsReceipt({ receipt, reversedByMembershipId: reverserId, reason, now: later });
    expectDomainError(
      () => reverseGoodsReceipt({ receipt: reversed, reversedByMembershipId: reverserId, reason, now: later }),
      "INVALID_TRANSITION",
    );
  });

  it("requires a valid reversal reason", () => {
    expectDomainError(
      () =>
        reverseGoodsReceipt({
          receipt,
          reversedByMembershipId: reverserId,
          reason: "  " as InventoryReasonNote,
          now: later,
        }),
      "INVALID_VALUE",
      "reason",
    );
  });

  it("restores only when the reversal columns agree with the status", () => {
    const stored = { id: receipt.id, businessId, locationId, status: "POSTED", ...recording };
    expect(restoreGoodsReceipt(stored).status).toBe("POSTED");
    const reversedColumns = { reversedAt: later, reversedByMembershipId: reverserId, reversalReason: "Wrong shop" };
    expect(restoreGoodsReceipt({ ...stored, status: "REVERSED", ...reversedColumns }).reversalReason).toBe(
      "Wrong shop",
    );
    expectDomainError(() => restoreGoodsReceipt({ ...stored, ...reversedColumns }), "INVALID_VALUE", "status");
    expectDomainError(() => restoreGoodsReceipt({ ...stored, status: "REVERSED" }), "INVALID_VALUE", "status");
    expectDomainError(
      () => restoreGoodsReceipt({ ...stored, status: "REVERSED", ...reversedColumns, reversalReason: undefined }),
      "INVALID_VALUE",
      "status",
    );
    expectDomainError(() => restoreGoodsReceipt({ ...stored, status: "VOID" }), "INVALID_VALUE", "status");
    expectDomainError(
      () => restoreGoodsReceipt({ ...stored, status: "REVERSED", ...reversedColumns, reversalReason: " " }),
      "INVALID_VALUE",
      "reversalReason",
    );
    expectDomainError(
      () => restoreGoodsReceipt({ ...stored, reference: "r".repeat(65) }),
      "INVALID_VALUE",
      "reference",
    );
  });
});

describe("adjustment reasons", () => {
  it("has the closed reason lists of ADR-008 section 11", () => {
    expect(INVENTORY_ADJUSTMENT_KINDS).toEqual(["ADJUSTMENT", "WRITE_OFF"]);
    expect(ADJUSTMENT_REASON_CODES).toEqual(["FOUND_STOCK", "DATA_ENTRY_CORRECTION", "OTHER"]);
    expect(WRITE_OFF_REASON_CODES).toEqual(["DAMAGED", "EXPIRED", "SPOILED", "THEFT_OR_LOSS", "OTHER"]);
  });

  const allCodes = [...new Set([...ADJUSTMENT_REASON_CODES, ...WRITE_OFF_REASON_CODES])];
  const matrix = INVENTORY_ADJUSTMENT_KINDS.flatMap((kind) => allCodes.map((code) => [kind, code] as const));

  it.each(matrix)("%s with %s is valid only when the code is in the kind's list", (kind, code) => {
    const valid = (reasonCodesFor(kind) as readonly string[]).includes(code);
    const action = () => parseAdjustmentReason({ kind, reasonCode: code, reasonNote: "Counted again" });
    if (valid) {
      expect(action()).toEqual({ reasonCode: code, reasonNote: "Counted again" });
    } else {
      expectDomainError(action, "INVALID_VALUE", "reasonCode");
    }
  });

  it.each(INVENTORY_ADJUSTMENT_KINDS)("%s: non-OTHER codes need no note", (kind) => {
    for (const code of reasonCodesFor(kind).filter((candidate) => candidate !== "OTHER")) {
      expect(parseAdjustmentReason({ kind, reasonCode: code })).toEqual({ reasonCode: code });
    }
  });

  it.each(INVENTORY_ADJUSTMENT_KINDS)("%s: OTHER requires a non-blank note of at most 500 characters", (kind) => {
    expectDomainError(() => parseAdjustmentReason({ kind, reasonCode: "OTHER" }), "INVALID_VALUE", "reasonNote");
    expectDomainError(
      () => parseAdjustmentReason({ kind, reasonCode: "OTHER", reasonNote: "   " }),
      "INVALID_VALUE",
      "reasonNote",
    );
    expectDomainError(
      () => parseAdjustmentReason({ kind, reasonCode: "OTHER", reasonNote: "n".repeat(501) }),
      "INVALID_VALUE",
      "reasonNote",
    );
    expect(parseAdjustmentReason({ kind, reasonCode: "OTHER", reasonNote: " Flood " })).toEqual({
      reasonCode: "OTHER",
      reasonNote: "Flood",
    });
    expect(parseAdjustmentReason({ kind, reasonCode: "OTHER", reasonNote: "n".repeat(500) }).reasonNote).toHaveLength(
      500,
    );
  });

  it("rejects unknown kinds and codes", () => {
    expectDomainError(
      () => parseAdjustmentReason({ kind: "COUNT_CORRECTION" as InventoryAdjustmentKind, reasonCode: "OTHER" }),
      "INVALID_VALUE",
      "kind",
    );
    expectDomainError(
      () => parseAdjustmentReason({ kind: "ADJUSTMENT", reasonCode: "found_stock" }),
      "INVALID_VALUE",
      "reasonCode",
    );
  });
});

describe("InventoryAdjustment", () => {
  const adjustment = createInventoryAdjustment({
    id: parseInventoryAdjustmentId(uuid(22)),
    businessId,
    locationId,
    kind: "WRITE_OFF",
    reason: parseAdjustmentReason({ kind: "WRITE_OFF", reasonCode: "EXPIRED" }),
    note: parseInventoryNote("Shelf check"),
    recording,
  });

  it("is created POSTED with its kind, reason and a separate general note", () => {
    expect(adjustment).toMatchObject({
      kind: "WRITE_OFF",
      reasonCode: "EXPIRED",
      note: "Shelf check",
      status: "POSTED",
    });
    expect(adjustment.reasonNote).toBeUndefined();
  });

  it("rejects a reason that does not belong to its kind", () => {
    expectDomainError(
      () =>
        createInventoryAdjustment({
          id: parseInventoryAdjustmentId(uuid(23)),
          businessId,
          locationId,
          kind: "ADJUSTMENT",
          reason: { reasonCode: "EXPIRED" },
          recording,
        }),
      "INVALID_VALUE",
      "reasonCode",
    );
  });

  it("goes POSTED to REVERSED once", () => {
    const reversed = reverseInventoryAdjustment({ adjustment, reversedByMembershipId: reverserId, reason, now: later });
    expect(reversed).toMatchObject({ status: "REVERSED", kind: "WRITE_OFF", reasonCode: "EXPIRED" });
    expectDomainError(
      () =>
        reverseInventoryAdjustment({ adjustment: reversed, reversedByMembershipId: reverserId, reason, now: later }),
      "INVALID_TRANSITION",
    );
  });

  it("restores and validates stored values", () => {
    const stored = {
      id: adjustment.id,
      businessId,
      locationId,
      kind: "ADJUSTMENT",
      reasonCode: "OTHER",
      reasonNote: "Supplier recount",
      status: "POSTED",
      ...recording,
    };
    expect(restoreInventoryAdjustment(stored)).toMatchObject({ kind: "ADJUSTMENT", reasonNote: "Supplier recount" });
    expectDomainError(() => restoreInventoryAdjustment({ ...stored, kind: "STOCKTAKE" }), "INVALID_VALUE", "kind");
    expectDomainError(
      () => restoreInventoryAdjustment({ ...stored, reasonNote: undefined }),
      "INVALID_VALUE",
      "reasonNote",
    );
    expectDomainError(
      () => restoreInventoryAdjustment({ ...stored, reasonCode: "SPOILED" }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(() => restoreInventoryAdjustment({ ...stored, note: "" }), "INVALID_VALUE", "note");
  });
});
