/**
 * @tali/config/server: API and worker configuration. Server-only; web and
 * mobile may never import this entry point (enforced by dependency-cruiser).
 */
export type { ConfigurationIssue, EnvSource, TaliEnv } from "../common/environment";
export { ConfigurationError, isDeployedEnvironment, TALI_ENVIRONMENTS } from "../common/environment";
export type { IdentityConfig, ObjectStorageConfig, QueueConfig, ServerConfig } from "./server-config";
export { loadServerConfig } from "./server-config";
