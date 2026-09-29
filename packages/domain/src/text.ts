import { DomainError } from "./errors.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the string is well-formed Unicode (no lone surrogates). */
export function isWellFormedText(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/** Length in Unicode code points (the unit of PostgreSQL char_length). */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Applies a name contract that explicitly normalizes (ADR-005 sections 4 and 5):
 * trim, then NFC, then 1..max code points of well-formed text.
 */
export function normalizeBoundedName(value: string, field: string, max: number): string {
  if (!isWellFormedText(value)) {
    throw new DomainError("INVALID_VALUE", `${field} is not well-formed text`, field);
  }
  const normalized = value.trim().normalize("NFC");
  const length = codePointLength(normalized);
  if (length < 1 || length > max) {
    throw new DomainError("INVALID_VALUE", `${field} must be 1 to ${max} characters`, field);
  }
  return normalized;
}
