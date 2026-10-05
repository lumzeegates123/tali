import { DomainError } from "../../errors.js";
import { isWellFormedText } from "../../text.js";

declare const skuKeyBrand: unique symbol;
declare const barcodeKeyBrand: unique symbol;

/** The normalized SKU used for uniqueness: unique per business across all statuses (ADR-008 section 5.1). */
export type SkuKey = string & { readonly [skuKeyBrand]: true };

/** The normalized barcode used for uniqueness among ACTIVE variants (ADR-008 section 5.2). */
export type BarcodeKey = string & { readonly [barcodeKeyBrand]: true };

/**
 * A SKU as the merchant wrote it (`value`: NFC, trimmed, inner whitespace
 * collapsed, case kept) and its normalized form (`normalized`: the same,
 * upper-cased).
 */
export interface Sku {
  readonly value: string;
  readonly normalized: SkuKey;
}

/**
 * A barcode as entered (`value`, trimmed, case kept) and its normalized form.
 * `normalized` is canonical GTIN-14 for a valid GTIN and otherwise equals
 * `value` (an ordinary merchant barcode). There is no scheme field: whether a
 * code is a valid GTIN is derivable from its value.
 */
export interface Barcode {
  readonly value: string;
  readonly normalized: BarcodeKey;
}

export const SKU_MAX_LENGTH = 64;
export const BARCODE_MAX_LENGTH = 64;

const SKU_PATTERN = /^[A-Z0-9 ._/-]{1,64}$/;
const BARCODE_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const DIGITS = /^[0-9]+$/;
const GTIN_LENGTHS: readonly number[] = [8, 12, 13, 14];

/**
 * SKU contract (ADR-008 section 5.1): NFC, trimmed, inner whitespace collapsed
 * to one space, upper-cased; then 1 to 64 characters of [A-Z0-9 ._/-].
 */
export function parseSku(input: string): Sku {
  if (typeof input !== "string" || !isWellFormedText(input)) {
    throw new DomainError("INVALID_VALUE", "sku is not well-formed text", "sku");
  }
  const value = input.normalize("NFC").trim().replace(/\s+/gu, " ");
  const normalized = value.toUpperCase();
  if (!SKU_PATTERN.test(normalized)) {
    throw new DomainError(
      "INVALID_VALUE",
      `sku must be 1 to ${SKU_MAX_LENGTH} characters of A-Z, 0-9, space, ".", "_", "/" and "-"`,
      "sku",
    );
  }
  return Object.freeze({ value, normalized: normalized as SkuKey });
}

/**
 * True for an all-digit code of length 8, 12, 13 or 14 whose last digit is
 * the GS1 check digit (weights 3 and 1 alternating from the right).
 */
export function isValidGtin(code: string): boolean {
  if (!DIGITS.test(code) || !GTIN_LENGTHS.includes(code.length)) return false;
  let sum = 0;
  let weight = 3;
  for (let index = code.length - 2; index >= 0; index -= 1) {
    sum += (code.charCodeAt(index) - 48) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === code.charCodeAt(code.length - 1) - 48;
}

/**
 * Barcode contract (ADR-008 section 5.2): trimmed; 1 to 64 characters of
 * [0-9A-Za-z-]; case preserved. A valid GTIN-8/12/13/14 normalizes to GTIN-14
 * by left zero-padding, so UPC-A and EAN-13 forms of one item match. Any other
 * syntactically valid code, including an all-digit code of a GTIN length with a
 * wrong check digit, is an ordinary merchant barcode kept unchanged.
 */
export function parseBarcode(input: string): Barcode {
  if (typeof input !== "string") {
    throw new DomainError("INVALID_VALUE", "barcode must be text", "barcode");
  }
  const value = input.trim();
  if (!BARCODE_PATTERN.test(value)) {
    throw new DomainError(
      "INVALID_VALUE",
      `barcode must be 1 to ${BARCODE_MAX_LENGTH} characters of 0-9, A-Z, a-z and "-"`,
      "barcode",
    );
  }
  const normalized = isValidGtin(value) ? value.padStart(14, "0") : value;
  return Object.freeze({ value, normalized: normalized as BarcodeKey });
}

/** Rebuilds a stored SKU, checking that the stored normalized form is the contract's. */
export function restoreSku(value: string, normalized: string): Sku {
  const sku = parseSku(value);
  if (sku.value !== value || sku.normalized !== normalized) {
    throw new DomainError("INVALID_VALUE", "stored sku does not match its normalized form", "sku");
  }
  return sku;
}

/** Rebuilds a stored barcode, checking that the stored normalized form is the contract's. */
export function restoreBarcode(value: string, normalized: string): Barcode {
  const barcode = parseBarcode(value);
  if (barcode.value !== value || barcode.normalized !== normalized) {
    throw new DomainError("INVALID_VALUE", "stored barcode does not match its normalized form", "barcode");
  }
  return barcode;
}
