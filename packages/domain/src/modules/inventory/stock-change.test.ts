import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import type { UnitCode } from "../../kernel/index.js";
import { KernelError, parseTimeZoneId, parseUnitCode, Quantity } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import { parseProductPackId, parseProductVariantId } from "../catalog/index.js";
import { parseLocationId } from "../location/index.js";
import type {
  AdjustmentReason,
  InventoryMovement,
  InventoryMovementId,
  InventoryMovementSource,
  InventoryMovementType,
  StockBalance,
  StockChangeLine,
} from "./index.js";
import {
  createInventoryRecording,
  emptyStockBalance,
  parseAdjustmentReason,
  parseGoodsReceiptId,
  parseInventoryAdjustmentId,
  parseInventoryMovementId,
  parseInventoryReasonNote,
  parseOpeningBatchId,
  parsePackSnapshot,
  parseStocktakeId,
  planCountCorrections,
  planStockChange,
  restoreMovement,
  restoreStockBalance,
  reverseDocumentMovements,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const otherBusinessId = parseBusinessId(uuid(6));
const locationId = parseLocationId(uuid(2));
const otherLocationId = parseLocationId(uuid(7));
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const recording = createInventoryRecording({
  actorMembershipId: parseMembershipId(uuid(4)),
  sourceChannel: "web",
  correlationId: "req-stock",
  now: new Date("2026-10-08T10:00:00.000Z"),
  timeZone: parseTimeZoneId("Africa/Lagos"),
});
const reversalRecording = createInventoryRecording({
  actorMembershipId: parseMembershipId(uuid(5)),
  sourceChannel: "web",
  correlationId: "req-reverse",
  now: new Date("2026-10-08T11:00:00.000Z"),
  timeZone: parseTimeZoneId("Africa/Lagos"),
});

const variantA = parseProductVariantId(uuid(0x0a));
const variantB = parseProductVariantId(uuid(0x0b));
const variantC = parseProductVariantId(uuid(0x0c));

const SOURCES: Readonly<Record<InventoryMovementType, InventoryMovementSource>> = {
  OPENING: { kind: "OPENING_BATCH", id: parseOpeningBatchId(uuid(0x20)) },
  PURCHASE_RECEIPT: { kind: "GOODS_RECEIPT", id: parseGoodsReceiptId(uuid(0x21)) },
  ADJUSTMENT: { kind: "ADJUSTMENT", id: parseInventoryAdjustmentId(uuid(0x22)) },
  WRITE_OFF: { kind: "ADJUSTMENT", id: parseInventoryAdjustmentId(uuid(0x23)) },
  COUNT_CORRECTION: { kind: "STOCKTAKE", id: parseStocktakeId(uuid(0x24)) },
};

const REASONS: Readonly<Record<InventoryMovementType, AdjustmentReason | undefined>> = {
  OPENING: undefined,
  PURCHASE_RECEIPT: undefined,
  ADJUSTMENT: parseAdjustmentReason({ kind: "ADJUSTMENT", reasonCode: "DATA_ENTRY_CORRECTION" }),
  WRITE_OFF: parseAdjustmentReason({ kind: "WRITE_OFF", reasonCode: "SPOILED" }),
  COUNT_CORRECTION: undefined,
};

const reversalReason = parseInventoryReasonNote("Posted against the wrong delivery", "reason");
const quantity = (minor: bigint, unit: UnitCode = PIECE): Quantity => Quantity.ofMinor(minor, unit);
const movementId = (n: number): InventoryMovementId => parseInventoryMovementId(uuid(0x1000 + n));

function balance(variantId: ProductVariantId, minor: bigint, version: number, unit: UnitCode = PIECE): StockBalance {
  if (version === 0) return emptyStockBalance({ businessId, locationId, variantId, stockUnit: unit });
  return restoreStockBalance({
    businessId,
    locationId,
    variantId,
    quantity: quantity(minor, unit),
    version,
    lastMovementId: parseInventoryMovementId(uuid(0x9000 + version)),
  });
}

function line(n: number, variantId: ProductVariantId, minor: bigint, unit: UnitCode = PIECE): StockChangeLine {
  return { movementId: movementId(n), variantId, delta: quantity(minor, unit) };
}

function plan(type: InventoryMovementType, lines: readonly StockChangeLine[], balances: readonly StockBalance[]) {
  const reason = REASONS[type];
  return planStockChange({
    businessId,
    locationId,
    type,
    source: SOURCES[type],
    lines,
    balances,
    ...(reason === undefined ? {} : { reason }),
    recording,
  });
}

function reverse(originals: readonly InventoryMovement[], balances: readonly StockBalance[], offset = 500) {
  return reverseDocumentMovements({
    originals,
    balances,
    reversalMovementIds: new Map(originals.map((original, index) => [original.id, movementId(offset + index)])),
    reason: reversalReason,
    recording: reversalRecording,
  });
}

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

function at<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

/** Deterministic pseudo-random sequence for property-style checks (tests only). */
function* lcg(seed: bigint): Generator<bigint> {
  let state = seed;
  for (;;) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    yield state >> 33n;
  }
}

describe("planStockChange: opening", () => {
  it("records a positive opening on a stock item with no movement", () => {
    const result = plan("OPENING", [line(1, variantA, 40n)], [balance(variantA, 0n, 0)]);
    expect(result.movements).toHaveLength(1);
    const [movement] = result.movements;
    expect(movement).toMatchObject({
      type: "OPENING",
      variantId: variantA,
      balanceVersion: 1,
      source: SOURCES.OPENING,
    });
    expect(movement?.balanceAfter.amountMinor).toBe(40n);
    expect(movement?.reasonCode).toBeUndefined();
    expect(result.balances[0]).toMatchObject({ version: 1, lastMovementId: movement?.id });
    expect(result.balances[0]?.quantity.amountMinor).toBe(40n);
  });

  it("rejects a second opening, or an opening after any movement, with INVALID_TRANSITION", () => {
    expectDomainError(
      () => plan("OPENING", [line(1, variantA, 40n)], [balance(variantA, 40n, 1)]),
      "INVALID_TRANSITION",
    );
    expectDomainError(() => plan("OPENING", [line(1, variantA, 5n)], [balance(variantA, 0n, 3)]), "INVALID_TRANSITION");
  });

  it("rejects a non-positive opening line", () => {
    expectDomainError(
      () => plan("OPENING", [line(1, variantA, -1n)], [balance(variantA, 0n, 0)]),
      "INVALID_VALUE",
      "quantity",
    );
    expectDomainError(
      () => plan("OPENING", [line(1, variantA, 0n)], [balance(variantA, 0n, 0)]),
      "INVALID_VALUE",
      "quantity",
    );
  });

  it("cannot be reversed", () => {
    const opening = plan("OPENING", [line(1, variantA, 40n)], [balance(variantA, 0n, 0)]);
    expectDomainError(() => reverse(opening.movements, opening.balances), "INVALID_TRANSITION", "originals");
  });
});

describe("planStockChange: goods receipts", () => {
  it("adds exact positive quantities, including fractional stock units", () => {
    const result = plan("PURCHASE_RECEIPT", [line(1, variantA, 1500n, KG)], [balance(variantA, 250n, 2, KG)]);
    expect(result.movements[0]?.balanceAfter.equals(quantity(1750n, KG))).toBe(true);
    expect(result.movements[0]?.balanceVersion).toBe(3);
  });

  it("rejects non-positive receipt lines", () => {
    expectDomainError(
      () => plan("PURCHASE_RECEIPT", [line(1, variantA, -2n)], [balance(variantA, 10n, 1)]),
      "INVALID_VALUE",
      "quantity",
    );
  });

  it("carries a valid pack snapshot onto the original movement", () => {
    const pack = parsePackSnapshot({
      packId: parseProductPackId(uuid(0x30)),
      name: "Carton of 24",
      count: 2n,
      factorMinor: 24n,
    });
    const result = plan("PURCHASE_RECEIPT", [{ ...line(1, variantA, 48n), pack }], [balance(variantA, 0n, 0)]);
    expect(result.movements[0]?.pack).toEqual(pack);
    expectDomainError(
      () => plan("PURCHASE_RECEIPT", [{ ...line(1, variantA, 47n), pack }], [balance(variantA, 0n, 0)]),
      "INVALID_VALUE",
      "pack",
    );
  });
});

describe("planStockChange: adjustments", () => {
  it("accepts positive and negative lines in one document, each with the document reason", () => {
    const result = plan(
      "ADJUSTMENT",
      [line(1, variantA, 3n), line(2, variantB, -4n)],
      [balance(variantA, 1n, 1), balance(variantB, 10n, 5)],
    );
    expect(result.movements.map((movement) => movement.delta.amountMinor)).toEqual([3n, -4n]);
    expect(result.movements.map((movement) => movement.balanceAfter.amountMinor)).toEqual([4n, 6n]);
    expect(result.movements.map((movement) => movement.balanceVersion)).toEqual([2, 6]);
    expect(result.movements.every((movement) => movement.reasonCode === "DATA_ENTRY_CORRECTION")).toBe(true);
  });

  it("rejects a zero line", () => {
    expectDomainError(
      () => plan("ADJUSTMENT", [line(1, variantA, 0n)], [balance(variantA, 1n, 1)]),
      "INVALID_VALUE",
      "quantity",
    );
  });

  it("requires a reason valid for its kind, and OTHER needs a note", () => {
    const common = {
      businessId,
      locationId,
      lines: [line(1, variantA, 1n)],
      balances: [balance(variantA, 1n, 1)],
      recording,
    };
    expectDomainError(
      () => planStockChange({ ...common, type: "ADJUSTMENT", source: SOURCES.ADJUSTMENT }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(
      () =>
        planStockChange({
          ...common,
          type: "ADJUSTMENT",
          source: SOURCES.ADJUSTMENT,
          reason: { reasonCode: "DAMAGED" },
        }),
      "INVALID_VALUE",
      "reasonCode",
    );
    expectDomainError(
      () =>
        planStockChange({ ...common, type: "ADJUSTMENT", source: SOURCES.ADJUSTMENT, reason: { reasonCode: "OTHER" } }),
      "INVALID_VALUE",
      "reasonNote",
    );
    const other = planStockChange({
      ...common,
      type: "ADJUSTMENT",
      source: SOURCES.ADJUSTMENT,
      reason: parseAdjustmentReason({ kind: "ADJUSTMENT", reasonCode: "OTHER", reasonNote: "Recounted" }),
    });
    expect(other.movements[0]).toMatchObject({ reasonCode: "OTHER", reasonNote: "Recounted" });
    expectDomainError(
      () =>
        planStockChange({
          ...common,
          type: "PURCHASE_RECEIPT",
          source: SOURCES.PURCHASE_RECEIPT,
          reason: { reasonCode: "OTHER" },
        }),
      "INVALID_VALUE",
      "reasonCode",
    );
  });
});

describe("planStockChange: write-offs", () => {
  it("records the negated magnitude as a negative WRITE_OFF movement", () => {
    const magnitude = quantity(6n);
    const result = plan(
      "WRITE_OFF",
      [{ movementId: movementId(1), variantId: variantA, delta: magnitude.negate() }],
      [balance(variantA, 10n, 1)],
    );
    expect(result.movements[0]).toMatchObject({ type: "WRITE_OFF", reasonCode: "SPOILED", balanceVersion: 2 });
    expect(result.movements[0]?.delta.amountMinor).toBe(-6n);
    expect(result.balances[0]?.quantity.amountMinor).toBe(4n);
  });

  it("rejects a positive write-off line", () => {
    expectDomainError(
      () => plan("WRITE_OFF", [line(1, variantA, 6n)], [balance(variantA, 10n, 1)]),
      "INVALID_VALUE",
      "quantity",
    );
  });

  it.each(["DAMAGED", "EXPIRED", "SPOILED", "THEFT_OR_LOSS"] as const)("accepts reason %s", (reasonCode) => {
    const result = planStockChange({
      businessId,
      locationId,
      type: "WRITE_OFF",
      source: SOURCES.WRITE_OFF,
      lines: [line(1, variantA, -1n)],
      balances: [balance(variantA, 1n, 1)],
      reason: parseAdjustmentReason({ kind: "WRITE_OFF", reasonCode }),
      recording,
    });
    expect(result.movements[0]?.reasonCode).toBe(reasonCode);
  });

  it("accepts OTHER only with a note", () => {
    const common = {
      businessId,
      locationId,
      type: "WRITE_OFF" as const,
      source: SOURCES.WRITE_OFF,
      lines: [line(1, variantA, -1n)],
      balances: [balance(variantA, 1n, 1)],
      recording,
    };
    expectDomainError(
      () => planStockChange({ ...common, reason: { reasonCode: "OTHER" } }),
      "INVALID_VALUE",
      "reasonNote",
    );
    const result = planStockChange({
      ...common,
      reason: parseAdjustmentReason({ kind: "WRITE_OFF", reasonCode: "OTHER", reasonNote: "Burst bag" }),
    });
    expect(result.movements[0]).toMatchObject({ reasonCode: "OTHER", reasonNote: "Burst bag" });
  });
});

describe("Build 2 negative-stock policy", () => {
  it("allows a decrease to exactly zero", () => {
    const result = plan("ADJUSTMENT", [line(1, variantA, -10n)], [balance(variantA, 10n, 1)]);
    expect(result.balances[0]?.quantity.isZero()).toBe(true);
    expect(
      plan("WRITE_OFF", [line(1, variantA, -10n)], [balance(variantA, 10n, 1)]).balances[0]?.quantity.isZero(),
    ).toBe(true);
  });

  it("rejects an adjustment decrease below zero", () => {
    expectDomainError(
      () => plan("ADJUSTMENT", [line(1, variantA, -11n)], [balance(variantA, 10n, 1)]),
      "INSUFFICIENT_STOCK",
    );
  });

  it("rejects a write-off below zero, including from a missing balance", () => {
    expectDomainError(
      () => plan("WRITE_OFF", [line(1, variantA, -11n)], [balance(variantA, 10n, 1)]),
      "INSUFFICIENT_STOCK",
    );
    expectDomainError(
      () => plan("WRITE_OFF", [line(1, variantA, -1n)], [balance(variantA, 0n, 0)]),
      "INSUFFICIENT_STOCK",
    );
  });

  it("rejects a receipt reversal below zero", () => {
    const receipt = plan("PURCHASE_RECEIPT", [line(1, variantA, 10n)], [balance(variantA, 0n, 0)]);
    const afterSale = restoreStockBalance({ ...at(receipt.balances), quantity: quantity(4n), version: 2 });
    expectDomainError(() => reverse(receipt.movements, [afterSale]), "INSUFFICIENT_STOCK");
  });

  it("rejects the reversal of a positive adjustment below zero", () => {
    const found = plan("ADJUSTMENT", [line(1, variantA, 5n)], [balance(variantA, 0n, 0)]);
    const later = restoreStockBalance({ ...at(found.balances), quantity: quantity(2n), version: 3 });
    expectDomainError(() => reverse(found.movements, [later]), "INSUFFICIENT_STOCK");
  });

  it("rejects the whole document when any line would go below zero, regardless of line order", () => {
    const balances = [balance(variantA, 10n, 1), balance(variantB, 1n, 1)];
    for (const lines of [
      [line(1, variantA, -2n), line(2, variantB, -2n)],
      [line(2, variantB, -2n), line(1, variantA, -2n)],
    ]) {
      expectDomainError(() => plan("ADJUSTMENT", lines, balances), "INSUFFICIENT_STOCK");
    }
  });

  it("always allows increases, even onto a negative balance", () => {
    const negative = balance(variantA, -5n, 2);
    expect(plan("PURCHASE_RECEIPT", [line(1, variantA, 2n)], [negative]).balances[0]?.quantity.amountMinor).toBe(-3n);
    expect(plan("ADJUSTMENT", [line(1, variantA, 1n)], [negative]).balances[0]?.quantity.amountMinor).toBe(-4n);
    const writeOff = plan("WRITE_OFF", [line(1, variantA, -3n)], [balance(variantA, 3n, 1)]);
    const negativeAgain = restoreStockBalance({ ...at(writeOff.balances), quantity: quantity(-1n) });
    expect(reverse(writeOff.movements, [negativeAgain]).balances[0]?.quantity.amountMinor).toBe(2n);
  });
});

describe("planStockChange: lines and balances", () => {
  it("returns movements and balances in ascending variant order with exact versions", () => {
    const result = plan(
      "PURCHASE_RECEIPT",
      [line(3, variantC, 3n), line(1, variantA, 1n), line(2, variantB, 2n)],
      [balance(variantB, 20n, 4), balance(variantC, 0n, 0), balance(variantA, 10n, 1)],
    );
    expect(result.movements.map((movement) => movement.variantId)).toEqual([variantA, variantB, variantC]);
    expect(result.balances.map((next) => next.variantId)).toEqual([variantA, variantB, variantC]);
    expect(result.movements.map((movement) => movement.balanceVersion)).toEqual([2, 5, 1]);
    expect(result.balances.map((next) => next.version)).toEqual([2, 5, 1]);
    expect(result.balances.map((next) => next.lastMovementId)).toEqual(result.movements.map((movement) => movement.id));
    expect(Object.isFrozen(result.movements)).toBe(true);
  });

  it("rejects empty documents, more than 200 lines, duplicate variants and duplicate movement ids", () => {
    expectDomainError(() => plan("PURCHASE_RECEIPT", [], []), "INVALID_VALUE", "lines");
    const many = Array.from({ length: 201 }, (_, index) => {
      const variantId = parseProductVariantId(uuid(0x5000 + index));
      return { line: line(index, variantId, 1n), balance: balance(variantId, 0n, 0) };
    });
    expectDomainError(
      () =>
        plan(
          "PURCHASE_RECEIPT",
          many.map((entry) => entry.line),
          many.map((entry) => entry.balance),
        ),
      "INVALID_VALUE",
      "lines",
    );
    expect(
      plan(
        "PURCHASE_RECEIPT",
        many.slice(0, 200).map((entry) => entry.line),
        many.slice(0, 200).map((entry) => entry.balance),
      ).movements,
    ).toHaveLength(200);
    expectDomainError(
      () => plan("PURCHASE_RECEIPT", [line(1, variantA, 1n), line(2, variantA, 1n)], [balance(variantA, 0n, 0)]),
      "INVALID_VALUE",
      "lines",
    );
    expectDomainError(
      () =>
        plan(
          "PURCHASE_RECEIPT",
          [line(1, variantA, 1n), line(1, variantB, 1n)],
          [balance(variantA, 0n, 0), balance(variantB, 0n, 0)],
        ),
      "INVALID_VALUE",
      "lines",
    );
  });

  it("requires exactly the locked balance of every line, at the same business and location", () => {
    expectDomainError(() => plan("PURCHASE_RECEIPT", [line(1, variantA, 1n)], []), "INVALID_VALUE", "balances");
    expectDomainError(
      () => plan("PURCHASE_RECEIPT", [line(1, variantA, 1n)], [balance(variantA, 0n, 0), balance(variantB, 0n, 0)]),
      "INVALID_VALUE",
      "balances",
    );
    expectDomainError(
      () => plan("PURCHASE_RECEIPT", [line(1, variantA, 1n)], [balance(variantA, 0n, 0), balance(variantA, 0n, 0)]),
      "INVALID_VALUE",
      "balances",
    );
    for (const foreign of [
      emptyStockBalance({ businessId: otherBusinessId, locationId, variantId: variantA, stockUnit: PIECE }),
      emptyStockBalance({ businessId, locationId: otherLocationId, variantId: variantA, stockUnit: PIECE }),
    ]) {
      expectDomainError(
        () => plan("PURCHASE_RECEIPT", [line(1, variantA, 1n)], [foreign]),
        "INVALID_VALUE",
        "balances",
      );
    }
  });

  it("rejects a line in another unit than the stock item's balance", () => {
    expect(() => plan("PURCHASE_RECEIPT", [line(1, variantA, 1n, KG)], [balance(variantA, 0n, 0)])).toThrow(
      KernelError,
    );
  });

  it("rejects a source document of the wrong kind", () => {
    expectDomainError(
      () =>
        planStockChange({
          businessId,
          locationId,
          type: "PURCHASE_RECEIPT",
          source: SOURCES.OPENING,
          lines: [line(1, variantA, 1n)],
          balances: [balance(variantA, 0n, 0)],
          recording,
        }),
      "INVALID_VALUE",
      "source",
    );
  });

  it("rejects COUNT_CORRECTION: that type is planned by planCountCorrections", () => {
    expectDomainError(
      () =>
        planStockChange({
          businessId,
          locationId,
          type: "COUNT_CORRECTION",
          source: SOURCES.COUNT_CORRECTION,
          lines: [line(1, variantA, 1n)],
          balances: [balance(variantA, 0n, 0)],
          recording,
        }),
      "INVALID_VALUE",
      "type",
    );
  });
});

describe("reverseDocumentMovements", () => {
  const pack = parsePackSnapshot({
    packId: parseProductPackId(uuid(0x30)),
    name: "Crate",
    count: 2n,
    factorMinor: 12n,
  });
  const receipt = plan(
    "PURCHASE_RECEIPT",
    [line(2, variantB, 5n), { ...line(1, variantA, 24n), pack }, line(3, variantC, 7n)],
    [balance(variantA, 1n, 1), balance(variantB, 0n, 0), balance(variantC, 3n, 2)],
  );

  it("produces one exact negation per original, in ascending variant order", () => {
    const reversal = reverse([...receipt.movements].reverse(), receipt.balances);
    expect(reversal.movements.map((movement) => movement.variantId)).toEqual([variantA, variantB, variantC]);
    reversal.movements.forEach((movement, index) => {
      const original = at(receipt.movements, index);
      expect(movement.delta.equals(original.delta.negate())).toBe(true);
      expect(movement).toMatchObject({
        businessId: original.businessId,
        locationId: original.locationId,
        variantId: original.variantId,
        type: "PURCHASE_RECEIPT",
        source: original.source,
        reversesMovementId: original.id,
        reasonNote: "Posted against the wrong delivery",
        balanceVersion: original.balanceVersion + 1,
        correlationId: "req-reverse",
      });
      expect(movement.pack).toBeUndefined();
      expect(movement.reasonCode).toBeUndefined();
    });
    expect(reversal.balances.map((next) => next.quantity.amountMinor)).toEqual([1n, 0n, 3n]);
    expect(reversal.balances.map((next) => next.version)).toEqual([3, 2, 4]);
  });

  it("reverses adjustments and write-offs with the opposite sign and drops the reason code", () => {
    const adjustment = plan(
      "ADJUSTMENT",
      [line(1, variantA, 4n), line(2, variantB, -3n)],
      [balance(variantA, 0n, 0), balance(variantB, 3n, 1)],
    );
    const reversed = reverse(adjustment.movements, adjustment.balances);
    expect(reversed.movements.map((movement) => movement.delta.amountMinor)).toEqual([-4n, 3n]);
    expect(reversed.movements.every((movement) => movement.reasonCode === undefined)).toBe(true);
    const writeOff = plan("WRITE_OFF", [line(1, variantA, -2n)], [balance(variantA, 2n, 1)]);
    const restored = reverse(writeOff.movements, writeOff.balances);
    expect(restored.movements[0]?.delta.amountMinor).toBe(2n);
    expect(restored.balances[0]?.quantity.amountMinor).toBe(2n);
  });

  it("never reverses a COUNT_CORRECTION", () => {
    const planned = planCountCorrections({
      businessId,
      locationId,
      stocktakeId: parseStocktakeId(uuid(0x24)),
      lines: [
        { variantId: variantA, counted: quantity(7n), balance: balance(variantA, 10n, 1), movementId: movementId(1) },
      ],
      recording,
    });
    expectDomainError(() => reverse(planned.movements, planned.balances), "INVALID_TRANSITION", "originals");
    expectDomainError(
      () =>
        reverse(
          [
            restoreMovement({
              id: movementId(2),
              businessId,
              locationId,
              variantId: variantA,
              type: "COUNT_CORRECTION",
              delta: quantity(-3n),
              balanceAfter: quantity(7n),
              balanceVersion: 2,
              source: SOURCES.COUNT_CORRECTION,
              ...recording,
            }),
          ],
          [balance(variantA, 7n, 2)],
        ),
      "INVALID_TRANSITION",
      "originals",
    );
  });

  it("never reverses a reversal", () => {
    const reversal = reverse(receipt.movements, receipt.balances);
    expectDomainError(() => reverse(reversal.movements, reversal.balances, 900), "INVALID_TRANSITION", "originals");
  });

  it("requires the originals of exactly one document", () => {
    const other = plan("PURCHASE_RECEIPT", [line(9, variantC, 1n)], [balance(variantC, 0n, 0)]);
    const foreignSource = {
      ...at(other.movements),
      source: { kind: "GOODS_RECEIPT" as const, id: parseGoodsReceiptId(uuid(0x99)) },
    };
    expectDomainError(
      () => reverse([at(receipt.movements), foreignSource], receipt.balances),
      "INVALID_VALUE",
      "originals",
    );
    expectDomainError(() => reverse([], []), "INVALID_VALUE", "originals");
    expectDomainError(
      () => reverse([at(receipt.movements), at(receipt.movements)], receipt.balances),
      "INVALID_VALUE",
      "originals",
    );
  });

  it("requires one new, distinct reversal movement id per original", () => {
    const originals = receipt.movements;
    const call = (ids: ReadonlyMap<InventoryMovementId, InventoryMovementId>) =>
      reverseDocumentMovements({
        originals,
        balances: receipt.balances,
        reversalMovementIds: ids,
        reason: reversalReason,
        recording: reversalRecording,
      });
    expectDomainError(
      () => call(new Map([[at(originals).id, movementId(700)]])),
      "INVALID_VALUE",
      "reversalMovementIds",
    );
    expectDomainError(
      () => call(new Map(originals.map((original) => [original.id, movementId(700)]))),
      "INVALID_VALUE",
      "reversalMovementIds",
    );
    expectDomainError(
      () => call(new Map(originals.map((original) => [original.id, original.id]))),
      "INVALID_VALUE",
      "reversalMovementIds",
    );
  });

  it("requires a valid reversal reason", () => {
    expectDomainError(
      () =>
        reverseDocumentMovements({
          originals: receipt.movements,
          balances: receipt.balances,
          reversalMovementIds: new Map(
            receipt.movements.map((original, index) => [original.id, movementId(800 + index)]),
          ),
          reason: " " as typeof reversalReason,
          recording: reversalRecording,
        }),
      "INVALID_VALUE",
      "reason",
    );
  });
});

describe("stock-change properties", () => {
  it("keeps exact running quantities and gap-free versions over random histories", () => {
    const random = lcg(7n);
    const next = (modulo: bigint): bigint => (random.next().value as bigint) % modulo;
    let id = 0;
    const opening = plan("OPENING", [line(id++, variantA, next(1_000_000n) + 1n, KG)], [balance(variantA, 0n, 0, KG)]);
    let current = at(opening.balances);
    let expected = at(opening.movements).delta.amountMinor;
    for (let step = 0; step < 400; step += 1) {
      const type = at(["PURCHASE_RECEIPT", "ADJUSTMENT", "WRITE_OFF"] as const, Number(next(3n)));
      const magnitude = next(500_000n) + 1n;
      const delta = type === "PURCHASE_RECEIPT" || (type === "ADJUSTMENT" && next(2n) === 0n) ? magnitude : -magnitude;
      const attempt = () => plan(type, [line(id++, variantA, delta, KG)], [current]);
      if (expected + delta < 0n) {
        expectDomainError(attempt, "INSUFFICIENT_STOCK");
        continue;
      }
      const result = attempt();
      expected += delta;
      expect(result.movements[0]?.balanceAfter.amountMinor).toBe(expected);
      expect(result.movements[0]?.balanceVersion).toBe(current.version + 1);
      current = at(result.balances);
      expect(current.quantity.amountMinor).toBe(expected);
      expect(current.quantity.unit).toBe(KG);
    }
    expect(current.version).toBeGreaterThan(1);
  });

  it("reversal is an exact round trip for random multi-line documents", () => {
    const random = lcg(11n);
    const next = (modulo: bigint): bigint => (random.next().value as bigint) % modulo;
    for (let run = 0; run < 100; run += 1) {
      const count = Number(next(6n)) + 1;
      const variants = Array.from({ length: count }, (_, index) =>
        parseProductVariantId(uuid(0x7000 + run * 16 + index)),
      );
      const before = variants.map((variantId) => {
        const minor = next(1_000n);
        return minor === 0n ? balance(variantId, 0n, 0) : balance(variantId, minor, Number(next(5n)) + 1);
      });
      const type = next(2n) === 0n ? "PURCHASE_RECEIPT" : "ADJUSTMENT";
      const lines = variants.map((variantId, index) => {
        const magnitude = next(1_000n) + 1n;
        const startMinor = at(before, index).quantity.amountMinor;
        const delta =
          type === "ADJUSTMENT" && next(2n) === 0n && startMinor > 0n ? -((magnitude % startMinor) + 1n) : magnitude;
        return line(run * 16 + index, variantId, delta);
      });
      const posted = plan(type, lines, before);
      const reversed = reverse(posted.movements, posted.balances, 10_000 + run * 16);
      reversed.balances.forEach((after) => {
        const start = at(before.filter((candidate) => candidate.variantId === after.variantId));
        expect(after.quantity.equals(start.quantity)).toBe(true);
        expect(after.version).toBe(start.version + 2);
      });
      reversed.movements.forEach((movement, index) => {
        expect(movement.delta.add(at(posted.movements, index).delta).isZero()).toBe(true);
      });
    }
  });

  it("output order does not depend on input order", () => {
    const random = lcg(19n);
    const next = (modulo: bigint): bigint => (random.next().value as bigint) % modulo;
    const variants = Array.from({ length: 12 }, (_, index) =>
      parseProductVariantId(uuid(0x8000 + Number(next(4096n)) * 16 + index)),
    );
    const lines = variants.map((variantId, index) => line(index, variantId, BigInt(index + 1)));
    const balances = variants.map((variantId) => balance(variantId, 0n, 0));
    const sorted = [...variants].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    const reference = plan("PURCHASE_RECEIPT", lines, balances);
    expect(reference.movements.map((movement) => movement.variantId)).toEqual(sorted);
    for (let run = 0; run < 50; run += 1) {
      const shuffled = [...lines];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Number(next(BigInt(index + 1)));
        [shuffled[index], shuffled[swap]] = [at(shuffled, swap), at(shuffled, index)];
      }
      expect(plan("PURCHASE_RECEIPT", shuffled, [...balances].reverse())).toEqual(reference);
    }
  });
});
