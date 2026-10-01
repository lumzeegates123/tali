import type { SyntheticEvent } from "react";
import { useEffect, useState } from "react";
import type { CognitoAuth, CognitoFailure } from "../lib/auth/cognito-auth";
import type { SessionNotice } from "../lib/auth/session-store";
import { useSession, useSessionStore } from "../lib/auth/session-context";
import { ScreenHeading } from "./screen-heading";
import { TextField } from "./text-field";

const NOTICE_TEXT: Record<SessionNotice, string> = {
  signedOut: "You have signed out.",
  sessionEnded: "Your session has ended. Sign in again.",
  businessUnavailable: "That business is no longer available to you.",
  invitationAccepted: "Invitation accepted.",
};

/** Bounded wording: Cognito's own messages, codes and challenge details are never shown. */
const FAILURE_TEXT: Record<CognitoFailure, string> = {
  invalidCredentials: "The email or password is not correct.",
  accountExists: "An account with this email already exists. Sign in instead.",
  passwordRejected: "This password was not accepted. Choose a longer password with a mix of characters.",
  invalidEmail: "Enter a valid email address.",
  invalidCode: "That code is not correct. Check it and try again.",
  expiredCode: "That code has expired. Send a new code.",
  tooManyAttempts: "Too many attempts. Wait a few minutes, then try again.",
  unavailable: "The sign-in service could not be reached. Check your connection and try again.",
  unknown: "Something went wrong. Try again.",
};

export const UNSUPPORTED_STEP_TEXT =
  "This account needs an extra sign-in step that this version of Tali cannot complete. Contact Tali support.";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const CODE = /^\d{4,10}$/u;

type Mode = "signIn" | "signUp" | "confirm";
type Message = { readonly tone: "error" | "info"; readonly text: string } | undefined;

function validEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/**
 * Cognito sign-in, sign-up and email confirmation in Tali's own UI (ADR-003
 * section 14.3). The password goes only to the SRP implementation: it is
 * cleared from component state on submit, never sent to the Tali API, never
 * put in a URL (the forms post nowhere and stay disabled until hydrated) and
 * never logged. After sign-in the session store calls `GET /v1/me`, which
 * leads to registration or the business picker exactly as before.
 */
export function CognitoSignIn({ auth }: { readonly auth: CognitoAuth }) {
  const store = useSessionStore();
  const session = useSession();
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    setHydrated(true);
  }, []);
  const busy = !hydrated || pending || session.pending !== undefined;

  function switchTo(next: Mode, nextMessage?: Message) {
    setMode(next);
    setPassword("");
    setCode("");
    setFieldErrors({});
    setMessage(nextMessage);
  }

  async function submitSignIn(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    const secret = password;
    setPassword("");
    const errors: Record<string, string> = {};
    if (!validEmail(address)) errors["email"] = "Enter a valid email address.";
    if (secret === "") errors["password"] = "Enter your password.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPending(true);
    setMessage(undefined);
    const result = await auth.signIn(address, secret);
    setPending(false);
    switch (result.status) {
      case "signedIn":
        await store.beginSession(result.session);
        return;
      case "confirmationRequired":
        switchTo("confirm", { tone: "info", text: "Confirm your email address to finish setting up your account." });
        return;
      case "unsupportedStep":
        setMessage({ tone: "error", text: UNSUPPORTED_STEP_TEXT });
        return;
      case "failed":
        setMessage({ tone: "error", text: FAILURE_TEXT[result.reason] });
        return;
    }
  }

  async function submitSignUp(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    const secret = password;
    setPassword("");
    const errors: Record<string, string> = {};
    if (!validEmail(address)) errors["email"] = "Enter a valid email address.";
    if (secret.length < 8) errors["password"] = "Use at least 8 characters.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPending(true);
    setMessage(undefined);
    const result = await auth.signUp(address, secret);
    setPending(false);
    if (result.status === "failed") {
      setMessage({ tone: "error", text: FAILURE_TEXT[result.reason] });
      return;
    }
    if (result.status === "complete") {
      switchTo("signIn", { tone: "info", text: "Your account is ready. Sign in." });
      return;
    }
    switchTo("confirm", { tone: "info", text: "We sent a confirmation code to your email address." });
  }

  async function submitConfirm(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    const value = code.trim();
    const errors: Record<string, string> = {};
    if (!validEmail(address)) errors["email"] = "Enter a valid email address.";
    if (!CODE.test(value)) errors["code"] = "Enter the code from the email.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPending(true);
    setMessage(undefined);
    const result = await auth.confirmSignUp(address, value);
    setPending(false);
    if (result.status === "failed") {
      setMessage({ tone: "error", text: FAILURE_TEXT[result.reason] });
      return;
    }
    switchTo("signIn", { tone: "info", text: "Your email address is confirmed. Sign in." });
  }

  async function resend() {
    const address = email.trim();
    if (!validEmail(address)) {
      setFieldErrors({ email: "Enter a valid email address." });
      return;
    }
    setPending(true);
    setMessage(undefined);
    const result = await auth.resendSignUpCode(address);
    setPending(false);
    setMessage(
      result.status === "sent"
        ? { tone: "info", text: "We sent a new code to your email address." }
        : { tone: "error", text: FAILURE_TEXT[result.reason] },
    );
  }

  const heading = mode === "signIn" ? "Sign in" : mode === "signUp" ? "Create your account" : "Confirm your email";
  const emailField = (
    <TextField
      id="cognito-email"
      label="Email address"
      type="email"
      autoComplete="username"
      value={email}
      onChange={setEmail}
      error={fieldErrors["email"]}
      disabled={busy}
    />
  );
  return (
    <section aria-labelledby="sign-in-heading" className="onboarding">
      <ScreenHeading id="sign-in-heading">{heading}</ScreenHeading>
      {session.notice === undefined || message !== undefined ? null : (
        <p role="status" className="notice">
          {NOTICE_TEXT[session.notice]}
        </p>
      )}
      {message === undefined ? null : (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={message.tone === "error" ? "failure" : "notice"}
          data-testid="cognito-message"
        >
          {message.text}
        </p>
      )}
      {mode === "signIn" ? (
        <form method="post" onSubmit={(event) => void submitSignIn(event)} noValidate>
          {emailField}
          <TextField
            id="cognito-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={fieldErrors["password"]}
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            Sign in
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              switchTo("signUp");
            }}
          >
            Create an account
          </button>
        </form>
      ) : null}
      {mode === "signUp" ? (
        <form method="post" onSubmit={(event) => void submitSignUp(event)} noValidate>
          {emailField}
          <TextField
            id="cognito-new-password"
            label="Password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters. Do not reuse a password from another service."
            value={password}
            onChange={setPassword}
            error={fieldErrors["password"]}
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            Create account
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              switchTo("signIn");
            }}
          >
            I already have an account
          </button>
        </form>
      ) : null}
      {mode === "confirm" ? (
        <form method="post" onSubmit={(event) => void submitConfirm(event)} noValidate>
          {emailField}
          <TextField
            id="cognito-code"
            label="Confirmation code"
            autoComplete="one-time-code"
            value={code}
            onChange={setCode}
            error={fieldErrors["code"]}
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            Confirm email
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void resend()}>
            Send a new code
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              switchTo("signIn");
            }}
          >
            Back to sign in
          </button>
        </form>
      ) : null}
    </section>
  );
}
