import { LocalSignInRequestSchema, RegisterCurrentUserRequestSchema } from "@tali/shared";
import { useState } from "react";
import { Text, View } from "react-native";
import { rejectedFields } from "../api/failure-messages";
import { useSession, useSessionStore } from "../auth/session-context";
import type { SessionNotice } from "../auth/session-store";
import { Button, FailureNotice, Field, Heading, styles } from "./ui";

const NOTICE_TEXT: Record<SessionNotice, string> = {
  signedOut: "You have signed out.",
  sessionEnded: "Your session has ended. Sign in again.",
  businessUnavailable: "That business is no longer available to you.",
  invitationAccepted: "Invitation accepted.",
};

/**
 * LOCAL DEVELOPMENT sign-in through `POST /__local/sign-in`. Not a
 * production sign-in method; shown only when TALI_ENV=local.
 */
export function LocalSignInScreen() {
  const store = useSessionStore();
  const session = useSession();
  const [subject, setSubject] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const failure = session.error?.action === "signIn" ? session.error.failure : undefined;
  const serverRejectedSubject = rejectedFields(failure).includes("subject");

  function submit() {
    const parsed = LocalSignInRequestSchema.safeParse({ subject: subject.trim() });
    if (!parsed.success) {
      setFieldError(`The subject ${parsed.error.issues[0]?.message ?? "is not valid"}.`);
      return;
    }
    setFieldError(undefined);
    void store.signInLocal(parsed.data.subject);
  }

  return (
    <View style={styles.screen}>
      <Heading>Local development sign-in</Heading>
      {session.notice === undefined ? null : (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {NOTICE_TEXT[session.notice]}
        </Text>
      )}
      <Text style={styles.devOnly}>
        Development only. This build uses the local identity provider, which is not a production sign-in method. Enter
        any local subject to act as that local identity.
      </Text>
      <Field
        label="Local subject"
        hint="For example local-user-ada. Letters, digits, '.', '_' or '-'."
        value={subject}
        onChangeText={setSubject}
        error={fieldError ?? (serverRejectedSubject ? "Tali did not accept this subject." : undefined)}
      />
      {failure === undefined || serverRejectedSubject ? null : <FailureNotice failure={failure} />}
      <Button label="Sign in (local development)" onPress={submit} disabled={session.pending !== undefined} />
    </View>
  );
}

/** `POST /v1/me/registration`: the display name is the only field the contract accepts. */
export function RegistrationScreen() {
  const store = useSessionStore();
  const session = useSession();
  const [displayName, setDisplayName] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const submitting = session.pending === "register";
  const failure = session.error?.action === "register" ? session.error.failure : undefined;
  const serverRejectedName = rejectedFields(failure).includes("displayName");

  function submit() {
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
    <View style={styles.screen}>
      <Heading>Set up your profile</Heading>
      <Text>You are signed in, but this identity has no Tali profile yet. Tell us the name your team will see.</Text>
      <Field
        label="Your name"
        value={displayName}
        onChangeText={setDisplayName}
        editable={!submitting}
        error={fieldError ?? (serverRejectedName ? "Tali did not accept this name." : undefined)}
      />
      {failure === undefined || serverRejectedName ? null : <FailureNotice failure={failure} />}
      <Button
        label={submitting ? "Saving your profile…" : "Continue"}
        onPress={submit}
        disabled={submitting}
        busy={submitting}
      />
    </View>
  );
}
