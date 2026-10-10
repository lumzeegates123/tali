import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import type { KernelErrorCode } from "../../kernel/index.js";
import { KernelError, parseTimeZoneId, parseUnitCode, Quantity } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import { parseProductVariantId } from "../catalog/index.js";
import { parseLocationId } from "../location/index.js";
import type { CountCorrectionLine, InventoryMovementId, StockBalance } from "./index.js";
import {
  createInventoryRecording,
  emptyStockBalance,
  MAX_STOCKTAKE_LINES,
  parseInventoryMovementId,
  parseStocktakeId,
  planCountCorrections,
  restoreMovement,
  restoreStockBalance,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const locationId = parseLocationId(uuid(2));
const stocktakeId = parseStocktakeId(uuid(0x24));
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const recording = createInventoryRecording({
  actorMembershipId: parseMembershipId(uuid(4)),
  sourceChannel: "web",
  correlationId: "req-count",
  now: new Date("2026-10-08T16:00:00.000Z"),
  timeZone: parseTimeZoneId("Africa/Lagos"),
});
const variantA = parseProductVariantId(uuid(0x0a));
const variantB = parseProductVariantId(uuid(0x0b));
const variantC = parseProductVariantId(uuid(0x0c));
const quantity = (minor: bigint, unit = PIECE): Quantity => Quantity.ofMinor(minor, unit);
const movementId = (n: number): InventoryMovementId => parseInventoryMovementId(uuid(0x1000 + n));

function balance(variantId: ProductVariantId, minor: bigint, version: number, unit = PIECE): StockBalance {
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

function line(
  n: number,
  variantId: ProductVariantId,
  countedMinor: bigint,
  currentMinor: bigint,
  version = 1,
  unit = PIECE,
): CountCorrectionLine {
  return {
    variantId,
    counted: quantity(countedMinor, unit),
    balance: balance(variantId, currentMinor, version, unit),
    movementId: movementId(n),
  };
}

function plan(lines: readonly CountCorrectionLine[]) {
  return planCountCorrections({ businessId, locationId, stocktakeId, lines, recording });
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

function expectKernelError(action: () => unknown, code: KernelErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KernelError);
  expect((caught as KernelError).code).toBe(code);
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

describe("planCountCorrections", () => {
  it("decreases 10 to 7 with delta -3 and balanceAfter 7", () => {
    const result = plan([line(1, variantA, 7n, 10n)]);
    expect(result.movements).toHaveLength(1);
    expect(result.variances).toEqual([{ variantId: variantA, variance: quantity(-3n) }]);
    expect(at(result.movements)).toMatchObject({
      type: "COUNT_CORRECTION",
      source: { kind: "STOCKTAKE", id: stocktakeId },
      balanceVersion: 2,
    });
    expect(at(result.movements).delta.amountMinor).toBe(-3n);
    expect(at(result.movements).balanceAfter.amountMinor).toBe(7n);
    expect(at(result.balances).quantity.amountMinor).toBe(7n);
    expect(at(result.movements).pack).toBeUndefined();
    expect(at(result.movements).reasonCode).toBeUndefined();
    expect(at(result.movements).reversesMovementId).toBeUndefined();
    expect(() => restoreMovement(at(result.movements))).not.toThrow();
  });

  it("increases 10 to 15 with delta +5 and balanceAfter 15", () => {
    const result = plan([line(1, variantA, 15n, 10n)]);
    expect(at(result.movements).delta.amountMinor).toBe(5n);
    expect(at(result.movements).balanceAfter.amountMinor).toBe(15n);
    expect(at(result.variances).variance.amountMinor).toBe(5n);
  });

  it("stores variance 0 and writes no movement when counted equals on-hand", () => {
    const result = plan([line(1, variantA, 10n, 10n)]);
    expect(result.movements).toEqual([]);
    expect(result.balances).toEqual([]);
    expect(result.variances).toEqual([{ variantId: variantA, variance: quantity(0n) }]);
  });

  it("corrects a negative balance to counted 0", () => {
    const result = plan([line(1, variantA, 0n, -2n, 2)]);
    expect(at(result.movements).delta.amountMinor).toBe(2n);
    expect(at(result.movements).balanceAfter.isZero()).toBe(true);
    expect(at(result.balances).quantity.isZero()).toBe(true);
  });

  it("accepts counted 0 from a positive balance without INSUFFICIENT_STOCK", () => {
    const result = plan([line(1, variantA, 0n, 10n)]);
    expect(at(result.movements).delta.amountMinor).toBe(-10n);
    expect(at(result.balances).quantity.isZero()).toBe(true);
  });

  it("rejects a negative counted quantity, a unit mismatch, duplicate variants and duplicate movement ids", () => {
    expectDomainError(
      () =>
        plan([
          {
            variantId: variantA,
            counted: quantity(-1n),
            balance: balance(variantA, 10n, 1),
            movementId: movementId(1),
          },
        ]),
      "INVALID_VALUE",
      "quantity",
    );
    expectKernelError(
      () =>
        plan([
          {
            variantId: variantA,
            counted: quantity(1n),
            balance: balance(variantA, 1n, 1, KG),
            movementId: movementId(1),
          },
        ]),
      "UNIT_MISMATCH",
    );
    expectDomainError(
      () =>
        plan([line(1, variantA, 1n, 0n, 0), { ...line(2, variantA, 2n, 0n, 0), balance: balance(variantA, 0n, 0) }]),
      "INVALID_VALUE",
      "lines",
    );
    expectDomainError(
      () => plan([line(1, variantA, 1n, 0n, 0), { ...line(1, variantB, 1n, 0n, 0), movementId: movementId(1) }]),
      "INVALID_VALUE",
      "lines",
    );
  });

  it("sorts output by variant ID independently of input order", () => {
    const result = plan([line(3, variantC, 3n, 1n), line(1, variantA, 1n, 0n, 0), line(2, variantB, 2n, 4n)]);
    expect(result.movements.map((movement) => movement.variantId)).toEqual([variantA, variantB, variantC]);
    expect(result.variances.map((row) => row.variantId)).toEqual([variantA, variantB, variantC]);
    expect(result.variances.map((row) => row.variance.amountMinor)).toEqual([1n, -2n, 2n]);
    for (const movement of result.movements) {
      expect(() => restoreMovement(movement)).not.toThrow();
    }
  });

  it("returns a variance for every line and movements only for non-zero variances", () => {
    const result = plan([line(1, variantA, 10n, 10n), line(2, variantB, 4n, 1n), line(3, variantC, 5n, 5n)]);
    expect(result.variances).toHaveLength(3);
    expect(result.movements).toHaveLength(1);
    expect(at(result.movements).variantId).toBe(variantB);
    expect(result.balances).toHaveLength(1);
  });

  it("rejects empty input and more than MAX_STOCKTAKE_LINES lines", () => {
    expectDomainError(() => plan([]), "INVALID_VALUE", "lines");
    const many = Array.from({ length: MAX_STOCKTAKE_LINES + 1 }, (_, index) => {
      const variantId = parseProductVariantId(uuid(0x5000 + index));
      return line(index, variantId, 1n, 0n, 0);
    });
    expectDomainError(() => plan(many), "INVALID_VALUE", "lines");
    expect(plan(many.slice(0, MAX_STOCKTAKE_LINES)).variances).toHaveLength(MAX_STOCKTAKE_LINES);
  });

  it("never raises INSUFFICIENT_STOCK: counted >= 0 is the resulting quantity", () => {
    expect(() => plan([line(1, variantA, 0n, 1_000_000n, 4)])).not.toThrow();
    expect(at(plan([line(1, variantA, 0n, 1_000_000n, 4)]).balances).quantity.isZero()).toBe(true);
  });
});

describe("planCountCorrections properties", () => {
  it("keeps current + delta == counted for random pairs, and writes nothing when variance is 0", () => {
    const random = lcg(23n);
    const next = (modulo: bigint): bigint => (random.next().value as bigint) % modulo;
    for (let step = 0; step < 400; step += 1) {
      const current = next(20_001n) - 10_000n;
      const counted = next(10_001n);
      const result = plan([line(step, variantA, counted, current, current === 0n ? 0 : 1)]);
      const variance = counted - current;
      expect(at(result.variances).variance.amountMinor).toBe(variance);
      if (variance === 0n) {
        expect(result.movements).toHaveLength(0);
        continue;
      }
      const movement = at(result.movements);
      expect(movement.delta.amountMinor).toBe(variance);
      expect(quantity(current).add(movement.delta).amountMinor).toBe(counted);
      expect(movement.balanceAfter.amountMinor).toBe(counted);
      expect(() => restoreMovement(movement)).not.toThrow();
    }
  });
});
