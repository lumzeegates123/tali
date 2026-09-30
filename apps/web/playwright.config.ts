import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/*
 * Web end-to-end: starts the compiled API (against the disposable test
 * database) and a production build of the web app configured to call it, then
 * drives the health and onboarding flows in Chromium. Both run as
 * TALI_ENV=local because local sign-in (the only Build 1 sign-in) exists only
 * there; storage and queue stay in memory. Dedicated ports avoid clashing with
 * local dev. Requires `pnpm run build` first (the API is started from
 * apps/api/dist) and a migrated test database.
 */
const API_PORT = 3910;
const WEB_PORT = 3911;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
const TEST_DATABASE_URL =
  process.env["TEST_DATABASE_URL"] ?? "postgresql://tali_app:local-only-app@127.0.0.1:55433/tali_test";
const apiMain = fileURLToPath(new URL("../api/dist/main.js", import.meta.url));

export const E2E = { apiOrigin: API_ORIGIN, webOrigin: WEB_ORIGIN } as const;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["html", { open: "never" }]],
  use: { baseURL: WEB_ORIGIN, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "api",
      command: `node --enable-source-maps "${apiMain}"`,
      url: `${API_ORIGIN}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        TALI_ENV: "local",
        DATABASE_URL: TEST_DATABASE_URL,
        IDENTITY_PROVIDER: "local",
        OBJECT_STORAGE_PROVIDER: "memory",
        QUEUE_PROVIDER: "memory",
        API_PORT: String(API_PORT),
        API_CORS_ORIGINS: WEB_ORIGIN,
        LOG_LEVEL: "warn",
        SERVICE_NAME: "tali-e2e-api",
      },
    },
    {
      name: "web",
      command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        NEXT_PUBLIC_TALI_ENV: "local",
        NEXT_PUBLIC_API_BASE_URL: API_ORIGIN,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
