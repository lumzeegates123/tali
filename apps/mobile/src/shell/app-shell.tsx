import type { ConfigurationIssue, PublicConfig } from "@tali/config/public";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { MobileConfigResult } from "../config/mobile-config";

function EnvironmentPanel({ config }: { readonly config: PublicConfig }) {
  if (config.env === "production") return null;
  return (
    <View testID="environment-panel" style={styles.panel}>
      <Text testID="environment-name">Environment: {config.env}</Text>
      <Text>API: {config.apiBaseUrl}</Text>
      <Text>Cognito client settings: {config.cognito === undefined ? "not configured" : "configured"}</Text>
    </View>
  );
}

function ConfigurationProblem({ issues }: { readonly issues: readonly ConfigurationIssue[] }) {
  return (
    <View testID="configuration-problem" accessibilityRole="alert" style={styles.panel}>
      <Text style={styles.heading}>Configuration error</Text>
      <Text>This build has invalid public configuration and cannot reach the Tali API.</Text>
      {issues.map((issue) => (
        <Text key={issue.key}>
          {issue.key}: {issue.message}
        </Text>
      ))}
    </View>
  );
}

/** Root shell: environment display (non-production) or the configuration problem, then the screen content. */
export function AppShell({
  result,
  children,
}: {
  readonly result: MobileConfigResult;
  readonly children?: (config: PublicConfig) => ReactNode;
}) {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        Tali
      </Text>
      <Text>Foundation shell</Text>
      {result.ok ? (
        <>
          <EnvironmentPanel config={result.config} />
          {children?.(result.config)}
        </>
      ) : (
        <ConfigurationProblem issues={result.issues} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8 },
  title: { fontSize: 24, fontWeight: "700" },
  heading: { fontSize: 18, fontWeight: "600" },
  panel: { gap: 4, paddingVertical: 8 },
});
