import type { MobilePublicConfig } from "@tali/config/public";

/**
 * Local development sign-in exists only when TALI_ENV=local: the API mounts
 * `POST /__local/sign-in` only there (ADR-002 section 11, ADR-005 section 16).
 * The public configuration's environment and auth mode are the only signals
 * used; Expo dev mode, `__DEV__` and the API host are never consulted.
 */
export function isLocalSignInAvailable(config: MobilePublicConfig): boolean {
  return config.env === "local" && config.authMode === "local";
}

/** Cognito sign-in needs the public app-client settings; the loader already requires them for this mode. */
export function isCognitoSignInAvailable(config: MobilePublicConfig): boolean {
  return config.authMode === "cognito" && config.cognito !== undefined;
}
