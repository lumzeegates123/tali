/**
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
] as const;

/** Server variables that are secret or infrastructure-internal and must never reach a client. */
export const SERVER_ONLY_ENV_KEYS: readonly string[] = [
  "DATABASE_URL",
  "COGNITO_CLIENT_IDS",
  "S3_BUCKET",
  "LOCAL_OBJECT_STORAGE_DIR",
  "SQS_QUEUE_URL",
];
