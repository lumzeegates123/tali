import { KernelError } from "./errors.js";

declare const currencyCodeBrand: unique symbol;

/**
 * An ISO 4217 alphabetic currency code (three uppercase letters).
 * The kernel validates the format only; whether a code is supported is decided
 * by the currency reference data held by the server.
 */
export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** ISO 4217 minor-unit exponents range from 0 to 4. */
export const MAX_MINOR_UNIT_DIGITS = 4;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return CURRENCY_CODE_PATTERN.test(value);
}

export function parseCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new KernelError("INVALID_CURRENCY_CODE", `"${value}" is not an ISO 4217 alphabetic currency code`);
  }
  return value;
}

/**
 * Currency reference data needed for decimal conversion and formatting.
 * The minor-unit exponent always comes from reference data; the kernel never
 * assumes a value such as 2.
 */
export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  readonly minorUnitDigits: number;
}

export function defineCurrency(code: string, minorUnitDigits: number): CurrencyDefinition {
  if (!Number.isSafeInteger(minorUnitDigits) || minorUnitDigits < 0 || minorUnitDigits > MAX_MINOR_UNIT_DIGITS) {
    throw new KernelError(
      "INVALID_CURRENCY_DEFINITION",
      `minor-unit digits must be an integer from 0 to ${MAX_MINOR_UNIT_DIGITS}, received ${minorUnitDigits}`,
    );
  }
  return Object.freeze({ code: parseCurrencyCode(code), minorUnitDigits });
}
