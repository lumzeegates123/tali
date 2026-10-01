import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../common/environment.js";
import { SERVER_ENV_KEYS } from "../common/server-keys.js";
import { loadServerConfig, SERVER_SCHEMA_KEYS } from "./server-config.js";

const SECRET_PASSWORD = "p4ssw0rd-that-must-not-leak";

const localEnv = {
  TALI_ENV: "local",
  DATABASE_URL: `postgresql://tali:${SECRET_PASSWORD}@localhost:5432/tali`,
  IDENTITY_PROVIDER: "local",
  OBJECT_STORAGE_PROVIDER: "local",
  LOCAL_OBJECT_STORAGE_DIR: ".local/object-storage",
  QUEUE_PROVIDER: "memory",
};

const deployedEnv = {
  TALI_ENV: "production",
  DATABASE_URL: `postgresql://tali:${SECRET_PASSWORD}@db.internal:5432/tali`,
  IDENTITY_PROVIDER: "cognito",
  COGNITO_REGION: "eu-west-1",
  COGNITO_USER_POOL_ID: "eu-west-1_Example123",
  COGNITO_CLIENT_IDS: "exampleclientid1, exampleclientid2",
  OBJECT_STORAGE_PROVIDER: "s3",
  S3_REGION: "eu-west-1",
  S3_BUCKET: "tali-example-bucket",
  QUEUE_PROVIDER: "sqs",
  SQS_REGION: "eu-west-1",
  SQS_QUEUE_URL: "https://sqs.eu-west-1.amazonaws.com/000000000000/tali-example",
};

function configError(env: Record<string, string | undefined>): ConfigurationError {
  try {
    loadServerConfig(env);
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected a ConfigurationError");
}

describe("loadServerConfig", () => {
  it("loads a valid local configuration with defaults", () => {
    const config = loadServerConfig(localEnv);
    expect(config.env).toBe("local");
    expect(config.identity).toEqual({ provider: "local" });
    expect(config.objectStorage).toEqual({
      provider: "local",
      directory: ".local/object-storage",
      signedUrlTtlSeconds: 300,
    });
    expect(config.queue).toEqual({ provider: "memory" });
    expect(config.api).toEqual({ port: 3000, corsOrigins: [], testRoutesEnabled: true });
    expect(config.worker).toEqual({
      pollIntervalMs: 1_000,
      heartbeatFile: undefined,
      heartbeatIntervalMs: 5_000,
      smokeOnStart: false,
    });
    expect(config.lifecycle).toEqual({ shutdownGracePeriodMs: 10_000 });
    expect(config.observability).toEqual({ logLevel: "info", serviceName: "tali" });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("loads a valid deployed configuration", () => {
    const config = loadServerConfig(deployedEnv);
    expect(config.identity).toEqual({
      provider: "cognito",
      region: "eu-west-1",
      userPoolId: "eu-west-1_Example123",
      clientIds: ["exampleclientid1", "exampleclientid2"],
    });
    expect(config.objectStorage.provider).toBe("s3");
    expect(config.queue.provider).toBe("sqs");
  });

  it("fails fast on missing or invalid TALI_ENV", () => {
    expect(configError({ ...localEnv, TALI_ENV: undefined }).issues.map((issue) => issue.key)).toContain("TALI_ENV");
    expect(configError({ ...localEnv, TALI_ENV: "prod" }).issues.map((issue) => issue.key)).toContain("TALI_ENV");
  });

  it.each(["development", "staging", "production"])("rejects local, fake and in-memory adapters in %s", (env) => {
    const keys = (overrides: Record<string, string>): string[] =>
      configError({ ...deployedEnv, TALI_ENV: env, ...overrides }).issues.map((issue) => issue.key);
    expect(keys({ IDENTITY_PROVIDER: "local" })).toContain("IDENTITY_PROVIDER");
    expect(keys({ IDENTITY_PROVIDER: "fake" })).toContain("IDENTITY_PROVIDER");
    expect(keys({ OBJECT_STORAGE_PROVIDER: "memory" })).toContain("OBJECT_STORAGE_PROVIDER");
    expect(keys({ OBJECT_STORAGE_PROVIDER: "local", LOCAL_OBJECT_STORAGE_DIR: "/tmp/x" })).toContain(
      "OBJECT_STORAGE_PROVIDER",
    );
    expect(keys({ QUEUE_PROVIDER: "memory" })).toContain("QUEUE_PROVIDER");
  });

  it("allows local identity only in local, and fake identity only in local or test", () => {
    expect(configError({ ...localEnv, TALI_ENV: "test" }).issues.map((issue) => issue.key)).toEqual([
      "IDENTITY_PROVIDER",
    ]);
    expect(loadServerConfig({ ...localEnv, TALI_ENV: "test", IDENTITY_PROVIDER: "fake" }).identity.provider).toBe(
      "fake",
    );
  });

  it("requires provider settings for the selected provider", () => {
    const keys = configError({
      ...deployedEnv,
      COGNITO_USER_POOL_ID: "",
      S3_BUCKET: undefined,
      SQS_QUEUE_URL: "http://x",
    }).issues.map((issue) => issue.key);
    expect(keys).toEqual(expect.arrayContaining(["COGNITO_USER_POOL_ID", "S3_BUCKET", "SQS_QUEUE_URL"]));
  });

  describe("Cognito identity (ADR-003 section 15)", () => {
    const issueKeys = (overrides: Record<string, string | undefined>): string[] =>
      configError({ ...deployedEnv, ...overrides }).issues.map((issue) => issue.key);

    it("accepts the web and mobile client IDs and up to ten approved public clients", () => {
      const ids = Array.from({ length: 10 }, (_, index) => `approvedclient${String(index)}`);
      expect(loadServerConfig({ ...deployedEnv, COGNITO_CLIENT_IDS: ids.join(",") }).identity).toMatchObject({
        clientIds: ids,
      });
    });

    it("refuses a missing user pool, region or client allowlist", () => {
      expect(issueKeys({ COGNITO_USER_POOL_ID: undefined })).toContain("COGNITO_USER_POOL_ID");
      expect(issueKeys({ COGNITO_REGION: undefined })).toContain("COGNITO_REGION");
      expect(issueKeys({ COGNITO_CLIENT_IDS: undefined })).toEqual(["COGNITO_CLIENT_IDS"]);
      expect(issueKeys({ COGNITO_CLIENT_IDS: " , ," })).toEqual(["COGNITO_CLIENT_IDS"]);
    });

    it("refuses malformed region, pool and client values", () => {
      expect(issueKeys({ COGNITO_REGION: "https://evil.example" })).toContain("COGNITO_REGION");
      expect(issueKeys({ COGNITO_USER_POOL_ID: "eu-west-1/Example" })).toContain("COGNITO_USER_POOL_ID");
      expect(issueKeys({ COGNITO_USER_POOL_ID: "eu-west-2_Example123" })).toEqual(["COGNITO_USER_POOL_ID"]);
      expect(issueKeys({ COGNITO_CLIENT_IDS: "good,bad-id" })).toEqual(["COGNITO_CLIENT_IDS"]);
      expect(issueKeys({ COGNITO_CLIENT_IDS: "dup,dup" })).toEqual(["COGNITO_CLIENT_IDS"]);
      const eleven = Array.from({ length: 11 }, (_, index) => `client${String(index)}`).join(",");
      expect(issueKeys({ COGNITO_CLIENT_IDS: eleven })).toEqual(["COGNITO_CLIENT_IDS"]);
    });

    it("allows Cognito in local and test (a developer may target a development pool)", () => {
      for (const env of ["local", "test"]) {
        expect(loadServerConfig({ ...deployedEnv, TALI_ENV: env }).identity.provider).toBe("cognito");
      }
    });

    it.each(["development", "staging", "production"])("requires Cognito identity in %s", (env) => {
      for (const provider of ["local", "fake"]) {
        expect(issueKeys({ TALI_ENV: env, IDENTITY_PROVIDER: provider })).toContain("IDENTITY_PROVIDER");
      }
    });

    it("needs no secret: the configuration holds public identifiers only", () => {
      const config = loadServerConfig(deployedEnv);
      expect(Object.keys(config.identity).sort()).toEqual(["clientIds", "provider", "region", "userPoolId"]);
    });
  });

  it("validates bounds", () => {
    expect(configError({ ...localEnv, SIGNED_URL_TTL_SECONDS: "7200" }).issues.map((issue) => issue.key)).toEqual([
      "SIGNED_URL_TTL_SECONDS",
    ]);
    expect(configError({ ...localEnv, API_PORT: "0" }).issues.map((issue) => issue.key)).toEqual(["API_PORT"]);
    expect(configError({ ...localEnv, DATABASE_URL: "mysql://x" }).issues.map((issue) => issue.key)).toEqual([
      "DATABASE_URL",
    ]);
  });

  it("never includes configured values in error messages", () => {
    const error = configError({ ...localEnv, TALI_ENV: "production" });
    expect(error.message).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(error.issues)).not.toContain(SECRET_PASSWORD);
    const invalidUrl = configError({ ...localEnv, DATABASE_URL: `mysql://${SECRET_PASSWORD}@x` });
    expect(invalidUrl.message).not.toContain(SECRET_PASSWORD);
  });

  it("enables test-only routes in local and test, and never in a deployed environment", () => {
    expect(loadServerConfig({ ...localEnv, TALI_ENV: "test", IDENTITY_PROVIDER: "fake" }).api.testRoutesEnabled).toBe(
      true,
    );
    for (const env of ["development", "staging", "production"]) {
      expect(loadServerConfig({ ...deployedEnv, TALI_ENV: env }).api.testRoutesEnabled).toBe(false);
    }
  });

  it("allows the worker smoke message only in local or test", () => {
    expect(loadServerConfig({ ...localEnv, WORKER_SMOKE_ON_START: "true" }).worker.smokeOnStart).toBe(true);
    expect(configError({ ...deployedEnv, WORKER_SMOKE_ON_START: "true" }).issues.map((issue) => issue.key)).toEqual([
      "WORKER_SMOKE_ON_START",
    ]);
    expect(configError({ ...localEnv, WORKER_SMOKE_ON_START: "yes" }).issues.map((issue) => issue.key)).toEqual([
      "WORKER_SMOKE_ON_START",
    ]);
  });

  it("validates worker and lifecycle bounds", () => {
    const keys = configError({
      ...localEnv,
      WORKER_POLL_INTERVAL_MS: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "999999",
      SHUTDOWN_GRACE_PERIOD_MS: "-1",
    }).issues.map((issue) => issue.key);
    expect(keys.sort()).toEqual([
      "SHUTDOWN_GRACE_PERIOD_MS",
      "WORKER_HEARTBEAT_INTERVAL_MS",
      "WORKER_POLL_INTERVAL_MS",
    ]);
  });

  it("reads only known keys", () => {
    expect([...SERVER_SCHEMA_KEYS].sort()).toEqual([...SERVER_ENV_KEYS].sort());
    const config = loadServerConfig({ ...localEnv, UNRELATED_SECRET: "x" });
    expect(JSON.stringify(config)).not.toContain("UNRELATED_SECRET");
  });
});
