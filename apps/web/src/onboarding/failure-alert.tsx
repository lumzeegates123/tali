import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { describeFailure } from "../lib/api-client/failure-messages";

/** An error message for a failed request, with a retry button when repeating it may help. */
export function FailureAlert({
  failure,
  onRetry,
  retryLabel = "Try again",
  retryDisabled = false,
  notFoundScope,
}: {
  readonly failure: ApiFailure | { readonly kind: "missing-default-location" };
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly retryDisabled?: boolean;
  readonly notFoundScope?: "business" | "resource";
}) {
  const message = describeFailure(failure, notFoundScope === undefined ? {} : { notFoundScope });
  return (
    <div role="alert" className="alert">
      <p>{message.text}</p>
      {message.retryable && onRetry !== undefined ? (
        <button type="button" onClick={onRetry} disabled={retryDisabled}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
