/**
 * @tali/config/public: client-safe configuration for web (NEXT_PUBLIC_*) and
 * mobile (EXPO_PUBLIC_*). Never contains server secrets.
 */
export type { ConfigurationIssue, EnvSource, TaliEnv } from "../common/environment";
export { ConfigurationError } from "../common/environment";
export type { PublicConfig } from "./public-config";
export {
  findExposedSecrets,
  loadMobilePublicConfig,
  loadWebPublicConfig,
  MOBILE_PUBLIC_PREFIX,
  PUBLIC_ENV_SUFFIXES,
  WEB_PUBLIC_PREFIX,
} from "./public-config";
