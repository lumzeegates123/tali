import { KernelError } from "./errors";

/**
 * Named rounding modes, always chosen explicitly at the call site.
 * - HALF_EVEN: nearest; ties to the even neighbour (banker's rounding).
 * - HALF_UP: nearest; ties away from zero.
 * - HALF_DOWN: nearest; ties toward zero.
 * - UP: away from zero.
 * - DOWN: toward zero (truncation).
 * - CEILING: toward positive infinity.
 * - FLOOR: toward negative infinity.
 */
export const RoundingMode = {
  HALF_EVEN: "HALF_EVEN",
  HALF_UP: "HALF_UP",
  HALF_DOWN: "HALF_DOWN",
  UP: "UP",
  DOWN: "DOWN",
  CEILING: "CEILING",
  FLOOR: "FLOOR",
} as const;

export type RoundingMode = (typeof RoundingMode)[keyof typeof RoundingMode];

export function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Exact integer division of numerator by denominator, rounded with the given mode. */
export function divideAndRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new KernelError("DIVISION_BY_ZERO", "cannot divide by zero");
  }
  const n = denominator < 0n ? -numerator : numerator;
  const d = absBigInt(denominator);

  const truncated = n / d;
  const remainder = n % d;
  if (remainder === 0n) {
    return truncated;
  }

  const awayFromZero = n < 0n ? truncated - 1n : truncated + 1n;
  const twiceRemainder = absBigInt(remainder) * 2n;

  switch (mode) {
    case RoundingMode.DOWN:
      return truncated;
    case RoundingMode.UP:
      return awayFromZero;
    case RoundingMode.CEILING:
      return n > 0n ? awayFromZero : truncated;
    case RoundingMode.FLOOR:
      return n < 0n ? awayFromZero : truncated;
    case RoundingMode.HALF_UP:
      return twiceRemainder >= d ? awayFromZero : truncated;
    case RoundingMode.HALF_DOWN:
      return twiceRemainder > d ? awayFromZero : truncated;
    case RoundingMode.HALF_EVEN:
      if (twiceRemainder !== d) {
        return twiceRemainder > d ? awayFromZero : truncated;
      }
      return truncated % 2n === 0n ? truncated : awayFromZero;
    default:
      throw new KernelError("INVALID_ROUNDING_MODE", `unknown rounding mode "${String(mode)}"`);
  }
}
