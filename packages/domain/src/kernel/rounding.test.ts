import { describe, expect, it } from "vitest";
import { KernelError } from "./errors.js";
import { divideAndRound, RoundingMode } from "./rounding.js";

// Each row: value (numerator / 10), then the expected result per mode.
const cases: [bigint, Record<RoundingMode, bigint>][] = [
  [25n, { HALF_EVEN: 2n, HALF_UP: 3n, HALF_DOWN: 2n, UP: 3n, DOWN: 2n, CEILING: 3n, FLOOR: 2n }],
  [35n, { HALF_EVEN: 4n, HALF_UP: 4n, HALF_DOWN: 3n, UP: 4n, DOWN: 3n, CEILING: 4n, FLOOR: 3n }],
  [24n, { HALF_EVEN: 2n, HALF_UP: 2n, HALF_DOWN: 2n, UP: 3n, DOWN: 2n, CEILING: 3n, FLOOR: 2n }],
  [26n, { HALF_EVEN: 3n, HALF_UP: 3n, HALF_DOWN: 3n, UP: 3n, DOWN: 2n, CEILING: 3n, FLOOR: 2n }],
  [-25n, { HALF_EVEN: -2n, HALF_UP: -3n, HALF_DOWN: -2n, UP: -3n, DOWN: -2n, CEILING: -2n, FLOOR: -3n }],
  [-35n, { HALF_EVEN: -4n, HALF_UP: -4n, HALF_DOWN: -3n, UP: -4n, DOWN: -3n, CEILING: -3n, FLOOR: -4n }],
  [-26n, { HALF_EVEN: -3n, HALF_UP: -3n, HALF_DOWN: -3n, UP: -3n, DOWN: -2n, CEILING: -2n, FLOOR: -3n }],
  [20n, { HALF_EVEN: 2n, HALF_UP: 2n, HALF_DOWN: 2n, UP: 2n, DOWN: 2n, CEILING: 2n, FLOOR: 2n }],
  [0n, { HALF_EVEN: 0n, HALF_UP: 0n, HALF_DOWN: 0n, UP: 0n, DOWN: 0n, CEILING: 0n, FLOOR: 0n }],
];

describe("divideAndRound", () => {
  for (const [numerator, expected] of cases) {
    for (const mode of Object.values(RoundingMode)) {
      it(`${numerator}/10 with ${mode} = ${expected[mode]}`, () => {
        expect(divideAndRound(numerator, 10n, mode)).toBe(expected[mode]);
      });
    }
  }

  it("normalizes a negative denominator", () => {
    expect(divideAndRound(25n, -10n, RoundingMode.HALF_UP)).toBe(-3n);
    expect(divideAndRound(-25n, -10n, RoundingMode.HALF_EVEN)).toBe(2n);
  });

  it("rejects division by zero", () => {
    expect(() => divideAndRound(1n, 0n, RoundingMode.HALF_EVEN)).toThrow(KernelError);
  });

  it("rejects an unknown rounding mode", () => {
    expect(() => divideAndRound(1n, 3n, "BANKERS" as RoundingMode)).toThrow(KernelError);
  });
});
