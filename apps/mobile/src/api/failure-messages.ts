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
  DEPENDENCY_UNAVAILABLE: { text: "Tali is temporarily unavailable. Try again shortly.", retryable: true },
  RATE_LIMITED: { text: "Too many attempts. Wait a minute, then try again.", retryable: true },
  // The local registration is cleared when this arrives, so trying again proceeds without the device.
  DEVICE_NOT_TRUSTED: { text: "This device needs to be registered again.", retryable: true },
};

/**
 * Plain-language text for a failed API call. Server messages, bodies and
 * internal details are never shown; unknown codes get a generic message and
 * no invented meaning.
 */
export function describeFailure(failure: ApiFailure | { readonly kind: "missing-default-location" }): FailureMessage {
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
