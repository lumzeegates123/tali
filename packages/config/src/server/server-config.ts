import { z } from "zod";
import type { ConfigurationIssue, EnvSource, TaliEnv } from "../common/environment.js";
import { ConfigurationError, isDeployedEnvironment, issuesFromZod, TaliEnvSchema } from "../common/environment.js";
import { SERVER_ENV_KEYS } from "../common/server-keys.js";

const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;
const COGNITO_USER_POOL_ID = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]_[A-Za-z0-9]+$/;
/** Cognito app client IDs (`[\w+]+`). Public identifiers: the approved clients have no secret (ADR-003 14.2). */
const COGNITO_CLIENT_ID = /^[\w+]{1,128}$/;
/** The approved web and mobile clients, with room for more approved public clients without a code change. */
const MAX_COGNITO_CLIENT_IDS = 10;
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const csvList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );

const booleanFlag = z
  .enum(["true", "false"], { error: "must be true or false" })
  .default("false")
  .transform((value) => value === "true");

const RawServerEnvSchema = z.object({
  TALI_ENV: TaliEnvSchema,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// or postgresql:// URL" }),
  IDENTITY_PROVIDER: z.enum(["cognito", "local", "fake"]),
  COGNITO_REGION: optionalText,
  COGNITO_USER_POOL_ID: optionalText,
  COGNITO_CLIENT_IDS: csvList,
  OBJECT_STORAGE_PROVIDER: z.enum(["s3", "local", "memory"]),
  S3_REGION: optionalText,
  S3_BUCKET: optionalText,
  LOCAL_OBJECT_STORAGE_DIR: optionalText,
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
  QUEUE_PROVIDER: z.enum(["sqs", "memory"]),
  SQS_REGION: optionalText,
  SQS_QUEUE_URL: optionalText,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_CORS_ORIGINS: csvList,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SERVICE_NAME: z.string().trim().min(1).max(64).default("tali"),
  SHUTDOWN_GRACE_PERIOD_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
  WORKER_HEARTBEAT_FILE: optionalText,
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  WORKER_SMOKE_ON_START: booleanFlag,
});

type RawServerEnv = z.infer<typeof RawServerEnvSchema>;

export type IdentityConfig =
  | {
      readonly provider: "cognito";
      readonly region: string;
      readonly userPoolId: string;
      readonly clientIds: readonly string[];
    }
  | { readonly provider: "local" }
  | { readonly provider: "fake" };

export type ObjectStorageConfig =
  | { readonly provider: "s3"; readonly region: string; readonly bucket: string; readonly signedUrlTtlSeconds: number }
  | { readonly provider: "local"; readonly directory: string; readonly signedUrlTtlSeconds: number }
  | { readonly provider: "memory"; readonly signedUrlTtlSeconds: number };

export type QueueConfig =
  { readonly provider: "sqs"; readonly region: string; readonly queueUrl: string } | { readonly provider: "memory" };

export interface ServerConfig {
  readonly env: TaliEnv;
  readonly database: { readonly url: string };
  readonly identity: IdentityConfig;
  readonly objectStorage: ObjectStorageConfig;
  readonly queue: QueueConfig;
  readonly api: {
    readonly port: number;
    readonly corsOrigins: readonly string[];
    /**
     * Test/local-only diagnostic routes (for example the identity-guard probe).
     * Derived from TALI_ENV alone, with no override: it is impossible to enable
     * in a deployed environment.
     */
    readonly testRoutesEnabled: boolean;
  };
  readonly worker: {
    readonly pollIntervalMs: number;
    /** File the worker rewrites on every heartbeat; omitted disables the file heartbeat. */
    readonly heartbeatFile: string | undefined;
    readonly heartbeatIntervalMs: number;
    /** Publishes one harmless smoke message on start (local/test only). */
    readonly smokeOnStart: boolean;
  };
  readonly lifecycle: { readonly shutdownGracePeriodMs: number };
  readonly observability: { readonly logLevel: RawServerEnv["LOG_LEVEL"]; readonly serviceName: string };
}

class IssueCollector {
  readonly issues: ConfigurationIssue[] = [];

  require(key: string, value: string | undefined, pattern?: RegExp): string {
    if (value === undefined) {
      this.issues.push({ key, message: "is required for the selected provider" });
      return "";
    }
    if (pattern !== undefined && !pattern.test(value)) {
      this.issues.push({ key, message: "has an invalid format" });
    }
    return value;
  }

  forbid(key: string, message: string): void {
    this.issues.push({ key, message });
  }
}

function identityConfig(raw: RawServerEnv, issues: IssueCollector): IdentityConfig {
  switch (raw.IDENTITY_PROVIDER) {
    case "cognito": {
      const region = issues.require("COGNITO_REGION", raw.COGNITO_REGION, AWS_REGION);
      const userPoolId = issues.require("COGNITO_USER_POOL_ID", raw.COGNITO_USER_POOL_ID, COGNITO_USER_POOL_ID);
      if (region !== "" && userPoolId !== "" && !userPoolId.startsWith(`${region}_`)) {
        issues.forbid("COGNITO_USER_POOL_ID", "must belong to COGNITO_REGION");
      }
      const clientIds = raw.COGNITO_CLIENT_IDS;
      if (clientIds.length === 0) {
        issues.forbid("COGNITO_CLIENT_IDS", "is required for the selected provider");
      } else if (clientIds.length > MAX_COGNITO_CLIENT_IDS) {
        issues.forbid("COGNITO_CLIENT_IDS", `lists more than ${String(MAX_COGNITO_CLIENT_IDS)} app clients`);
      } else if (!clientIds.every((id) => COGNITO_CLIENT_ID.test(id))) {
        issues.forbid("COGNITO_CLIENT_IDS", "has an invalid format");
      } else if (new Set(clientIds).size !== clientIds.length) {
        issues.forbid("COGNITO_CLIENT_IDS", "lists an app client more than once");
      }
      return { provider: "cognito", region, userPoolId, clientIds };
    }
    case "local":
      if (raw.TALI_ENV !== "local")
        issues.forbid("IDENTITY_PROVIDER", "local identity is allowed only when TALI_ENV=local");
      return { provider: "local" };
    case "fake":
      if (raw.TALI_ENV !== "local" && raw.TALI_ENV !== "test") {
        issues.forbid("IDENTITY_PROVIDER", "fake identity is allowed only when TALI_ENV is local or test");
      }
      return { provider: "fake" };
  }
}

function objectStorageConfig(raw: RawServerEnv, issues: IssueCollector): ObjectStorageConfig {
  const signedUrlTtlSeconds = raw.SIGNED_URL_TTL_SECONDS;
  switch (raw.OBJECT_STORAGE_PROVIDER) {
    case "s3":
      return {
        provider: "s3",
        region: issues.require("S3_REGION", raw.S3_REGION, AWS_REGION),
        bucket: issues.require("S3_BUCKET", raw.S3_BUCKET, S3_BUCKET_NAME),
        signedUrlTtlSeconds,
      };
    case "local":
      if (isDeployedEnvironment(raw.TALI_ENV)) {
        issues.forbid("OBJECT_STORAGE_PROVIDER", `local storage is not allowed when TALI_ENV=${raw.TALI_ENV}`);
      }
      return {
        provider: "local",
        directory: issues.require("LOCAL_OBJECT_STORAGE_DIR", raw.LOCAL_OBJECT_STORAGE_DIR),
        signedUrlTtlSeconds,
      };
    case "memory":
      if (isDeployedEnvironment(raw.TALI_ENV)) {
        issues.forbid("OBJECT_STORAGE_PROVIDER", `in-memory storage is not allowed when TALI_ENV=${raw.TALI_ENV}`);
      }
      return { provider: "memory", signedUrlTtlSeconds };
  }
}

function queueConfig(raw: RawServerEnv, issues: IssueCollector): QueueConfig {
  switch (raw.QUEUE_PROVIDER) {
    case "sqs": {
      const region = issues.require("SQS_REGION", raw.SQS_REGION, AWS_REGION);
      const queueUrl = issues.require(
        "SQS_QUEUE_URL",
        raw.SQS_QUEUE_URL,
        /^https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/[0-9]{12}\/[A-Za-z0-9_-]+(\.fifo)?$/,
      );
      return { provider: "sqs", region, queueUrl };
    }
    case "memory":
      if (isDeployedEnvironment(raw.TALI_ENV)) {
        issues.forbid("QUEUE_PROVIDER", `in-memory queue is not allowed when TALI_ENV=${raw.TALI_ENV}`);
      }
      return { provider: "memory" };
  }
}

function pickServerEnv(env: EnvSource): Record<string, string | undefined> {
  return Object.fromEntries(SERVER_ENV_KEYS.map((key) => [key, env[key]]));
}

/**
 * Validates server configuration and fails fast. Forbidden combinations (for
 * example production with local/fake identity or in-memory storage) are
 * rejected. Only the known keys are read from `env`.
 */
export function loadServerConfig(env: EnvSource): ServerConfig {
  const parsed = RawServerEnvSchema.safeParse(pickServerEnv(env));
  if (!parsed.success) {
    throw new ConfigurationError("server", issuesFromZod(parsed.error));
  }
  const raw = parsed.data;
  const issues = new IssueCollector();

  const config: ServerConfig = {
    env: raw.TALI_ENV,
    database: { url: raw.DATABASE_URL },
    identity: identityConfig(raw, issues),
    objectStorage: objectStorageConfig(raw, issues),
    queue: queueConfig(raw, issues),
    api: {
      port: raw.API_PORT,
      corsOrigins: raw.API_CORS_ORIGINS,
      testRoutesEnabled: raw.TALI_ENV === "local" || raw.TALI_ENV === "test",
    },
    worker: {
      pollIntervalMs: raw.WORKER_POLL_INTERVAL_MS,
      heartbeatFile: raw.WORKER_HEARTBEAT_FILE,
      heartbeatIntervalMs: raw.WORKER_HEARTBEAT_INTERVAL_MS,
      smokeOnStart: raw.WORKER_SMOKE_ON_START,
    },
    lifecycle: { shutdownGracePeriodMs: raw.SHUTDOWN_GRACE_PERIOD_MS },
    observability: { logLevel: raw.LOG_LEVEL, serviceName: raw.SERVICE_NAME },
  };

  if (raw.WORKER_SMOKE_ON_START && raw.TALI_ENV !== "local" && raw.TALI_ENV !== "test") {
    issues.forbid("WORKER_SMOKE_ON_START", "is allowed only when TALI_ENV is local or test");
  }

  if (issues.issues.length > 0) {
    throw new ConfigurationError("server", issues.issues);
  }
  return Object.freeze(config);
}

/** The keys the server schema reads; used to prove the schema and SERVER_ENV_KEYS stay in sync. */
export const SERVER_SCHEMA_KEYS: readonly string[] = Object.keys(RawServerEnvSchema.shape);
