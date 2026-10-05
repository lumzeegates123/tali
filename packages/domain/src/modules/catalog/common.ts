import { DomainError } from "../../errors.js";

/** Product, variant and category lifecycle (ADR-008 section 3). Archive is never deletion. */
export const CATALOG_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export function validInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

export function validVersion(value: number, field = "version"): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("INVALID_VALUE", `${field} must be a positive integer`, field);
  }
  return value;
}

export function validCatalogStatus(value: string): CatalogStatus {
  if (!(CATALOG_STATUSES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown catalog status", "status");
  }
  return value as CatalogStatus;
}

/**
 * Optimistic concurrency (ADR-008 section 9). Checked before deciding whether
 * the request is a no-op: a stale expectedVersion is VERSION_CONFLICT even when
 * the requested state already holds.
 */
export function requireExpectedVersion(current: number, expected: number): void {
  validVersion(expected, "expectedVersion");
  if (current !== expected) {
    throw new DomainError("VERSION_CONFLICT", "the record has changed since it was read", "expectedVersion");
  }
}
