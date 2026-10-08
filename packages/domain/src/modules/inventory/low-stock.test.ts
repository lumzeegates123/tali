import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { KernelError, parseUnitCode, Quantity } from "../../kernel/index.js";
import { deriveLowStock } from "./index.js";

const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const pieces = (minor: bigint): Quantity => Quantity.ofMinor(minor, PIECE);
const active = { variantStatus: "ACTIVE", trackInventory: true, stockUnit: PIECE } as const;

/** Deterministic pseudo-random sequence for property-style checks (tests only). */
function* lcg(seed: bigint): Generator<bigint> {
  let state = seed;
  for (;;) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    yield state >> 33n;
  }
}

describe("deriveLowStock", () => {
  it("is false without a configured threshold", () => {
    expect(deriveLowStock({ ...active, onHand: pieces(0n) })).toBe(false);
    expect(deriveLowStock({ ...active })).toBe(false);
  });

  it("threshold 0: zero on hand is low, positive on hand is not", () => {
    expect(deriveLowStock({ ...active, threshold: pieces(0n), onHand: pieces(0n) })).toBe(true);
    expect(deriveLowStock({ ...active, threshold: pieces(0n), onHand: pieces(1n) })).toBe(false);
  });

  it("compares on hand at, above and below the threshold", () => {
    expect(deriveLowStock({ ...active, threshold: pieces(10n), onHand: pieces(11n) })).toBe(false);
    expect(deriveLowStock({ ...active, threshold: pieces(10n), onHand: pieces(10n) })).toBe(true);
    expect(deriveLowStock({ ...active, threshold: pieces(10n), onHand: pieces(9n) })).toBe(true);
  });

  it("treats a missing balance as zero in the stock unit", () => {
    expect(deriveLowStock({ ...active, threshold: pieces(0n) })).toBe(true);
    expect(deriveLowStock({ ...active, threshold: pieces(3n) })).toBe(true);
    expect(deriveLowStock({ ...active, stockUnit: KG, threshold: Quantity.ofMinor(0n, KG) })).toBe(true);
  });

  it("is never true for an archived variant, even with residual stock", () => {
    expect(deriveLowStock({ ...active, variantStatus: "ARCHIVED", threshold: pieces(10n), onHand: pieces(2n) })).toBe(
      false,
    );
  });

  it("is never true for an untracked variant", () => {
    expect(deriveLowStock({ ...active, trackInventory: false, threshold: pieces(10n), onHand: pieces(2n) })).toBe(
      false,
    );
  });

  it("raises a unit mismatch for quantities outside the stock unit, never converting", () => {
    expect(() => deriveLowStock({ ...active, threshold: Quantity.ofMinor(10n, KG), onHand: pieces(2n) })).toThrow(
      KernelError,
    );
    expect(() => deriveLowStock({ ...active, threshold: pieces(10n), onHand: Quantity.ofMinor(2n, KG) })).toThrow(
      KernelError,
    );
    expect(() => deriveLowStock({ ...active, threshold: Quantity.ofMinor(10n, KG) })).toThrow(KernelError);
  });

  it("rejects a negative threshold", () => {
    expect(() => deriveLowStock({ ...active, threshold: pieces(-1n) })).toThrow(DomainError);
  });

  it("matches onHand <= threshold exactly for random ACTIVE tracked items", () => {
    const random = lcg(23n);
    const draw = (): bigint => random.next().value as bigint;
    const next = (modulo: bigint): bigint => ((draw() << 31n) | draw()) % modulo;
    const max = 1_000_000_000_000_000n;
    let low = 0;
    for (let run = 0; run < 1000; run += 1) {
      const threshold = run % 10 === 0 ? next(100n) : next(max + 1n);
      const near = run % 3 === 0 ? threshold : run % 3 === 1 ? threshold - 1n : threshold + 1n;
      const onHand = run % 2 === 0 && near <= max ? near : next(2n * max + 1n) - max;
      const expected = onHand <= threshold;
      if (expected) low += 1;
      expect(deriveLowStock({ ...active, threshold: pieces(threshold), onHand: pieces(onHand) })).toBe(expected);
    }
    expect(low).toBeGreaterThan(100);
    expect(low).toBeLessThan(900);
  });
});
