import { LocalSignInRequestSchema } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useState } from "react";
import { rejectedFields } from "../lib/api-client/failure-messages";
import type { SessionNotice } from "../lib/auth/session-store";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "./failure-alert";
import { ScreenHeading } from "./screen-heading";
import { TextField } from "./text-field";

const NOTICE_TEXT: Record<SessionNotice, string> = {
  signedOut: "You have signed out.",
  sessionEnded: "Your session has ended. Sign in again.",
  businessUnavailable: "That business is no longer available to you.",
  invitationAccepted: "Invitation accepted.",
};

/**
 * LOCAL DEVELOPMENT sign-in: asserts a local subject through
 * `POST /__local/sign-in`. Not a production sign-in method; rendered only
 * when the public configuration says TALI_ENV=local.
 */
export function LocalSignInForm() {
  const store = useSessionStore();
  const session = useSession();
  const [subject, setSubject] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const failure = session.error?.action === "signIn" ? session.error.failure : undefined;
  const serverRejectedSubject = rejectedFields(failure).includes("subject");

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = LocalSignInRequestSchema.safeParse({ subject: subject.trim() });
    if (!parsed.success) {
      setFieldError(`The subject ${parsed.error.issues[0]?.message ?? "is not valid"}.`);
      return;
    }
    setFieldError(undefined);
    void store.signInLocal(parsed.data.subject);
  }

  return (
    <section aria-labelledby="sign-in-heading" className="onboarding">
      <ScreenHeading id="sign-in-heading">Local development sign-in</ScreenHeading>
      {session.notice === undefined ? null : (
        <p role="status" className="notice">
          {NOTICE_TEXT[session.notice]}
        </p>
      )}
      <p className="dev-only">
        Development only. This build uses the local identity provider, which is not a production sign-in method. Enter
        any local subject to act as that local identity.
      </p>
      <form onSubmit={submit} noValidate>
        <TextField
          id="local-subject"
          label="Local subject"
          hint="For example local-user-ada. Letters, digits, '.', '_' or '-'."
          value={subject}
          onChange={setSubject}
          error={fieldError ?? (serverRejectedSubject ? "Tali did not accept this subject." : undefined)}
        />
        {failure === undefined || serverRejectedSubject ? null : <FailureAlert failure={failure} />}
        <button type="submit" disabled={session.pending !== undefined}>
          Sign in (local development)
        </button>
      </form>
    </section>
  );
}
