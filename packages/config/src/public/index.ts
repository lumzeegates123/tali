/**
 * @tali/config/public: client-safe configuration for web (NEXT_PUBLIC_*) and
 * mobile (EXPO_PUBLIC_*). Bundled into the clients; never contains server
 * secrets or server variable names.
 */
export type { ConfigurationIssue, EnvSource, TaliEnv } from "../common/environment.js";
export { ConfigurationError } from "../common/environment.js";
export type {
  AuthMode,
  MobilePublicConfig,
  PublicCognitoConfig,
  PublicConfig,
  WebPublicConfig,
} from "./public-config.js";
export {
  loadMobilePublicConfig,
  loadWebPublicConfig,
  MOBILE_PUBLIC_PREFIX,
  PUBLIC_ENV_SUFFIXES,
  WEB_PUBLIC_PREFIX,
} from "./public-config.js";
