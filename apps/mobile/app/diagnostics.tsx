import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { readMobileConfig } from "../src/config/mobile-config";
import type { RuntimeReport } from "../src/diagnostics/runtime-report";
import { REPORT_LOG_PREFIX, runRuntimeReport } from "../src/diagnostics/runtime-report";
import { AppShell } from "../src/shell/app-shell";

/**
 * Non-production diagnostics (Wave C runtime compatibility): runs the kernel
 * bigint cases and the UUIDv7 checks on this engine, shows the result and logs
 * it as one line for `adb logcat`. Contains no business data.
 */
function RuntimeChecks() {
  const [report, setReport] = useState<RuntimeReport | undefined>(undefined);

  useEffect(() => {
    const result = runRuntimeReport();
    console.log(REPORT_LOG_PREFIX + JSON.stringify(result));
    setReport(result);
  }, []);

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        Runtime checks
      </Text>
      <Text testID="runtime-checks" selectable>
        {report === undefined ? "running" : JSON.stringify(report, null, 2)}
      </Text>
    </View>
  );
}

export default function DiagnosticsScreen() {
  const result = readMobileConfig();
  if (result.ok && result.config.env === "production") {
    return <Text testID="diagnostics-unavailable">Diagnostics are not available in production builds.</Text>;
  }
  return <AppShell result={result}>{() => <RuntimeChecks />}</AppShell>;
}

const styles = StyleSheet.create({
  section: { gap: 8, paddingVertical: 12 },
  heading: { fontSize: 18, fontWeight: "600" },
});
