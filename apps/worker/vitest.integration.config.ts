import { defineConfig } from "vitest/config";

/** Worker lifecycle (in-process Nest context) and process-level tests against the compiled worker. */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
