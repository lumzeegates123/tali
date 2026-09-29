import { assertNoExposedMobileSecrets, validateMobileBuildEnvironment } from "@tali/config/public-build";
import type { ConfigContext, ExpoConfig } from "expo/config";

// Build-time configuration guard (ADR-002 section 18), evaluated by Expo in
// Node.js for start, export and prebuild. An EXPO_PUBLIC_* variable that looks
// secret or server-only always fails. When the public configuration is
// supplied it must be valid. A build without it renders the
// configuration-error screen and calls no API.
assertNoExposedMobileSecrets(process.env);
const publicConfig =
  process.env["EXPO_PUBLIC_TALI_ENV"] !== undefined || process.env["EXPO_PUBLIC_API_BASE_URL"] !== undefined
    ? validateMobileBuildEnvironment(process.env)
    : undefined;

// Deployed environments require https (enforced by @tali/config/public);
// plain http to a developer machine or emulator host is allowed only for
// local and test builds.
const allowCleartextHttp = publicConfig?.env === "local" || publicConfig?.env === "test";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Tali",
  slug: "tali",
  scheme: "tali",
  version: "0.0.0",
  orientation: "portrait",
  android: { package: "com.tali.mobile" },
  plugins: ["expo-router", ["expo-build-properties", { android: { usesCleartextTraffic: allowCleartextHttp } }]],
});
