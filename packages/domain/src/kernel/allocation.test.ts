import { describe, expect, it } from "vitest";
import { allocateByWeights, allocateEvenly } from "./allocation";
import { KernelError } from "./errors";

/** Deterministic pseudo-random sequence for property-style checks (tests only). */
function* lcg(seed: bigint): Generator<bigint> {
  let state = seed;
  for (;;) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
    yield state >> 33n;
  }
}

describe("allocateByWeights", () => {
  it("distributes remainders by largest remainder, ties to the earlier index", () => {
    expect(allocateByWeights(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateByWeights(5n, [1n, 1n, 1n, 1n])).toEqual([2n, 1n, 1n, 1n]);
    expect(allocateByWeights(10n, [1n, 2n])).toEqual([3n, 7n]);
    expect(allocateByWeights(11n, [1n, 1n, 1n, 1n, 1n, 1n])).toEqual([2n, 2n, 2n, 2n, 2n, 1n]);
  });

  it("never gives anything to a zero weight", () => {
    expect(allocateByWeights(7n, [0n, 1n, 0n, 1n])).toEqual([0n, 4n, 0n, 3n]);
  });

  it("allocates zero", () => {
    expect(allocateByWeights(0n, [3n, 1n])).toEqual([0n, 0n]);
  });

  it("always sums exactly to the total and stays within one unit of the exact share", () => {
    const random = lcg(42n);
    const next = (modulo: bigint): bigint => (random.next().value as bigint) % modulo;
    for (let run = 0; run < 500; run += 1) {
      const total = next(2_000_000n) - 1_000_000n;
      const weights = Array.from({ length: Number(next(8n)) + 1 }, () => next(1000n));
      if (!weights.some((weight) => weight > 0n)) weights[0] = 1n;
      const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);

      const parts = allocateByWeights(total, weights);
      expect(parts.reduce((sum, part) => sum + part, 0n)).toBe(total);
      parts.forEach((part, index) => {
        const exactTimesSum = total * (weights[index] ?? 0n);
        const difference = part * weightSum - exactTimesSum;
        expect(difference < 0n ? -difference : difference).toBeLessThan(weightSum);
      });
    }
  });

  it("is deterministic", () => {
    expect(allocateByWeights(1_000_003n, [7n, 3n, 5n])).toEqual(allocateByWeights(1_000_003n, [7n, 3n, 5n]));
  });

  it("rejects invalid weights", () => {
    expect(() => allocateByWeights(1n, [])).toThrow(KernelError);
    expect(() => allocateByWeights(1n, [0n, 0n])).toThrow(KernelError);
    expect(() => allocateByWeights(1n, [1n, -1n])).toThrow(KernelError);
  });
});

describe("allocateEvenly", () => {
  it("splits into near-equal parts", () => {
    expect(allocateEvenly(10n, 4)).toEqual([3n, 3n, 2n, 2n]);
    expect(allocateEvenly(-10n, 4)).toEqual([-3n, -3n, -2n, -2n]);
    expect(allocateEvenly(2n, 5)).toEqual([1n, 1n, 0n, 0n, 0n]);
  });

  it("rejects a non-positive or fractional number of parts", () => {
    expect(() => allocateEvenly(1n, 0)).toThrow(KernelError);
    expect(() => allocateEvenly(1n, 1.5)).toThrow(KernelError);
  });
});
