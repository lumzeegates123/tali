import { useState } from "react";
import { Text, View } from "react-native";
import type { CognitoAuth, CognitoFailure } from "../auth/cognito-auth";
import { useSession, useSessionStore } from "../auth/session-context";
import type { SessionNotice } from "../auth/session-store";
import { Button, Field, Heading, styles } from "./ui";

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
 * section 14.3, ADR-007). The password goes only to the SRP implementation:
 * it is cleared from component state on submit, never sent to the Tali API,
 * never stored and never logged. After sign-in the session store calls
 * `GET /v1/me`, which leads to registration or the business picker.
 */
export function CognitoSignIn({ auth }: { readonly auth: CognitoAuth }) {
  const store = useSessionStore();
  const session = useSession();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const busy = pending || session.pending !== undefined;

  function switchTo(next: Mode, nextMessage?: Message) {
    setMode(next);
    setPassword("");
    setCode("");
    setFieldErrors({});
    setMessage(nextMessage);
  }

  async function submitSignIn() {
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

  async function submitSignUp() {
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

  async function submitConfirm() {
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
    <Field
      label="Email address"
      value={email}
      onChangeText={setEmail}
      error={fieldErrors["email"]}
      editable={!busy}
      autoComplete="email"
      keyboardType="email-address"
    />
  );
  return (
    <View style={styles.screen}>
      <Heading>{heading}</Heading>
      {session.notice === undefined || message !== undefined ? null : (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {NOTICE_TEXT[session.notice]}
        </Text>
      )}
      {message === undefined ? null : (
        <Text
          testID="cognito-message"
          style={message.tone === "error" ? styles.alert : styles.notice}
          accessibilityRole={message.tone === "error" ? "alert" : "text"}
          accessibilityLiveRegion={message.tone === "error" ? "assertive" : "polite"}
        >
          {message.text}
        </Text>
      )}
      {mode === "signIn" ? (
        <>
          {emailField}
          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            error={fieldErrors["password"]}
            editable={!busy}
            secret
            autoComplete="password"
          />
          <Button label="Sign in" onPress={() => void submitSignIn()} disabled={busy} busy={pending} />
          <Button
            label="Create an account"
            onPress={() => {
              switchTo("signUp");
            }}
            disabled={busy}
            secondary
          />
        </>
      ) : null}
      {mode === "signUp" ? (
        <>
          {emailField}
          <Field
            label="New password"
            hint="At least 8 characters. Do not reuse a password from another service."
            value={password}
            onChangeText={setPassword}
            error={fieldErrors["password"]}
            editable={!busy}
            secret
            autoComplete="new-password"
          />
          <Button label="Create account" onPress={() => void submitSignUp()} disabled={busy} busy={pending} />
          <Button
            label="I already have an account"
            onPress={() => {
              switchTo("signIn");
            }}
            disabled={busy}
            secondary
          />
        </>
      ) : null}
      {mode === "confirm" ? (
        <>
          {emailField}
          <Field
            label="Confirmation code"
            value={code}
            onChangeText={setCode}
            error={fieldErrors["code"]}
            editable={!busy}
            autoComplete="one-time-code"
            keyboardType="number-pad"
          />
          <Button label="Confirm email" onPress={() => void submitConfirm()} disabled={busy} busy={pending} />
          <Button label="Send a new code" onPress={() => void resend()} disabled={busy} secondary />
          <Button
            label="Back to sign in"
            onPress={() => {
              switchTo("signIn");
            }}
            disabled={busy}
            secondary
          />
        </>
      ) : null}
    </View>
  );
}
