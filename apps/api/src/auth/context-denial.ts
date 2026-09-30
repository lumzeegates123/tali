import { ApplicationError } from "@tali/application";
import type { Logger } from "../observability/logger.js";

/** Bounded reason codes for `context.denied` (plan 003 section 11). */
export type ContextDenialReason = "user_not_registered" | "user_disabled" | "business_not_accessible";

const REASON_BY_CODE: Readonly<Record<string, ContextDenialReason>> = {
  USER_NOT_REGISTERED: "user_not_registered",
  USER_DISABLED: "user_disabled",
  NOT_FOUND: "business_not_accessible",
};

/**
 * Logs a context-resolution denial with IDs and a reason code only, then
 * rethrows the original error unchanged so the error filter maps it.
 */
export function logContextDenial(logger: Logger, error: unknown, ids: { readonly userId?: string } = {}): never {
  const reason = error instanceof ApplicationError ? REASON_BY_CODE[error.code] : undefined;
  if (reason !== undefined) logger.info("context.denied", { reason, ...ids });
  throw error;
}
