import type { ConfigurationIssue, EnvSource, MobilePublicConfig } from "@tali/config/public";
import { ConfigurationError, loadMobilePublicConfig } from "@tali/config/public";

export type MobileConfigResult =
  | { readonly ok: true; readonly config: MobilePublicConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] };

/**
 * Expo inlines only statically referenced EXPO_PUBLIC_* variables, so each
 * public variable is read explicitly here and nowhere else.
 */
export function publicEnvironment(): EnvSource {
  return {
    EXPO_PUBLIC_TALI_ENV: process.env.EXPO_PUBLIC_TALI_ENV,
    EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
    EXPO_PUBLIC_AUTH_MODE: process.env.EXPO_PUBLIC_AUTH_MODE,
    EXPO_PUBLIC_COGNITO_REGION: process.env.EXPO_PUBLIC_COGNITO_REGION,
    EXPO_PUBLIC_COGNITO_USER_POOL_ID: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID,
    EXPO_PUBLIC_COGNITO_CLIENT_ID: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID,
  };
}

/** Validates the public configuration; issues name keys and problems, never values. */
export function readMobileConfig(env: EnvSource = publicEnvironment()): MobileConfigResult {
  try {
    return { ok: true, config: loadMobilePublicConfig(env) };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
}
