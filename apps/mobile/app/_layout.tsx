import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SessionRoot } from "../src/auth/session-context";
import { readMobileConfig } from "../src/config/mobile-config";
import { installSecureRandom } from "../src/ids/secure-random";

installSecureRandom();

export default function RootLayout() {
  const result = readMobileConfig();
  return (
    <SessionRoot config={result.ok ? result.config : undefined}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ title: "Tali" }} />
    </SessionRoot>
  );
}
