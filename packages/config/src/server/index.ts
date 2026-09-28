/**
 * @tali/config/server: API and worker configuration. Server-only; web and
 * mobile may never import this entry point (enforced by dependency-cruiser).
 */
export type { ConfigurationIssue, EnvSource, TaliEnv } from "../common/environment.js";
export { ConfigurationError, isDeployedEnvironment, TALI_ENVIRONMENTS } from "../common/environment.js";
export type { IdentityConfig, ObjectStorageConfig, QueueConfig, ServerConfig } from "./server-config.js";
export { loadServerConfig } from "./server-config.js";
