import { describe, expect, it } from "vitest";
import { defineCurrency, parseCurrencyCode } from "./currency.js";
import { KernelError } from "./errors.js";
import { Money } from "./money.js";
import { RoundingMode } from "./rounding.js";

const NGN = parseCurrencyCode("NGN");
const USD = parseCurrencyCode("USD");
const JPY = parseCurrencyCode("JPY");

const ngn = defineCurrency("NGN", 2);
const jpy = defineCurrency("JPY", 0);
const kwd = defineCurrency("KWD", 3);
const clf = defineCurrency("CLF", 4);

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

describe("Money construction", () => {
  it("holds bigint minor units and a currency code", () => {
    const money = Money.ofMinor(125050n, NGN);
    expect(money.amountMinor).toBe(125050n);
    expect(money.currency).toBe("NGN");
  });

  it("rejects floating-point numbers as amounts", () => {
    expectKernelError(() => Money.ofMinor(12.5 as unknown as bigint, NGN), "INVALID_MONEY_AMOUNT");
    expectKernelError(() => Money.ofMinor(1250 as unknown as bigint, NGN), "INVALID_MONEY_AMOUNT");
    expectKernelError(() => Money.zero(NGN).multiply(2 as unknown as bigint), "INVALID_MONEY_AMOUNT");
  });

  it("rejects invalid currency codes", () => {
    expectKernelError(() => Money.ofMinor(1n, "ngn" as never), "INVALID_CURRENCY_CODE");
    expectKernelError(() => parseCurrencyCode("NAIRA"), "INVALID_CURRENCY_CODE");
  });

  it("is immutable", () => {
    const money = Money.ofMinor(1n, NGN);
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as { amountMinor: bigint }).amountMinor = 2n;
    }).toThrow(TypeError);
  });

  it("keeps full precision beyond Number.MAX_SAFE_INTEGER", () => {
    const large = Money.ofMinor(9_007_199_254_740_993n, USD);
    expect(large.add(Money.ofMinor(1n, USD)).toMinorUnitsString()).toBe("9007199254740994");
  });
});

describe("Money arithmetic", () => {
  it("adds and subtracts within one currency", () => {
    const a = Money.ofMinor(1000n, NGN);
    const b = Money.ofMinor(250n, NGN);
    expect(a.add(b).amountMinor).toBe(1250n);
    expect(a.subtract(b).amountMinor).toBe(750n);
    expect(b.subtract(a).amountMinor).toBe(-750n);
    expect(a.negate().amountMinor).toBe(-1000n);
    expect(a.negate().abs().amountMinor).toBe(1000n);
  });

  it("rejects mixed-currency arithmetic and comparison", () => {
    const naira = Money.ofMinor(100n, NGN);
    const dollars = Money.ofMinor(100n, USD);
    expectKernelError(() => naira.add(dollars), "CURRENCY_MISMATCH");
    expectKernelError(() => naira.subtract(dollars), "CURRENCY_MISMATCH");
    expectKernelError(() => naira.compare(dollars), "CURRENCY_MISMATCH");
    expectKernelError(() => Money.sum(NGN, [naira, dollars]), "CURRENCY_MISMATCH");
    expect(naira.equals(dollars)).toBe(false);
  });

  it("sums a list, with zero for an empty list", () => {
    expect(Money.sum(JPY, []).isZero()).toBe(true);
    expect(Money.sum(JPY, [Money.ofMinor(1n, JPY), Money.ofMinor(2n, JPY)]).amountMinor).toBe(3n);
  });

  it("multiplies by an integer factor", () => {
    expect(Money.ofMinor(1999n, NGN).multiply(3n).amountMinor).toBe(5997n);
  });

  it("multiplies by a fraction with an explicit rounding mode", () => {
    const price = Money.ofMinor(125n, NGN);
    // 125 * 1/2 = 62.5
    expect(price.multiplyByFraction(1n, 2n, RoundingMode.HALF_EVEN).amountMinor).toBe(62n);
    expect(price.multiplyByFraction(1n, 2n, RoundingMode.HALF_UP).amountMinor).toBe(63n);
    // 750 basis points of 1333 = 99.975
    expect(Money.ofMinor(1333n, NGN).multiplyByFraction(750n, 10_000n, RoundingMode.HALF_UP).amountMinor).toBe(100n);
    expect(Money.ofMinor(1333n, NGN).multiplyByFraction(750n, 10_000n, RoundingMode.DOWN).amountMinor).toBe(99n);
  });

  it("rejects division by zero", () => {
    expectKernelError(
      () => Money.ofMinor(1n, NGN).multiplyByFraction(1n, 0n, RoundingMode.HALF_EVEN),
      "DIVISION_BY_ZERO",
    );
  });

  it("compares and classifies amounts", () => {
    const one = Money.ofMinor(1n, NGN);
    const two = Money.ofMinor(2n, NGN);
    expect(one.compare(two)).toBe(-1);
    expect(two.compare(one)).toBe(1);
    expect(one.compare(Money.ofMinor(1n, NGN))).toBe(0);
    expect(one.equals(Money.ofMinor(1n, NGN))).toBe(true);
    expect(one.isPositive()).toBe(true);
    expect(one.negate().isNegative()).toBe(true);
    expect(Money.zero(NGN).isZero()).toBe(true);
  });
});

describe("Money allocation", () => {
  it("splits evenly with parts summing to the whole", () => {
    const parts = Money.ofMinor(100n, NGN).allocateEvenly(3);
    expect(parts.map((part) => part.amountMinor)).toEqual([34n, 33n, 33n]);
    expect(Money.sum(NGN, parts).amountMinor).toBe(100n);
    expect(parts.every((part) => part.currency === NGN)).toBe(true);
  });

  it("splits negative amounts symmetrically", () => {
    expect(
      Money.ofMinor(-100n, NGN)
        .allocateEvenly(3)
        .map((part) => part.amountMinor),
    ).toEqual([-34n, -33n, -33n]);
  });

  it("splits by weights", () => {
    expect(
      Money.ofMinor(1000n, USD)
        .allocate([1n, 1n, 1n])
        .map((part) => part.amountMinor),
    ).toEqual([334n, 333n, 333n]);
    expect(
      Money.ofMinor(1001n, USD)
        .allocate([70n, 30n])
        .map((part) => part.amountMinor),
    ).toEqual([701n, 300n]);
  });
});

describe("Money parsing and formatting", () => {
  it("parses the minor-units wire string strictly", () => {
    expect(Money.fromMinorUnitsString("125050", NGN).amountMinor).toBe(125050n);
    expect(Money.fromMinorUnitsString("-5", NGN).amountMinor).toBe(-5n);
    expect(Money.fromMinorUnitsString("0", NGN).amountMinor).toBe(0n);
    for (const invalid of ["12.5", "1e3", " 1", "01", "-0", "+1", "", "0x10", "1_000"]) {
      expectKernelError(() => Money.fromMinorUnitsString(invalid, NGN), "INVALID_MONEY_AMOUNT");
    }
  });

  it("parses decimal strings using the currency's minor-unit exponent", () => {
    expect(Money.fromDecimalString("1250.50", ngn).amountMinor).toBe(125050n);
    expect(Money.fromDecimalString("1250.5", ngn).amountMinor).toBe(125050n);
    expect(Money.fromDecimalString("1250", ngn).amountMinor).toBe(125000n);
    expect(Money.fromDecimalString("-0.05", ngn).amountMinor).toBe(-5n);
    expect(Money.fromDecimalString("500", jpy).amountMinor).toBe(500n);
    expect(Money.fromDecimalString("1.234", kwd).amountMinor).toBe(1234n);
    expect(Money.fromDecimalString("0.0001", clf).amountMinor).toBe(1n);
  });

  it("rejects excess precision instead of rounding", () => {
    expectKernelError(() => Money.fromDecimalString("1.005", ngn), "INVALID_MONEY_AMOUNT");
    expectKernelError(() => Money.fromDecimalString("5.1", jpy), "INVALID_MONEY_AMOUNT");
    expectKernelError(() => Money.fromDecimalString("1,000.00", ngn), "INVALID_MONEY_AMOUNT");
  });

  it("formats deterministically for 0, 2, 3 and 4 minor-unit digits", () => {
    expect(Money.ofMinor(125050n, NGN).toDecimalString(ngn)).toBe("1250.50");
    expect(Money.ofMinor(5n, NGN).toDecimalString(ngn)).toBe("0.05");
    expect(Money.ofMinor(-5n, NGN).toDecimalString(ngn)).toBe("-0.05");
    expect(Money.ofMinor(0n, NGN).toDecimalString(ngn)).toBe("0.00");
    expect(Money.ofMinor(500n, JPY).toDecimalString(jpy)).toBe("500");
    expect(Money.ofMinor(1234n, kwd.code).toDecimalString(kwd)).toBe("1.234");
    expect(Money.ofMinor(1n, clf.code).toDecimalString(clf)).toBe("0.0001");
  });

  it("round-trips decimal strings", () => {
    for (const value of ["0.00", "0.01", "-1.10", "123456789012345678.99"]) {
      expect(Money.fromDecimalString(value, ngn).toDecimalString(ngn)).toBe(value);
    }
  });

  it("refuses to format with another currency's definition", () => {
    expectKernelError(() => Money.ofMinor(1n, USD).toDecimalString(ngn), "CURRENCY_MISMATCH");
  });

  it("refuses implicit JSON serialization", () => {
    expectKernelError(() => JSON.stringify({ total: Money.ofMinor(1n, NGN) }), "MONEY_NOT_SERIALIZABLE");
  });
});

describe("currency definitions", () => {
  it("requires a minor-unit exponent from 0 to 4", () => {
    expectKernelError(() => defineCurrency("NGN", -1), "INVALID_CURRENCY_DEFINITION");
    expectKernelError(() => defineCurrency("NGN", 5), "INVALID_CURRENCY_DEFINITION");
    expectKernelError(() => defineCurrency("NGN", 1.5), "INVALID_CURRENCY_DEFINITION");
    expect(Object.isFrozen(defineCurrency("NGN", 2))).toBe(true);
  });
});
