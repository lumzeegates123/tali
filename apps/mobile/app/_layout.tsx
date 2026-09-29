import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { installSecureRandom } from "../src/ids/secure-random";

installSecureRandom();

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ title: "Tali" }} />
    </>
  );
}
