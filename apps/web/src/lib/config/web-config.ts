import type { ConfigurationIssue, EnvSource, PublicConfig } from "@tali/config/public";
import { ConfigurationError, loadWebPublicConfig } from "@tali/config/public";

export type WebConfigResult =
  | { readonly ok: true; readonly config: PublicConfig }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] };

/**
 * Next.js inlines only statically referenced NEXT_PUBLIC_* variables, so each
 * public variable is read explicitly here and nowhere else.
 */
export function publicEnvironment(): EnvSource {
  return {
    NEXT_PUBLIC_TALI_ENV: process.env.NEXT_PUBLIC_TALI_ENV,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_COGNITO_REGION: process.env.NEXT_PUBLIC_COGNITO_REGION,
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
    NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  };
}

/** Validates the public configuration; issues name keys and problems, never values. */
export function readWebConfig(env: EnvSource = publicEnvironment()): WebConfigResult {
  try {
    return { ok: true, config: loadWebPublicConfig(env) };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return { ok: false, issues: error.issues };
    }
    throw error;
  }
}
