import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    // The real-Amplify SRP tests are CPU-heavy; multi-step jsdom screens need headroom when files run in parallel.
    testTimeout: 15_000,
    // The web app never needs AWS: any AWS variable reaching a test is a mistake.
    env: { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "", AWS_PROFILE: "" },
  },
});
