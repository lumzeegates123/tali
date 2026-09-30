import { RegisterCurrentUserRequestSchema } from "@tali/shared";
import type { SyntheticEvent } from "react";
import { useState } from "react";
import { rejectedFields } from "../lib/api-client/failure-messages";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { FailureAlert } from "./failure-alert";
import { ScreenHeading } from "./screen-heading";
import { TextField } from "./text-field";

/** `POST /v1/me/registration`: the display name is the only field the contract accepts. */
export function RegistrationForm() {
  const store = useSessionStore();
  const session = useSession();
  const [displayName, setDisplayName] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const submitting = session.pending === "register";
  const failure = session.error?.action === "register" ? session.error.failure : undefined;
  const serverRejectedName = rejectedFields(failure).includes("displayName");

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = displayName.trim();
    const parsed = RegisterCurrentUserRequestSchema.safeParse({ displayName: value });
    if (value === "" || !parsed.success) {
      setFieldError(value === "" ? "Enter your name." : "This name is too long.");
      return;
    }
    setFieldError(undefined);
    void store.register(parsed.data.displayName);
  }

  return (
    <section aria-labelledby="registration-heading" className="onboarding">
      <ScreenHeading id="registration-heading">Set up your profile</ScreenHeading>
      <p>You are signed in, but this identity has no Tali profile yet. Tell us the name your team will see.</p>
      <form onSubmit={submit} noValidate aria-busy={submitting}>
        <TextField
          id="display-name"
          label="Your name"
          value={displayName}
          onChange={setDisplayName}
          disabled={submitting}
          autoComplete="name"
          error={fieldError ?? (serverRejectedName ? "Tali did not accept this name." : undefined)}
        />
        {failure === undefined || serverRejectedName ? null : <FailureAlert failure={failure} />}
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving your profile…" : "Continue"}
        </button>
      </form>
    </section>
  );
}
