import type { PublicConfig } from "@tali/config/public";

/**
 * Local development sign-in exists only when TALI_ENV=local: the API mounts
 * `POST /__local/sign-in` only there (ADR-002 section 11, ADR-005 section 16).
 * The public configuration's environment is the only signal used; Expo dev
 * mode, `__DEV__` and the API host are never consulted.
 */
export function isLocalSignInAvailable(config: PublicConfig): boolean {
  return config.env === "local";
}
