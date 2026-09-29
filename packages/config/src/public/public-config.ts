import { z } from "zod";
import type { ConfigurationIssue, EnvSource, TaliEnv } from "../common/environment.js";
import { ConfigurationError, isDeployedEnvironment, issuesFromZod, TaliEnvSchema } from "../common/environment.js";

/*
 * Client runtime code: this module is bundled into web and mobile. It must not
 * import common/server-keys (server variable names) or anything server-side;
 * rejecting public variables that re-expose secrets happens at build time in
 * @tali/config/public-build, where the whole environment is visible.
 */

export const WEB_PUBLIC_PREFIX = "NEXT_PUBLIC_";
export const MOBILE_PUBLIC_PREFIX = "EXPO_PUBLIC_";

/** The complete set of public variables per client. Anything else is never read. */
export const PUBLIC_ENV_SUFFIXES = [
  "TALI_ENV",
  "API_BASE_URL",
  "COGNITO_REGION",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
] as const;

type PublicSuffix = (typeof PUBLIC_ENV_SUFFIXES)[number];

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const PublicEnvSchema = z.strictObject({
  TALI_ENV: TaliEnvSchema,
  API_BASE_URL: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }),
  COGNITO_REGION: optionalText,
  COGNITO_USER_POOL_ID: optionalText,
  COGNITO_CLIENT_ID: optionalText,
});

export interface PublicConfig {
  readonly env: TaliEnv;
  readonly apiBaseUrl: string;
  /** Public Cognito client settings (no client secret: public clients use PKCE). */
  readonly cognito?: { readonly region: string; readonly userPoolId: string; readonly clientId: string };
}

function loadPublicConfig(scope: string, prefix: string, env: EnvSource): PublicConfig {
  const picked = Object.fromEntries(PUBLIC_ENV_SUFFIXES.map((suffix: PublicSuffix) => [suffix, env[prefix + suffix]]));
  const parsed = PublicEnvSchema.safeParse(picked);
  if (!parsed.success) {
    throw new ConfigurationError(
      scope,
      issuesFromZod(parsed.error).map((issue) => ({ ...issue, key: prefix + issue.key })),
    );
  }
  const raw = parsed.data;
  const issues: ConfigurationIssue[] = [];

  if (isDeployedEnvironment(raw.TALI_ENV) && !raw.API_BASE_URL.startsWith("https://")) {
    issues.push({ key: `${prefix}API_BASE_URL`, message: "must use https outside local and test" });
  }

  const cognitoValues = [raw.COGNITO_REGION, raw.COGNITO_USER_POOL_ID, raw.COGNITO_CLIENT_ID];
  const configured = cognitoValues.filter((value) => value !== undefined).length;
  if (configured !== 0 && configured !== cognitoValues.length) {
    issues.push({
      key: `${prefix}COGNITO_*`,
      message: "COGNITO_REGION, COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID must be set together",
    });
  }

  if (issues.length > 0) {
    throw new ConfigurationError(scope, issues);
  }

  const base = { env: raw.TALI_ENV, apiBaseUrl: raw.API_BASE_URL };
  const config: PublicConfig =
    raw.COGNITO_REGION !== undefined && raw.COGNITO_USER_POOL_ID !== undefined && raw.COGNITO_CLIENT_ID !== undefined
      ? {
          ...base,
          cognito: {
            region: raw.COGNITO_REGION,
            userPoolId: raw.COGNITO_USER_POOL_ID,
            clientId: raw.COGNITO_CLIENT_ID,
          },
        }
      : base;
  return Object.freeze(config);
}

/**
 * Web public configuration from NEXT_PUBLIC_* variables. Next.js inlines only
 * statically referenced variables, so the web app passes an object literal of
 * explicit `process.env.NEXT_PUBLIC_*` reads. Only the keys in
 * PUBLIC_ENV_SUFFIXES are ever read.
 */
export function loadWebPublicConfig(env: EnvSource): PublicConfig {
  return loadPublicConfig("web public", WEB_PUBLIC_PREFIX, env);
}

/** Mobile public configuration from EXPO_PUBLIC_* variables (inlined by Expo the same way). */
export function loadMobilePublicConfig(env: EnvSource): PublicConfig {
  return loadPublicConfig("mobile public", MOBILE_PUBLIC_PREFIX, env);
}
