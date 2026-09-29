/**
 * Server-side names only. Client runtime code (src/public) never imports this
 * module, so these names cannot reach a web or mobile bundle through config;
 * the build-time guard (src/public-build) and the client-bundle check use it.
 *
 * Every environment variable read by @tali/config/server. The public loaders
 * reject any public variable that re-exposes one of these names, and the
 * server schema is tested to cover exactly this list.
 */
export const SERVER_ENV_KEYS = [
  "TALI_ENV",
  "DATABASE_URL",
  "IDENTITY_PROVIDER",
  "COGNITO_REGION",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_IDS",
  "OBJECT_STORAGE_PROVIDER",
  "S3_REGION",
  "S3_BUCKET",
  "LOCAL_OBJECT_STORAGE_DIR",
  "SIGNED_URL_TTL_SECONDS",
  "QUEUE_PROVIDER",
  "SQS_REGION",
  "SQS_QUEUE_URL",
  "API_PORT",
  "API_CORS_ORIGINS",
  "LOG_LEVEL",
  "SERVICE_NAME",
  "SHUTDOWN_GRACE_PERIOD_MS",
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_HEARTBEAT_FILE",
  "WORKER_HEARTBEAT_INTERVAL_MS",
  "WORKER_SMOKE_ON_START",
] as const;

/** Server variables that are secret or infrastructure-internal and must never reach a client. */
export const SERVER_ONLY_ENV_KEYS: readonly string[] = [
  "DATABASE_URL",
  "COGNITO_CLIENT_IDS",
  "S3_BUCKET",
  "LOCAL_OBJECT_STORAGE_DIR",
  "SQS_QUEUE_URL",
];

/** Database URLs read only by the Prisma CLI and the integration-test tooling. */
export const TOOLING_ONLY_ENV_KEYS: readonly string[] = [
  "MIGRATION_DATABASE_URL",
  "SHADOW_DATABASE_URL",
  "TEST_DATABASE_URL",
  "TEST_MIGRATION_DATABASE_URL",
];

/**
 * Names that must never be exposed to clients. Public variables whose name
 * matches are rejected even when they carry a public prefix.
 */
export const SECRET_NAME_PATTERN = /SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|DATABASE_URL|(^|_)KEY($|_)|DSN/;
