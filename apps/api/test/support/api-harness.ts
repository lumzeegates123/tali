import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import type { IdentityProvider } from "@tali/application";
import { FakeIdentityProvider, FixedClock } from "@tali/application/testing";
import { loadServerConfig, type ServerConfig } from "@tali/config/server";
import type { Database } from "@tali/database";
import { testDatabaseUrls } from "@tali/database/testing";
import { createApiApplication } from "../../src/bootstrap.js";
import { createApiRuntime, type ApiRuntime } from "../../src/composition/api-runtime.js";
import { JsonLogger } from "../../src/observability/logger.js";

export const TEST_ENV = {
  TALI_ENV: "test",
  DATABASE_URL: testDatabaseUrls().app,
  IDENTITY_PROVIDER: "fake",
  OBJECT_STORAGE_PROVIDER: "memory",
  QUEUE_PROVIDER: "memory",
  LOG_LEVEL: "debug",
  SERVICE_NAME: "tali-test",
} as const;

export interface ApiHarness {
  readonly app: INestApplication<Server>;
  readonly runtime: ApiRuntime;
  readonly identity: FakeIdentityProvider;
  readonly logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startApi(
  options: {
    readonly env?: Record<string, string>;
    readonly config?: ServerConfig;
    readonly database?: Database;
    readonly identityProvider?: IdentityProvider;
  } = {},
): Promise<ApiHarness> {
  const config = options.config ?? loadServerConfig({ ...TEST_ENV, ...options.env });
  const logs: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    service: "tali-test-api",
    level: "debug",
    sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const identity = new FakeIdentityProvider(new FixedClock("2026-09-27T10:00:00Z"));
  const runtime = createApiRuntime(config, {
    logger,
    identityProvider: options.identityProvider ?? identity,
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const app = await createApiApplication(runtime);
  await app.init();
  return {
    app,
    runtime,
    identity,
    logs,
    async close() {
      await app.close();
      await runtime.close();
    },
  };
}
