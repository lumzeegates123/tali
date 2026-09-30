import { defineConfig } from "vitest/config";

// The integration suite is the test environment by definition. An explicit
// non-test TALI_ENV is kept, so the fixture safety checks refuse to run.
process.env["TALI_ENV"] ??= "test";

/** Supertest against the real NestJS app and real PostgreSQL (docker-compose `postgres-test` / CI service). */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
