import { allocateByWeights, allocateEvenly } from "./allocation";
import type { CurrencyCode, CurrencyDefinition } from "./currency";
import { parseCurrencyCode } from "./currency";
import { KernelError } from "./errors";
import type { RoundingMode } from "./rounding";
import { absBigInt, divideAndRound } from "./rounding";

const MINOR_UNITS_PATTERN = /^-?(0|[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function requireBigInt(value: unknown): bigint {
  if (typeof value !== "bigint") {
    throw new KernelError(
      "INVALID_MONEY_AMOUNT",
      "money amounts must be bigint minor units, never floating-point numbers",
    );
  }
  return value;
}

/**
 * An exact monetary amount: integer minor units paired with an ISO 4217 code.
 * Immutable. Arithmetic across different currencies is rejected; there is no
 * currency conversion.
 */
export class Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;

  private constructor(amountMinor: bigint, currency: CurrencyCode) {
    this.amountMinor = amountMinor;
    this.currency = currency;
    Object.freeze(this);
  }

  static ofMinor(amountMinor: bigint, currency: CurrencyCode): Money {
    return new Money(requireBigInt(amountMinor), parseCurrencyCode(currency));
  }

  static zero(currency: CurrencyCode): Money {
    return Money.ofMinor(0n, currency);
  }

  /** Parses a base-10 integer string of minor units (the wire representation), e.g. "125050". */
  static fromMinorUnitsString(value: string, currency: CurrencyCode): Money {
    if (!MINOR_UNITS_PATTERN.test(value) || value === "-0") {
      throw new KernelError("INVALID_MONEY_AMOUNT", `"${value}" is not a base-10 integer amount of minor units`);
    }
    return Money.ofMinor(BigInt(value), currency);
  }

  /**
   * Parses an exact decimal string in major units (e.g. "1250.50") using the
   * currency's minor-unit exponent. Input with more fractional digits than the
   * currency allows is rejected rather than rounded.
   */
  static fromDecimalString(value: string, definition: CurrencyDefinition): Money {
    const match = DECIMAL_PATTERN.exec(value);
    const whole = match?.[2];
    if (match === null || whole === undefined) {
      throw new KernelError("INVALID_MONEY_AMOUNT", `"${value}" is not a decimal amount`);
    }
    const fraction = match[3] ?? "";
    if (fraction.length > definition.minorUnitDigits) {
      throw new KernelError(
        "INVALID_MONEY_AMOUNT",
        `"${value}" has more than ${definition.minorUnitDigits} fractional digit(s) for ${definition.code}`,
      );
    }
    const magnitude = BigInt(whole + fraction.padEnd(definition.minorUnitDigits, "0"));
    return Money.ofMinor(match[1] === "-" ? -magnitude : magnitude, definition.code);
  }

  /** Sums amounts of one currency; an empty list yields zero in that currency. */
  static sum(currency: CurrencyCode, amounts: readonly Money[]): Money {
    return amounts.reduce((total, amount) => total.add(amount), Money.zero(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  negate(): Money {
    return new Money(-this.amountMinor, this.currency);
  }

  abs(): Money {
    return new Money(absBigInt(this.amountMinor), this.currency);
  }

  /** Multiplies by an exact integer factor (e.g. a whole-unit quantity). */
  multiply(factor: bigint): Money {
    return new Money(this.amountMinor * requireBigInt(factor), this.currency);
  }

  /**
   * Multiplies by the exact fraction numerator/denominator, rounding the result
   * with an explicitly chosen mode (e.g. basis points: numerator/10000n).
   */
  multiplyByFraction(numerator: bigint, denominator: bigint, mode: RoundingMode): Money {
    return new Money(
      divideAndRound(this.amountMinor * requireBigInt(numerator), requireBigInt(denominator), mode),
      this.currency,
    );
  }

  /** Splits by weights (largest remainder); parts always sum to this amount. */
  allocate(weights: readonly bigint[]): Money[] {
    return allocateByWeights(this.amountMinor, weights).map((part) => new Money(part, this.currency));
  }

  /** Splits into near-equal parts (largest remainder); parts always sum to this amount. */
  allocateEvenly(parts: number): Money[] {
    return allocateEvenly(this.amountMinor, parts).map((part) => new Money(part, this.currency));
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  isPositive(): boolean {
    return this.amountMinor > 0n;
  }

  isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  /** Orders two amounts of the same currency: -1, 0 or 1. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amountMinor === other.amountMinor) return 0;
    return this.amountMinor < other.amountMinor ? -1 : 1;
  }

  /** True only when both currency and amount are equal (never throws). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  /** Base-10 integer string of minor units, e.g. "125050". */
  toMinorUnitsString(): string {
    return this.amountMinor.toString();
  }

  /**
   * Deterministic, locale-independent decimal string in major units, e.g.
   * "1250.50". Locale-aware display formatting belongs to the clients.
   */
  toDecimalString(definition: CurrencyDefinition): string {
    if (definition.code !== this.currency) {
      throw new KernelError(
        "CURRENCY_MISMATCH",
        `cannot format ${this.currency} with the ${definition.code} currency definition`,
      );
    }
    const digits = definition.minorUnitDigits;
    const magnitude = absBigInt(this.amountMinor).toString();
    const sign = this.amountMinor < 0n ? "-" : "";
    if (digits === 0) {
      return sign + magnitude;
    }
    const padded = magnitude.padStart(digits + 1, "0");
    return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  }

  toString(): string {
    return `${this.currency} ${this.amountMinor.toString()} (minor units)`;
  }

  /** Money must be mapped to the wire format explicitly; implicit JSON is refused. */
  toJSON(): never {
    throw new KernelError(
      "MONEY_NOT_SERIALIZABLE",
      "Money is not implicitly JSON-serializable; map it to the { amountMinor, currency } wire format",
    );
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new KernelError(
        "CURRENCY_MISMATCH",
        `cannot combine ${this.currency} with ${other.currency}; currency conversion is not supported`,
      );
    }
  }
}
