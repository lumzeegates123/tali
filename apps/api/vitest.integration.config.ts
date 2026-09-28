import { defineConfig } from "vitest/config";

/** Supertest against the real NestJS app and real PostgreSQL (docker-compose `postgres-test` / CI service). */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
