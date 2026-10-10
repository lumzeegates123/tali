import type { Uuid } from "@tali/domain";
import { parseUuid } from "@tali/domain";
import { ValidationError } from "../errors/application-error.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * Keyset pagination for list use cases (50-api.mdc). The cursor is the last
 * returned record ID; ordering by ID is a stable listing order only, never
 * business time.
 */
export interface PageRequest {
  readonly limit: number;
  readonly after?: Uuid;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** The cursor for the next page, or null on the last page. */
  readonly nextCursor: string | null;
}

export function parsePageRequest(input: { readonly limit?: number; readonly after?: string } = {}): PageRequest {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`, [
      { path: ["limit"], message: "out of range" },
    ]);
  }
  if (input.after === undefined) return { limit };
  try {
    return { limit, after: parseUuid(input.after) };
  } catch {
    throw invalidCursorError();
  }
}

/**
 * A malformed cursor, or one that does not resolve within the listed
 * collection. One error for every cause, so a cursor never reveals whether it
 * belongs to another business, location or record.
 */
export function invalidCursorError(): ValidationError {
  return new ValidationError("after must be a cursor returned by a previous page", [
    { path: ["after"], message: "invalid cursor" },
  ]);
}
