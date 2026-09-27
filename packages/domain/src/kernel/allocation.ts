import { KernelError } from "./errors";
import { absBigInt } from "./rounding";

/**
 * Splits an integer total in proportion to non-negative integer weights using
 * the largest-remainder method. The parts always sum exactly to the total.
 * Ties between equal remainders go to the earlier index, so the result is
 * deterministic. Negative totals are allocated symmetrically.
 */
export function allocateByWeights(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new KernelError("INVALID_ALLOCATION", "allocation needs at least one weight");
  }
  let weightSum = 0n;
  for (const weight of weights) {
    if (weight < 0n) {
      throw new KernelError("INVALID_ALLOCATION", "allocation weights must be non-negative");
    }
    weightSum += weight;
  }
  if (weightSum === 0n) {
    throw new KernelError("INVALID_ALLOCATION", "allocation weights must not all be zero");
  }

  const magnitude = absBigInt(total);
  const shares = weights.map((weight) => (magnitude * weight) / weightSum);
  const remainders = weights.map((weight) => (magnitude * weight) % weightSum);

  let leftover = magnitude - shares.reduce((sum, share) => sum + share, 0n);
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));

  for (const { index } of order) {
    if (leftover === 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return total < 0n ? shares.map((share) => -share) : shares;
}

/** Splits an integer total into `parts` near-equal integers that sum exactly to the total. */
export function allocateEvenly(total: bigint, parts: number): bigint[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new KernelError("INVALID_ALLOCATION", `parts must be a positive integer, received ${parts}`);
  }
  return allocateByWeights(
    total,
    Array.from({ length: parts }, () => 1n),
  );
}
