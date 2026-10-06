import { describe, expect, it } from "vitest";
import { KernelError } from "./errors.js";
import { MAX_QUANTITY_MINOR, Quantity } from "./quantity.js";
import { defineUnit, parseUnitCode } from "./unit.js";

const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const G = parseUnitCode("G");

const piece = defineUnit("PIECE", "COUNT", 0);
const bottle = defineUnit("BOTTLE", "COUNT", 0);
const kg = defineUnit("KG", "MASS", 3);
const g = defineUnit("G", "MASS", 0);
const l = defineUnit("L", "VOLUME", 3);
const ml = defineUnit("ML", "VOLUME", 0);

function expectKernelError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    expect((error as KernelError).code).toBe(code);
    return;
  }
  throw new Error(`expected KernelError ${code}`);
}

/** A seeded linear congruential generator: the same cases on every run, no dependency. */
function* generatedMinorAmounts(seed: bigint, count: number): Generator<bigint> {
  let state = seed;
  const modulus = 2n ** 61n - 1n;
  for (let index = 0; index < count; index += 1) {
    state = (state * 6364136223846793005n + 1442695040888963407n) % modulus;
    const magnitude = state % (MAX_QUANTITY_MINOR + 1n);
    yield index % 2 === 0 ? magnitude : -magnitude;
  }
}

describe("unit definitions", () => {
  it("accepts the nine initial units with their kinds and scales", () => {
    expect(piece).toEqual({ code: "PIECE", kind: "COUNT", scale: 0 });
    expect(kg).toEqual({ code: "KG", kind: "MASS", scale: 3 });
    expect(l).toEqual({ code: "L", kind: "VOLUME", scale: 3 });
    expect(Object.isFrozen(kg)).toBe(true);
  });

  it("rejects malformed codes, unknown kinds and scales outside 0 to 3", () => {
    for (const code of ["kg", "K G", "", "A".repeat(17), "KG1", "CARTON_24"]) {
      expectKernelError(() => parseUnitCode(code), "INVALID_UNIT_CODE");
    }
    expectKernelError(() => defineUnit("KG", "WEIGHT" as never, 3), "INVALID_UNIT_DEFINITION");
    expectKernelError(() => defineUnit("KG", "MASS", 4), "INVALID_UNIT_DEFINITION");
    expectKernelError(() => defineUnit("KG", "MASS", -1), "INVALID_UNIT_DEFINITION");
    expectKernelError(() => defineUnit("KG", "MASS", 1.5), "INVALID_UNIT_DEFINITION");
  });
});

describe("Quantity construction", () => {
  it("holds bigint minor quantities and a unit code", () => {
    const quantity = Quantity.ofMinor(1500n, KG);
    expect(quantity.amountMinor).toBe(1500n);
    expect(quantity.unit).toBe("KG");
    expect(Quantity.zero(PIECE).isZero()).toBe(true);
  });

  it("rejects JavaScript numbers, including integral ones", () => {
    expectKernelError(() => Quantity.ofMinor(1.5 as unknown as bigint, KG), "INVALID_QUANTITY");
    expectKernelError(() => Quantity.ofMinor(24 as unknown as bigint, PIECE), "INVALID_QUANTITY");
    expectKernelError(() => Quantity.zero(PIECE).multiply(2 as unknown as bigint), "INVALID_QUANTITY");
  });

  it("rejects invalid unit codes", () => {
    expectKernelError(() => Quantity.ofMinor(1n, "kg" as never), "INVALID_UNIT_CODE");
  });

  it("accepts exactly the bounds and rejects anything beyond them", () => {
    expect(Quantity.ofMinor(MAX_QUANTITY_MINOR, PIECE).toMinorUnitsString()).toBe("1000000000000000");
    expect(Quantity.ofMinor(-MAX_QUANTITY_MINOR, PIECE).toMinorUnitsString()).toBe("-1000000000000000");
    expectKernelError(() => Quantity.ofMinor(MAX_QUANTITY_MINOR + 1n, PIECE), "QUANTITY_OUT_OF_RANGE");
    expectKernelError(() => Quantity.ofMinor(-MAX_QUANTITY_MINOR - 1n, PIECE), "QUANTITY_OUT_OF_RANGE");
    expect(MAX_QUANTITY_MINOR).toBe(10n ** 15n);
  });

  it("is immutable", () => {
    const quantity = Quantity.ofMinor(1n, PIECE);
    expect(Object.isFrozen(quantity)).toBe(true);
    try {
      (quantity as { amountMinor: bigint }).amountMinor = 2n;
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
    }
    expect(quantity.amountMinor).toBe(1n);
  });
});

describe("Quantity arithmetic", () => {
  it("adds, subtracts, negates and takes absolute values exactly", () => {
    const a = Quantity.ofMinor(1500n, KG);
    const b = Quantity.ofMinor(250n, KG);
    expect(a.add(b).amountMinor).toBe(1750n);
    expect(a.subtract(b).amountMinor).toBe(1250n);
    expect(b.subtract(a).amountMinor).toBe(-1250n);
    expect(a.negate().amountMinor).toBe(-1500n);
    expect(a.negate().abs().amountMinor).toBe(1500n);
  });

  it("multiplies by an exact integer factor (pack count times factor)", () => {
    expect(Quantity.ofMinor(24n, PIECE).multiply(3n).amountMinor).toBe(72n);
    expect(Quantity.ofMinor(50_000n, KG).multiply(2n).amountMinor).toBe(100_000n);
    expect(Quantity.ofMinor(7n, PIECE).multiply(0n).isZero()).toBe(true);
    expect(Quantity.ofMinor(7n, PIECE).multiply(-2n).amountMinor).toBe(-14n);
  });

  it("rejects results outside the bounds instead of overflowing or wrapping", () => {
    const max = Quantity.ofMinor(MAX_QUANTITY_MINOR, PIECE);
    expectKernelError(() => max.add(Quantity.ofMinor(1n, PIECE)), "QUANTITY_OUT_OF_RANGE");
    expectKernelError(() => max.negate().subtract(Quantity.ofMinor(1n, PIECE)), "QUANTITY_OUT_OF_RANGE");
    expectKernelError(() => Quantity.ofMinor(10n ** 9n, PIECE).multiply(10n ** 7n), "QUANTITY_OUT_OF_RANGE");
    expect(max.subtract(Quantity.ofMinor(1n, PIECE)).amountMinor).toBe(MAX_QUANTITY_MINOR - 1n);
  });

  it("never combines or converts different units, even of the same kind", () => {
    const kilos = Quantity.ofMinor(1000n, KG);
    const grams = Quantity.ofMinor(1000n, G);
    expectKernelError(() => kilos.add(grams), "UNIT_MISMATCH");
    expectKernelError(() => kilos.subtract(grams), "UNIT_MISMATCH");
    expectKernelError(() => kilos.compare(grams), "UNIT_MISMATCH");
    expectKernelError(() => kilos.add(Quantity.ofMinor(1n, PIECE)), "UNIT_MISMATCH");
    expect(kilos.equals(grams)).toBe(false);
  });

  it("compares and classifies quantities", () => {
    const one = Quantity.ofMinor(1n, PIECE);
    const two = Quantity.ofMinor(2n, PIECE);
    expect(one.compare(two)).toBe(-1);
    expect(two.compare(one)).toBe(1);
    expect(one.compare(Quantity.ofMinor(1n, PIECE))).toBe(0);
    expect(one.equals(Quantity.ofMinor(1n, PIECE))).toBe(true);
    expect(one.isPositive()).toBe(true);
    expect(one.negate().isNegative()).toBe(true);
    expect([one.sign(), one.negate().sign(), Quantity.zero(PIECE).sign()]).toEqual([1, -1, 0]);
  });
});

describe("Quantity parsing and formatting", () => {
  it("parses the minor-quantity wire string strictly", () => {
    expect(Quantity.fromMinorUnitsString("1500", KG).amountMinor).toBe(1500n);
    expect(Quantity.fromMinorUnitsString("-5", PIECE).amountMinor).toBe(-5n);
    expect(Quantity.fromMinorUnitsString("0", PIECE).amountMinor).toBe(0n);
    for (const invalid of ["1.5", "1e3", " 1", "1 ", "01", "-0", "+1", "", "0x10", "1_000", "--1", "١٢"]) {
      expectKernelError(() => Quantity.fromMinorUnitsString(invalid, PIECE), "INVALID_QUANTITY");
    }
    expectKernelError(() => Quantity.fromMinorUnitsString("1000000000000001", PIECE), "QUANTITY_OUT_OF_RANGE");
    expectKernelError(() => Quantity.fromMinorUnitsString(1500 as unknown as string, PIECE), "INVALID_QUANTITY");
  });

  it("parses decimal strings exactly against the unit scale", () => {
    expect(Quantity.fromDecimalString("1.5", kg).amountMinor).toBe(1500n);
    expect(Quantity.fromDecimalString("1.500", kg).amountMinor).toBe(1500n);
    expect(Quantity.fromDecimalString("0.001", kg).amountMinor).toBe(1n);
    expect(Quantity.fromDecimalString("50", kg).amountMinor).toBe(50_000n);
    expect(Quantity.fromDecimalString("-2.25", l).amountMinor).toBe(-2250n);
    expect(Quantity.fromDecimalString("24", bottle).amountMinor).toBe(24n);
    expect(Quantity.fromDecimalString("750", ml).amountMinor).toBe(750n);
    expect(Quantity.fromDecimalString("1500", g).amountMinor).toBe(1500n);
  });

  it("rejects excess precision instead of rounding", () => {
    expectKernelError(() => Quantity.fromDecimalString("1.0005", kg), "INVALID_QUANTITY");
    expectKernelError(() => Quantity.fromDecimalString("1.5", piece), "INVALID_QUANTITY");
    expectKernelError(() => Quantity.fromDecimalString("2.0", bottle), "INVALID_QUANTITY");
    expectKernelError(() => Quantity.fromDecimalString("0.5", g), "INVALID_QUANTITY");
  });

  it("rejects malformed decimals and negative zero", () => {
    for (const invalid of ["", ".5", "1.", "01.5", "+1.5", "1,5", "1e3", "-0", "-0.000", " 1.5", "1.5 ", "NaN"]) {
      expectKernelError(() => Quantity.fromDecimalString(invalid, kg), "INVALID_QUANTITY");
    }
    expectKernelError(() => Quantity.fromDecimalString("1000000000000.001", kg), "QUANTITY_OUT_OF_RANGE");
    expect(Quantity.fromDecimalString("1000000000000.000", kg).amountMinor).toBe(MAX_QUANTITY_MINOR);
  });

  it("formats deterministically for scales 0 and 3", () => {
    expect(Quantity.ofMinor(1500n, KG).toDecimalString(kg)).toBe("1.500");
    expect(Quantity.ofMinor(5n, KG).toDecimalString(kg)).toBe("0.005");
    expect(Quantity.ofMinor(-5n, KG).toDecimalString(kg)).toBe("-0.005");
    expect(Quantity.ofMinor(0n, KG).toDecimalString(kg)).toBe("0.000");
    expect(Quantity.ofMinor(24n, PIECE).toDecimalString(piece)).toBe("24");
    expect(Quantity.ofMinor(-3n, PIECE).toDecimalString(piece)).toBe("-3");
  });

  it("refuses to format with another unit's definition, even of the same kind", () => {
    expectKernelError(() => Quantity.ofMinor(1n, KG).toDecimalString(g), "UNIT_MISMATCH");
  });

  it("refuses implicit JSON serialization", () => {
    expectKernelError(() => JSON.stringify({ onHand: Quantity.ofMinor(1n, PIECE) }), "QUANTITY_NOT_SERIALIZABLE");
  });
});

describe("Quantity generated cases (seeded, deterministic)", () => {
  const units = [piece, kg, l, defineUnit("X", "COUNT", 1), defineUnit("Y", "COUNT", 2)];

  it("round-trips minor strings and decimal strings for every scale", () => {
    for (const definition of units) {
      for (const amount of generatedMinorAmounts(BigInt(definition.scale) + 17n, 200)) {
        const quantity = Quantity.ofMinor(amount, definition.code);
        expect(Quantity.fromMinorUnitsString(quantity.toMinorUnitsString(), definition.code).equals(quantity)).toBe(
          true,
        );
        const decimal = quantity.toDecimalString(definition);
        expect(Quantity.fromDecimalString(decimal, definition).equals(quantity)).toBe(true);
        if (definition.scale > 0) {
          expectKernelError(() => Quantity.fromDecimalString(`${decimal}1`, definition), "INVALID_QUANTITY");
        }
      }
    }
  });

  it("keeps addition and subtraction exact inverses within the bounds", () => {
    const amounts = [...generatedMinorAmounts(99n, 300)].map((value) => value / 2n);
    for (let index = 1; index < amounts.length; index += 1) {
      const a = Quantity.ofMinor(amounts[index - 1] ?? 0n, KG);
      const b = Quantity.ofMinor(amounts[index] ?? 0n, KG);
      expect(a.add(b).subtract(b).equals(a)).toBe(true);
      expect(a.add(b).equals(b.add(a))).toBe(true);
      expect(a.subtract(b).equals(b.subtract(a).negate())).toBe(true);
      expect(a.compare(b)).toBe(-b.compare(a) || 0);
    }
  });

  it("rejects every generated out-of-bounds value", () => {
    for (const amount of generatedMinorAmounts(5n, 100)) {
      const beyond = amount >= 0n ? amount + MAX_QUANTITY_MINOR + 1n : amount - MAX_QUANTITY_MINOR - 1n;
      expectKernelError(() => Quantity.ofMinor(beyond, PIECE), "QUANTITY_OUT_OF_RANGE");
    }
  });
});
