import type { ReadinessResponse } from "@tali/shared";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ApiFailure } from "../api/tali-api-client";
import { TaliApiClient } from "../api/tali-api-client";

type HealthState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready" | "not-ready"; readonly readiness: ReadinessResponse; readonly correlationId?: string }
  | { readonly phase: "failed"; readonly failure: ApiFailure };

function describeFailure(failure: ApiFailure): { title: string; detail: string } {
  switch (failure.kind) {
    case "unavailable":
      return {
        title: "Tali API unavailable",
        detail: failure.reason === "timeout" ? "The API did not respond in time." : "The API could not be reached.",
      };
    case "api-error":
      return { title: "Tali API error", detail: `${failure.code}: ${failure.message}` };
    case "invalid-response":
      return { title: "Unexpected API response", detail: `HTTP ${failure.status} did not match the health contract.` };
  }
}

/** Calls `GET /health/ready` and shows loading, ready, not-ready and failure states. */
export function ApiHealth({ client }: { readonly client: TaliApiClient }) {
  const [state, setState] = useState<HealthState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void client.getReadiness().then((result) => {
      if (!active) return;
      if (result.ok) {
        setState({
          phase: result.value.status === "ready" ? "ready" : "not-ready",
          readiness: result.value,
          ...(result.correlationId === undefined ? {} : { correlationId: result.correlationId }),
        });
      } else {
        setState({ phase: "failed", failure: result.failure });
      }
    });
    return () => {
      active = false;
    };
  }, [client, attempt]);

  const retry = useCallback(() => {
    setState({ phase: "loading" });
    setAttempt((value) => value + 1);
  }, []);

  let body;
  switch (state.phase) {
    case "loading":
      body = (
        <Text testID="health-loading" accessibilityRole="progressbar">
          Checking the Tali API…
        </Text>
      );
      break;
    case "ready":
    case "not-ready":
      body = (
        <View testID={`health-${state.phase}`}>
          <Text style={styles.status}>{state.phase === "ready" ? "Tali API is ready" : "Tali API is not ready"}</Text>
          <Text>Database: {state.readiness.checks.database}</Text>
          {state.correlationId === undefined ? null : <Text selectable>Correlation ID: {state.correlationId}</Text>}
        </View>
      );
      break;
    case "failed": {
      const { title, detail } = describeFailure(state.failure);
      body = (
        <View testID="health-failed" accessibilityRole="alert">
          <Text style={styles.status}>{title}</Text>
          <Text>{detail}</Text>
        </View>
      );
      break;
    }
  }

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        API health
      </Text>
      {body}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: state.phase === "loading" }}
        disabled={state.phase === "loading"}
        onPress={retry}
        style={styles.button}
      >
        <Text>Check again</Text>
      </Pressable>
    </View>
  );
}

/** Builds the device-side API client from the public API base URL. */
export function ApiHealthPanel({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const client = useMemo(
    () => new TaliApiClient({ baseUrl: apiBaseUrl, createCorrelationId: randomUUID }),
    [apiBaseUrl],
  );
  return <ApiHealth client={client} />;
}

const styles = StyleSheet.create({
  section: { gap: 8, paddingVertical: 12 },
  heading: { fontSize: 18, fontWeight: "600" },
  status: { fontWeight: "600" },
  button: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 6 },
});
