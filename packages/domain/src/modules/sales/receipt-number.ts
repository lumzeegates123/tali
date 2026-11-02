import { DomainError } from "../../errors.js";

/**
 * Online receipt numbers (ADR-011 section 8). Display only. Future offline
 * numbers must not match this pattern.
 */
export const ONLINE_RECEIPT_NUMBER = /^S-[0-9]{6,}$/;

export function formatOnlineReceiptNumber(sequence: bigint): string {
  if (sequence < 1n) {
    throw new DomainError("INVALID_VALUE", "receipt sequence must be at least 1", "receiptNumber");
  }
  return `S-${sequence.toString().padStart(6, "0")}`;
}

export function parseOnlineReceiptNumber(value: string): string {
  if (!ONLINE_RECEIPT_NUMBER.test(value)) {
    throw new DomainError("INVALID_VALUE", "receipt number must match S- and at least six digits", "receiptNumber");
  }
  return value;
}
