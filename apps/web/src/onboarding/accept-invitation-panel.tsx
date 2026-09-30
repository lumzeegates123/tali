import type { ApiFailure } from "../lib/api-client/tali-api-client";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "./failure-alert";

/** Accept failures with invitation-specific wording; one text for every unusable invitation (ADR-005 hiding). */
function acceptFailureText(failure: ApiFailure): string | undefined {
  if (failure.kind !== "api-error") return undefined;
  switch (failure.code) {
    case "NOT_FOUND":
    case "VALIDATION_FAILED":
      return "This invitation cannot be used. It may have expired, been revoked or already been used. Ask for a new invitation.";
    case "CONFLICT":
      return "You are already a member of this business, or your membership is suspended. Ask an owner for help.";
    default:
      return undefined;
  }
}

/**
 * Accepting an invitation from an opened link. The token itself stays in the
 * session store's memory and is never shown; this panel only offers the
 * action once the user is signed in and registered.
 */
export function AcceptInvitationPanel() {
  const store = useSessionStore();
  const session = useSession();
  const failure = session.error?.action === "acceptInvitation" ? session.error.failure : undefined;
  if (!session.hasPendingInvitation && failure === undefined) return null;
  const accepting = session.pending === "acceptInvitation";
  const specific = failure === undefined ? undefined : acceptFailureText(failure);

  return (
    <section aria-labelledby="accept-invitation-heading" className="onboarding">
      <h2 id="accept-invitation-heading">Invitation</h2>
      {session.hasPendingInvitation ? <p>You have been invited to join a business on Tali.</p> : null}
      {specific !== undefined ? (
        <div role="alert" className="alert">
          <p>{specific}</p>
        </div>
      ) : failure === undefined ? null : (
        <FailureAlert
          failure={failure}
          onRetry={() => {
            void store.acceptInvitation();
          }}
          retryDisabled={accepting}
        />
      )}
      {session.hasPendingInvitation ? (
        <div className="actions">
          <button
            type="button"
            disabled={accepting}
            onClick={() => {
              void store.acceptInvitation();
            }}
          >
            {accepting ? "Accepting invitation…" : "Accept invitation"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={accepting}
            onClick={() => {
              store.discardInvitation();
            }}
          >
            Not now
          </button>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              store.discardInvitation();
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
