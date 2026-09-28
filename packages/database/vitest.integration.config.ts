import { defineConfig } from "vitest/config";

/**
 * Integration tests run against real PostgreSQL (docker-compose
 * `postgres-test` locally, a service container in CI). Files run serially
 * because they share one database; concurrency is exercised inside tests.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
