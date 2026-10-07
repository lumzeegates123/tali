import type { ApiFailure } from "./tali-api-client";

export interface FailureMessage {
  readonly text: string;
  /** Whether repeating the same request may succeed (transport failures and transient server states). */
  readonly retryable: boolean;
}

const API_ERROR_MESSAGES: Readonly<Record<string, FailureMessage>> = {
  UNAUTHENTICATED: { text: "Your session has ended. Sign in again.", retryable: false },
  USER_NOT_REGISTERED: { text: "Finish setting up your profile to continue.", retryable: false },
  USER_DISABLED: { text: "This Tali account is disabled and cannot be used.", retryable: false },
  NOT_FOUND: { text: "This business is not available.", retryable: false },
  PERMISSION_DENIED: { text: "This is not available with your access.", retryable: false },
  VALIDATION_FAILED: { text: "Some details were not accepted. Check them and try again.", retryable: false },
  IDEMPOTENCY_KEY_REQUIRED: { text: "The request could not be sent safely. Try again.", retryable: true },
  IDEMPOTENCY_KEY_REUSED: {
    text: "This submission conflicts with an earlier one. Review the details and submit again.",
    retryable: false,
  },
  IDEMPOTENCY_IN_PROGRESS: {
    text: "Your earlier request is still being processed. Try again in a moment.",
    retryable: true,
  },
  CONCURRENT_MODIFICATION: { text: "Tali was busy with another change. Try again.", retryable: true },
  VERSION_CONFLICT: {
    text: "This record changed since you opened it. Reload to see the latest.",
    retryable: false,
  },
  CONFLICT: {
    text: "This conflicts with an existing record, for example a SKU, barcode or name already in use.",
    retryable: false,
  },
  DEPENDENCY_UNAVAILABLE: { text: "Tali is temporarily unavailable. Try again shortly.", retryable: true },
  RATE_LIMITED: { text: "Too many attempts. Wait a minute, then try again.", retryable: true },
  // The local registration is cleared when this arrives, so trying again proceeds without the device.
  DEVICE_NOT_TRUSTED: { text: "This device needs to be registered again.", retryable: true },
};

/** NOT_FOUND wording by what was asked for; a resource may be hidden by tenancy, so its text stays neutral. */
const NOT_FOUND_MESSAGES: Readonly<Record<"business" | "resource", FailureMessage>> = {
  business: { text: "This business is no longer available to you.", retryable: false },
  resource: {
    text: "This item is not available. It may have been removed, or you may no longer have access to it.",
    retryable: false,
  },
};

/**
 * Plain-language text for a failed API call. Server messages, bodies and
 * internal details are never shown; unknown codes get a generic message and
 * no invented meaning. `notFoundScope` selects the NOT_FOUND wording for
 * business-scoped requests.
 */
export function describeFailure(
  failure: ApiFailure | { readonly kind: "missing-default-location" },
  options: { readonly notFoundScope?: "business" | "resource" } = {},
): FailureMessage {
  if (failure.kind === "api-error" && failure.code === "NOT_FOUND" && options.notFoundScope !== undefined) {
    return NOT_FOUND_MESSAGES[options.notFoundScope];
  }
  switch (failure.kind) {
    case "unavailable":
      return failure.reason === "timeout"
        ? { text: "Tali did not respond in time. Check your connection and try again.", retryable: true }
        : { text: "Tali could not be reached. Check your connection and try again.", retryable: true };
    case "invalid-response":
      return { text: "Tali sent a response this app could not read. Try again later.", retryable: true };
    case "missing-default-location":
      return { text: "The business location could not be loaded. Try again later.", retryable: true };
    case "api-error":
      return (
        API_ERROR_MESSAGES[failure.code] ?? {
          text: "Something went wrong. Try again.",
          retryable: failure.status >= 500,
        }
      );
  }
}

/** Fields named by a VALIDATION_FAILED response, for field-level messages. */
export function rejectedFields(failure: ApiFailure | undefined): readonly string[] {
  return failure?.kind === "api-error" && failure.code === "VALIDATION_FAILED" ? failure.fields : [];
}
