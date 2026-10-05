import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { describeFailure } from "../api/failure-messages";

/** Small building blocks for the onboarding screens; not a design system. */

export function Heading({ children }: { readonly children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}

export function Loading({ label }: { readonly label: string }) {
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
    >
      <ActivityIndicator />
      <Text>{label}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled = false,
  busy = false,
  secondary = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary ? styles.secondary : styles.primary, disabled ? styles.disabled : null]}
    >
      <Text style={secondary ? styles.secondaryText : styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  hint,
  error,
  editable = true,
  secret = false,
  autoComplete,
  keyboardType,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly editable?: boolean;
  /** A password: masked, and excluded from keyboard learning and suggestions. */
  readonly secret?: boolean;
  readonly autoComplete?: "email" | "password" | "new-password" | "one-time-code";
  readonly keyboardType?: "email-address" | "number-pad";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        accessibilityState={{ disabled: !editable }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secret}
        {...(autoComplete === undefined ? {} : { autoComplete })}
        {...(keyboardType === undefined ? {} : { keyboardType })}
        style={[styles.input, error === undefined ? null : styles.invalid]}
      />
      {error === undefined ? null : (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          Error: {error}
        </Text>
      )}
    </View>
  );
}

export function FailureNotice({
  failure,
  onRetry,
  retryLabel = "Try again",
  retryDisabled = false,
}: {
  readonly failure: ApiFailure | { readonly kind: "missing-default-location" };
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly retryDisabled?: boolean;
}) {
  const message = describeFailure(failure);
  return (
    <View style={styles.alert} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Text>{message.text}</Text>
      {message.retryable && onRetry !== undefined ? (
        <Button label={retryLabel} onPress={onRetry} disabled={retryDisabled} secondary />
      ) : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { gap: 12, paddingVertical: 12 },
  heading: { fontSize: 20, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  field: { gap: 4 },
  label: { fontWeight: "600" },
  hint: { color: "#4a4a45" },
  input: { borderWidth: 1, borderColor: "#8a8a84", borderRadius: 4, paddingHorizontal: 10, paddingVertical: 8 },
  invalid: { borderWidth: 2, borderColor: "#a11d1d" },
  error: { color: "#a11d1d", fontWeight: "600" },
  alert: { gap: 8, padding: 10, borderLeftWidth: 4, borderLeftColor: "#a11d1d", backgroundColor: "#fbeeee" },
  notice: { padding: 10, borderLeftWidth: 4, borderLeftColor: "#1c1c1a", backgroundColor: "#efefea" },
  devOnly: { padding: 10, borderWidth: 1, borderStyle: "dashed", borderColor: "#8a6d00", backgroundColor: "#fff8e0" },
  button: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 4, paddingHorizontal: 14, paddingVertical: 8 },
  primary: { backgroundColor: "#1c1c1a", borderColor: "#1c1c1a" },
  secondary: { backgroundColor: "#ffffff", borderColor: "#1c1c1a" },
  disabled: { opacity: 0.6 },
  primaryText: { color: "#f7f7f5" },
  secondaryText: { color: "#1c1c1a" },
  card: { gap: 2, padding: 12, borderWidth: 1, borderColor: "#d8d8d2", borderRadius: 6, alignSelf: "stretch" },
  strong: { fontWeight: "600" },
});
