import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { useSession, useSessionStore } from "../auth/session-context";
import { DEVICE_LABEL_MAX } from "../auth/session-store";
import { Button, FailureNotice, Field, styles } from "./ui";

/** One text for every unusable invitation (ADR-005 hiding), and for membership conflicts. */
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

type AcceptMessage = { readonly kind: "invalid" } | { readonly kind: "failed"; readonly failure: ApiFailure };

/**
 * Join a business by pasting an invitation link or code. The value is kept
 * in this component's memory only while typing and is cleared once sent.
 */
export function AcceptInvitationPanel() {
  const store = useSessionStore();
  const session = useSession();
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<AcceptMessage | undefined>(undefined);
  const accepting = session.pending === "acceptInvitation";

  function submit() {
    setMessage(undefined);
    const pasted = value;
    setValue("");
    void store.acceptInvitation(pasted).then((outcome) => {
      if (outcome.status === "invalid") setMessage({ kind: "invalid" });
      else if (outcome.status === "failed") setMessage({ kind: "failed", failure: outcome.failure });
    });
  }

  const specific = message?.kind === "failed" ? acceptFailureText(message.failure) : undefined;
  return (
    <View style={styles.screen}>
      <Text accessibilityRole="header" style={styles.strong}>
        Join a business
      </Text>
      <View style={styles.field}>
        <Text style={styles.label}>Invitation link or code</Text>
        <Text style={styles.hint}>Paste the invitation link you were sent. It can be used once.</Text>
        <TextInput
          accessibilityLabel="Invitation link or code"
          value={value}
          onChangeText={setValue}
          editable={!accepting}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          style={styles.input}
        />
      </View>
      {message?.kind === "invalid" ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          Error: Paste the whole invitation link, or the code from it.
        </Text>
      ) : null}
      {specific !== undefined ? (
        <View style={styles.alert} accessibilityRole="alert">
          <Text>{specific}</Text>
        </View>
      ) : message?.kind === "failed" ? (
        <FailureNotice failure={message.failure} />
      ) : null}
      <Button
        label={accepting ? "Accepting invitation…" : "Accept invitation"}
        onPress={submit}
        disabled={accepting || value.trim() === ""}
        busy={accepting}
      />
    </View>
  );
}

type RegisterMessage =
  | { readonly kind: "invalid" }
  | { readonly kind: "failed"; readonly failure: ApiFailure }
  | { readonly kind: "credentialUnavailable" }
  | { readonly kind: "storageFailed" };

const REGISTER_TEXT: Record<Exclude<RegisterMessage["kind"], "failed">, string> = {
  invalid: `Enter a name for this device (1 to ${String(DEVICE_LABEL_MAX)} characters).`,
  credentialUnavailable:
    "This device was registered earlier, but its credential could not be received. Ask an owner to revoke that registration, then register again.",
  storageFailed:
    "The registration could not be saved on this device. Ask an owner to revoke the new registration, then try again.",
};

/**
 * Registration of this Android device for the selected business. A
 * registration never signs anyone in; it lets Tali recognise the device on
 * requests made by a signed-in member. Not rendered on other platforms.
 */
export function DevicePanel() {
  const store = useSessionStore();
  const session = useSession();
  const [label, setLabel] = useState("Android phone");
  const [message, setMessage] = useState<RegisterMessage | undefined>(undefined);
  const registering = session.pending === "registerDevice";

  if (session.device === "unsupported" || session.device === "none") return null;

  function register() {
    setMessage(undefined);
    void store.registerDevice(label).then((outcome) => {
      if (outcome.status === "failed") setMessage({ kind: "failed", failure: outcome.failure });
      else if (
        outcome.status === "invalid" ||
        outcome.status === "credentialUnavailable" ||
        outcome.status === "storageFailed"
      ) {
        setMessage({ kind: outcome.status });
      }
    });
  }

  return (
    <View style={styles.screen} testID="device-panel">
      <Text accessibilityRole="header" style={styles.strong}>
        This device
      </Text>
      {session.device === "checking" ? <Text>Checking this device…</Text> : null}
      {session.device === "registered" ? <Text>This device is registered for this business.</Text> : null}
      {session.device === "unavailable" ? (
        <Text>This device's registration could not be read. Restart the app to try again.</Text>
      ) : null}
      {session.device === "untrusted" ? (
        <View style={styles.alert} accessibilityRole="alert">
          <Text>This device needs to be registered again.</Text>
        </View>
      ) : null}
      {session.device === "unregistered" || session.device === "untrusted" ? (
        <>
          {session.device === "unregistered" ? <Text>This device is not registered for this business.</Text> : null}
          <Field
            label="Device name"
            hint="Shown to owners and managers, for example Front counter."
            value={label}
            onChangeText={setLabel}
            editable={!registering}
            error={message?.kind === "invalid" ? REGISTER_TEXT.invalid : undefined}
          />
          {message === undefined || message.kind === "invalid" ? null : message.kind === "failed" ? (
            <FailureNotice failure={message.failure} onRetry={register} retryDisabled={registering} />
          ) : (
            <View style={styles.alert} accessibilityRole="alert">
              <Text>{REGISTER_TEXT[message.kind]}</Text>
            </View>
          )}
          <Button
            label={registering ? "Registering this device…" : "Register this device"}
            onPress={register}
            disabled={registering}
            busy={registering}
          />
        </>
      ) : null}
    </View>
  );
}
