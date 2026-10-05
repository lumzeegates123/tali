import { KernelError } from "./errors.js";
import { absBigInt } from "./rounding.js";
import type { UnitCode, UnitDefinition } from "./unit.js";
import { parseUnitCode } from "./unit.js";

/** ADR-008 section 4.3: the absolute value of a quantity is at most 10^15 minor quantities. */
export const MAX_QUANTITY_MINOR = 1_000_000_000_000_000n;

const MINOR_UNITS_PATTERN = /^-?(0|[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function requireBigInt(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") {
    throw new KernelError("INVALID_QUANTITY", `${what} must be a bigint, never a floating-point number`);
  }
  return value;
}

function requireInBounds(amountMinor: bigint): bigint {
  if (absBigInt(amountMinor) > MAX_QUANTITY_MINOR) {
    throw new KernelError(
      "QUANTITY_OUT_OF_RANGE",
      `quantities are bounded to ${MAX_QUANTITY_MINOR.toString()} minor quantities in absolute value`,
    );
  }
  return amountMinor;
}

/**
 * An exact quantity: integer minor quantities paired with a unit code
 * (ADR-008 section 4.3). Immutable. Arithmetic across different units is
 * rejected; there is no unit conversion and no rounding. Every result stays
 * within the quantity bounds.
 */
export class Quantity {
  readonly amountMinor: bigint;
  readonly unit: UnitCode;

  private constructor(amountMinor: bigint, unit: UnitCode) {
    this.amountMinor = requireInBounds(amountMinor);
    this.unit = unit;
    Object.freeze(this);
  }

  static ofMinor(amountMinor: bigint, unit: UnitCode): Quantity {
    return new Quantity(requireBigInt(amountMinor, "a quantity"), parseUnitCode(unit));
  }

  static zero(unit: UnitCode): Quantity {
    return Quantity.ofMinor(0n, unit);
  }

  /** Parses a base-10 integer string of minor quantities (the wire representation), e.g. "1500". */
  static fromMinorUnitsString(value: string, unit: UnitCode): Quantity {
    if (typeof value !== "string" || !MINOR_UNITS_PATTERN.test(value) || value === "-0") {
      throw new KernelError("INVALID_QUANTITY", "the value is not a base-10 integer of minor quantities");
    }
    return Quantity.ofMinor(BigInt(value), unit);
  }

  /**
   * Parses an exact decimal string in stock units (e.g. "1.5" KG) using the
   * unit's scale. More fractional digits than the scale allows are rejected,
   * never rounded. A negative zero is rejected.
   */
  static fromDecimalString(value: string, definition: UnitDefinition): Quantity {
    const match = typeof value === "string" ? DECIMAL_PATTERN.exec(value) : null;
    const whole = match?.[2];
    if (match === null || whole === undefined) {
      throw new KernelError("INVALID_QUANTITY", "the value is not a decimal quantity");
    }
    const fraction = match[3] ?? "";
    if (fraction.length > definition.scale) {
      throw new KernelError(
        "INVALID_QUANTITY",
        `"${value}" has more than ${definition.scale} fractional digit(s) for ${definition.code}`,
      );
    }
    const magnitude = BigInt(whole + fraction.padEnd(definition.scale, "0"));
    if (match[1] === "-" && magnitude === 0n) {
      throw new KernelError("INVALID_QUANTITY", `"${value}" is a negative zero`);
    }
    return Quantity.ofMinor(match[1] === "-" ? -magnitude : magnitude, definition.code);
  }

  add(other: Quantity): Quantity {
    this.assertSameUnit(other);
    return new Quantity(this.amountMinor + other.amountMinor, this.unit);
  }

  subtract(other: Quantity): Quantity {
    this.assertSameUnit(other);
    return new Quantity(this.amountMinor - other.amountMinor, this.unit);
  }

  negate(): Quantity {
    return new Quantity(-this.amountMinor, this.unit);
  }

  abs(): Quantity {
    return new Quantity(absBigInt(this.amountMinor), this.unit);
  }

  /** Multiplies by an exact integer factor (e.g. a pack count). */
  multiply(factor: bigint): Quantity {
    return new Quantity(this.amountMinor * requireBigInt(factor, "a quantity factor"), this.unit);
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

  /** -1, 0 or 1. */
  sign(): -1 | 0 | 1 {
    if (this.amountMinor === 0n) return 0;
    return this.amountMinor < 0n ? -1 : 1;
  }

  /** Orders two quantities of the same unit: -1, 0 or 1. */
  compare(other: Quantity): -1 | 0 | 1 {
    this.assertSameUnit(other);
    if (this.amountMinor === other.amountMinor) return 0;
    return this.amountMinor < other.amountMinor ? -1 : 1;
  }

  /** True only when both unit and amount are equal (never throws). */
  equals(other: Quantity): boolean {
    return this.unit === other.unit && this.amountMinor === other.amountMinor;
  }

  /** Base-10 integer string of minor quantities, e.g. "1500". */
  toMinorUnitsString(): string {
    return this.amountMinor.toString();
  }

  /**
   * Deterministic, locale-independent decimal string in stock units, e.g.
   * "1.500" for 1500 minor quantities of KG. Display formatting belongs to the
   * clients.
   */
  toDecimalString(definition: UnitDefinition): string {
    if (definition.code !== this.unit) {
      throw new KernelError("UNIT_MISMATCH", `cannot format ${this.unit} with the ${definition.code} unit definition`);
    }
    const digits = definition.scale;
    const magnitude = absBigInt(this.amountMinor).toString();
    const sign = this.amountMinor < 0n ? "-" : "";
    if (digits === 0) {
      return sign + magnitude;
    }
    const padded = magnitude.padStart(digits + 1, "0");
    return `${sign}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  }

  toString(): string {
    return `${this.amountMinor.toString()} ${this.unit} (minor quantities)`;
  }

  /** Quantities must be mapped to the wire format explicitly; implicit JSON is refused. */
  toJSON(): never {
    throw new KernelError(
      "QUANTITY_NOT_SERIALIZABLE",
      "Quantity is not implicitly JSON-serializable; map it to the { quantityMinor, unit } wire format",
    );
  }

  private assertSameUnit(other: Quantity): void {
    if (other.unit !== this.unit) {
      throw new KernelError(
        "UNIT_MISMATCH",
        `cannot combine ${this.unit} with ${other.unit}; units are never converted into each other`,
      );
    }
  }
}
