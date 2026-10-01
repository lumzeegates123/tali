import { defineConfig, devices } from "@playwright/test";

/*
 * Web end-to-end in Cognito mode: a production build configured like a
 * deployed environment (TALI_ENV=staging, AUTH_MODE=cognito, synthetic public
 * Cognito identifiers). No API process and no AWS: the specs answer the
 * Cognito user-pool endpoint and the Tali API with page.route fakes and refuse
 * every other external request. Proves the browser-side token posture
 * (ADR-003 section 14.4) with the real aws-amplify bundle.
 */
const WEB_PORT = 3912;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

export const COGNITO_E2E = {
  webOrigin: WEB_ORIGIN,
  apiOrigin: "https://api.tali-e2e.test",
} as const;

export default defineConfig({
  testDir: "e2e-cognito",
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "web-cognito",
      command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        NEXT_PUBLIC_TALI_ENV: "staging",
        NEXT_PUBLIC_API_BASE_URL: COGNITO_E2E.apiOrigin,
        NEXT_PUBLIC_AUTH_MODE: "cognito",
        NEXT_PUBLIC_COGNITO_REGION: "eu-west-1",
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: "eu-west-1_SyntheticPool1",
        NEXT_PUBLIC_COGNITO_CLIENT_ID: "syntheticwebclient0000000001",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
