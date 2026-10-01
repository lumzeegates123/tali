/**
 * @tali/config/public-build: build-time checks for client configuration. Runs
 * in Node.js only (next.config.ts, the Expo app config and the client-bundle
 * check), where the whole build environment is visible. Never imported by
 * client runtime code: it carries the server variable names that must not
 * appear in a client bundle.
 */
import type { ConfigurationIssue, EnvSource } from "../common/environment.js";
import { ConfigurationError } from "../common/environment.js";
import {
  SECRET_NAME_PATTERN,
  SERVER_ENV_KEYS,
  SERVER_ONLY_ENV_KEYS,
  TOOLING_ONLY_ENV_KEYS,
} from "../common/server-keys.js";
import type { PublicConfig, WebPublicConfig } from "../public/public-config.js";
import {
  loadMobilePublicConfig,
  loadWebPublicConfig,
  MOBILE_PUBLIC_PREFIX,
  PUBLIC_ENV_SUFFIXES,
  WEB_PUBLIC_PREFIX,
} from "../public/public-config.js";

/**
 * Public variables that would expose server-only or secret values, such as
 * NEXT_PUBLIC_DATABASE_URL or EXPO_PUBLIC_API_SECRET.
 */
export function findExposedSecrets(env: EnvSource, prefix: string): ConfigurationIssue[] {
  return Object.keys(env)
    .filter((key) => key.startsWith(prefix))
    .filter((key) => {
      const suffix = key.slice(prefix.length);
      return SECRET_NAME_PATTERN.test(suffix) || SERVER_ONLY_ENV_KEYS.includes(suffix);
    })
    .map((key) => ({ key, message: "server-only or secret values must never be exposed as public configuration" }));
}

function assertNoExposedSecrets(scope: string, env: EnvSource, prefix: string): void {
  const exposed = findExposedSecrets(env, prefix);
  if (exposed.length > 0) {
    throw new ConfigurationError(scope, exposed);
  }
}

/** Build-time guard for the web app: no exposed secrets, then a valid public config. */
export function validateWebBuildEnvironment(env: EnvSource): WebPublicConfig {
  assertNoExposedSecrets("web public", env, WEB_PUBLIC_PREFIX);
  return loadWebPublicConfig(env);
}

/** Build-time guard for the mobile app: no exposed secrets, then a valid public config. */
export function validateMobileBuildEnvironment(env: EnvSource): PublicConfig {
  assertNoExposedSecrets("mobile public", env, MOBILE_PUBLIC_PREFIX);
  return loadMobilePublicConfig(env);
}

/** Rejects secret-looking public variables without requiring the public config to be complete. */
export function assertNoExposedWebSecrets(env: EnvSource): void {
  assertNoExposedSecrets("web public", env, WEB_PUBLIC_PREFIX);
}

/** Rejects secret-looking public variables without requiring the public config to be complete. */
export function assertNoExposedMobileSecrets(env: EnvSource): void {
  assertNoExposedSecrets("mobile public", env, MOBILE_PUBLIC_PREFIX);
}

const PUBLIC_SUFFIXES: readonly string[] = PUBLIC_ENV_SUFFIXES;

/**
 * Environment variable names that must never appear in a built client bundle:
 * every server variable that is not also a public suffix, plus the database
 * URLs used by tooling.
 */
export const CLIENT_FORBIDDEN_ENV_NAMES: readonly string[] = Object.freeze([
  ...SERVER_ENV_KEYS.filter((key) => !PUBLIC_SUFFIXES.includes(key)),
  ...TOOLING_ONLY_ENV_KEYS,
]);
