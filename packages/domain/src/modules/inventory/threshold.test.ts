import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import { KernelError, parseUnitCode, Quantity } from "../../kernel/index.js";
import { parseBusinessId } from "../business/index.js";
import { parseProductVariantId } from "../catalog/index.js";
import { parseLocationId } from "../location/index.js";
import type { StockThreshold } from "./index.js";
import {
  decideClearThreshold,
  decideSetThreshold,
  parseStockThresholdId,
  parseThresholdExpectedVersion,
  restoreStockThreshold,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const locationId = parseLocationId(uuid(2));
const variantId = parseProductVariantId(uuid(3));
const thresholdId = parseStockThresholdId(uuid(40));
const newId = parseStockThresholdId(uuid(41));
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const target = { businessId, locationId, variantId, stockUnit: PIECE };
const pieces = (minor: bigint): Quantity => Quantity.ofMinor(minor, PIECE);

function stored(version: number, minor?: bigint): StockThreshold {
  return restoreStockThreshold({
    id: thresholdId,
    businessId,
    locationId,
    variantId,
    ...(minor === undefined ? {} : { threshold: pieces(minor) }),
    version,
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

const set = (current: StockThreshold | undefined, expectedVersion: number, minor: bigint) =>
  decideSetThreshold({ current, expectedVersion, target, value: pieces(minor), newId });
const clear = (current: StockThreshold | undefined, expectedVersion: number) =>
  decideClearThreshold({ current, expectedVersion, target });

describe("StockThreshold", () => {
  it("persisted versions start at 1; the threshold is optional and never negative", () => {
    expect(stored(1, 5n).threshold?.amountMinor).toBe(5n);
    expect(stored(3).threshold).toBeUndefined();
    expect(stored(1, 0n).threshold?.isZero()).toBe(true);
    expectDomainError(() => stored(0, 5n), "INVALID_VALUE", "version");
    expectDomainError(() => stored(1, -1n), "INVALID_VALUE", "threshold");
  });

  it("expectedVersion accepts 0 and rejects negatives and fractions", () => {
    expect(parseThresholdExpectedVersion(0)).toBe(0);
    expect(parseThresholdExpectedVersion(7)).toBe(7);
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectDomainError(() => parseThresholdExpectedVersion(bad), "INVALID_VALUE", "expectedVersion");
    }
  });
});

describe("decideSetThreshold", () => {
  it("absent with expectedVersion 0 creates version 1", () => {
    const decision = set(undefined, 0, 12n);
    expect(decision.outcome).toBe("created");
    expect(decision.record).toMatchObject({ id: newId, businessId, locationId, variantId, version: 1 });
    expect(decision.record?.threshold?.amountMinor).toBe(12n);
    expect(Object.isFrozen(decision.record)).toBe(true);
  });

  it("absent with expectedVersion other than 0 is VERSION_CONFLICT", () => {
    expectDomainError(() => set(undefined, 1, 12n), "VERSION_CONFLICT", "expectedVersion");
  });

  it("existing (configured or cleared) with expectedVersion 0 is VERSION_CONFLICT", () => {
    expectDomainError(() => set(stored(1, 12n), 0, 12n), "VERSION_CONFLICT");
    expectDomainError(() => set(stored(2), 0, 12n), "VERSION_CONFLICT");
  });

  it("a stale version is VERSION_CONFLICT even when the value already holds (version before no-op)", () => {
    expectDomainError(() => set(stored(3, 12n), 2, 12n), "VERSION_CONFLICT");
    expectDomainError(() => set(stored(3, 12n), 4, 99n), "VERSION_CONFLICT");
  });

  it("the same value at the current version is unchanged", () => {
    const current = stored(3, 12n);
    expect(set(current, 3, 12n)).toEqual({ outcome: "unchanged", record: current });
  });

  it("a different value at the current version bumps the version", () => {
    const current = stored(3, 12n);
    const decision = set(current, 3, 0n);
    expect(decision).toMatchObject({ outcome: "changed", previous: current, record: { id: thresholdId, version: 4 } });
    expect(decision.record?.threshold?.isZero()).toBe(true);
  });

  it("setting a cleared row at its version configures it again", () => {
    const decision = set(stored(2), 2, 5n);
    expect(decision).toMatchObject({ outcome: "changed", record: { version: 3 } });
    expect(decision.record?.threshold?.amountMinor).toBe(5n);
  });

  it("allows 0, rejects negatives and rejects another unit", () => {
    expect(set(undefined, 0, 0n).record?.threshold?.isZero()).toBe(true);
    expectDomainError(() => set(undefined, 0, -1n), "INVALID_VALUE", "threshold");
    expect(() =>
      decideSetThreshold({ current: undefined, expectedVersion: 0, target, value: Quantity.ofMinor(1n, KG), newId }),
    ).toThrow(KernelError);
    expect(() =>
      decideSetThreshold({ current: undefined, expectedVersion: 0, target, value: 1n as unknown as Quantity, newId }),
    ).toThrow(DomainError);
  });

  it("validates the value before the version", () => {
    expectDomainError(() => set(stored(3, 12n), 1, -1n), "INVALID_VALUE", "threshold");
  });

  it("rejects a current row of another stock item", () => {
    const foreign = restoreStockThreshold({
      id: thresholdId,
      businessId,
      locationId: parseLocationId(uuid(9)),
      variantId,
      threshold: pieces(1n),
      version: 1,
    });
    expectDomainError(() => set(foreign, 1, 2n), "INVALID_VALUE", "threshold");
  });
});

describe("decideClearThreshold", () => {
  it("absent with expectedVersion 0 is unchanged", () => {
    expect(clear(undefined, 0)).toEqual({ outcome: "unchanged", record: undefined });
  });

  it("absent with expectedVersion other than 0 is VERSION_CONFLICT", () => {
    expectDomainError(() => clear(undefined, 1), "VERSION_CONFLICT");
  });

  it("a stale version is VERSION_CONFLICT, including expectedVersion 0 on an existing row", () => {
    expectDomainError(() => clear(stored(2, 5n), 1), "VERSION_CONFLICT");
    expectDomainError(() => clear(stored(2, 5n), 0), "VERSION_CONFLICT");
    expectDomainError(() => clear(stored(2), 3), "VERSION_CONFLICT");
  });

  it("already cleared at the current version is unchanged", () => {
    const current = stored(2);
    expect(clear(current, 2)).toEqual({ outcome: "unchanged", record: current });
  });

  it("configured at the current version becomes absent, keeps the row and bumps the version", () => {
    const current = stored(2, 5n);
    const decision = clear(current, 2);
    expect(decision).toMatchObject({ outcome: "changed", previous: current, record: { id: thresholdId, version: 3 } });
    expect(decision.record).not.toHaveProperty("threshold");
  });

  it("rejects an invalid expectedVersion", () => {
    expectDomainError(() => clear(undefined, -1), "INVALID_VALUE", "expectedVersion");
  });
});
