import type { Uuid } from "@tali/domain";
import { parseUuid } from "@tali/domain";
import { IdempotencyKeyRequiredError, ValidationError } from "../errors/application-error.js";

declare const idempotencyKeyBrand: unique symbol;

/** A client-generated UUID of any RFC 9562 version, one per logical attempt (ADR-004 section 4.1). */
export type IdempotencyKey = Uuid & { readonly [idempotencyKeyBrand]: true };

/** Missing gives IDEMPOTENCY_KEY_REQUIRED; malformed gives VALIDATION_FAILED. */
export function requireIdempotencyKey(value: string | undefined): IdempotencyKey {
  if (value === undefined) throw new IdempotencyKeyRequiredError();
  try {
    return parseUuid(value) as IdempotencyKey;
  } catch {
    throw new ValidationError("The idempotency key must be a UUID", [{ path: ["idempotencyKey"], message: "invalid" }]);
  }
}
