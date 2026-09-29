import { assertNoExposedWebSecrets, validateWebBuildEnvironment } from "@tali/config/public-build";
import type { NextConfig } from "next";

// Build-time configuration guard (ADR-002 section 18). A NEXT_PUBLIC_* variable
// that looks secret or server-only always fails the build. When the public
// configuration is supplied (every deployment supplies it) it must be valid.
// A build without it renders the configuration-error screen and calls no API.
assertNoExposedWebSecrets(process.env);
if (process.env["NEXT_PUBLIC_TALI_ENV"] !== undefined || process.env["NEXT_PUBLIC_API_BASE_URL"] !== undefined) {
  validateWebBuildEnvironment(process.env);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
};

export default nextConfig;
