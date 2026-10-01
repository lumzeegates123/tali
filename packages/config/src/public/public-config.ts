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
  "AUTH_MODE",
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

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/;
const USER_POOL_ID = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]_[A-Za-z0-9]+$/;
const CLIENT_ID = /^[\w+]{1,128}$/;

const PublicEnvSchema = z.strictObject({
  TALI_ENV: TaliEnvSchema,
  API_BASE_URL: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }),
  AUTH_MODE: z
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : value))
    .pipe(z.enum(["local", "cognito"], { error: "must be local or cognito" }).optional())
    .optional(),
  COGNITO_REGION: optionalText.pipe(z.string().regex(REGION, "has an invalid format").optional()),
  COGNITO_USER_POOL_ID: optionalText.pipe(z.string().regex(USER_POOL_ID, "has an invalid format").optional()),
  COGNITO_CLIENT_ID: optionalText.pipe(z.string().regex(CLIENT_ID, "has an invalid format").optional()),
});

/**
 * How the client authenticates (ADR-003 section 14):
 * - `local`: the local development sign-in, only when TALI_ENV=local;
 * - `cognito`: Cognito email + password (SRP) in the app's own UI;
 * - `unavailable`: no sign-in configured (for example a test build).
 * Taken from AUTH_MODE when set. Unset, it is `local` in TALI_ENV=local,
 * `cognito` when the Cognito settings are present, otherwise `unavailable`.
 * Hostnames and NODE_ENV are never consulted.
 */
export type AuthMode = "local" | "cognito" | "unavailable";

/**
 * Public Cognito app-client settings. These are identifiers, not secrets: the
 * approved app clients are public clients with no client secret.
 */
export interface PublicCognitoConfig {
  readonly region: string;
  readonly userPoolId: string;
  readonly clientId: string;
}

export interface PublicConfig {
  readonly env: TaliEnv;
  readonly apiBaseUrl: string;
  readonly cognito?: PublicCognitoConfig;
}

/** The web client's configuration: the public configuration plus its resolved sign-in mode. */
export interface WebPublicConfig extends PublicConfig {
  readonly authMode: AuthMode;
}

/** The mobile client's configuration: the public configuration plus its resolved sign-in mode. */
export interface MobilePublicConfig extends PublicConfig {
  readonly authMode: AuthMode;
}

interface LoadOptions {
  /** Deployed builds of this client must use Cognito sign-in. */
  readonly requireCognitoWhenDeployed: boolean;
}

function loadPublicConfig(
  scope: string,
  prefix: string,
  env: EnvSource,
  options: LoadOptions,
): { readonly config: PublicConfig; readonly authMode: AuthMode } {
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
  const deployed = isDeployedEnvironment(raw.TALI_ENV);

  if (deployed && !raw.API_BASE_URL.startsWith("https://")) {
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
  const cognito: PublicCognitoConfig | undefined =
    raw.COGNITO_REGION !== undefined && raw.COGNITO_USER_POOL_ID !== undefined && raw.COGNITO_CLIENT_ID !== undefined
      ? { region: raw.COGNITO_REGION, userPoolId: raw.COGNITO_USER_POOL_ID, clientId: raw.COGNITO_CLIENT_ID }
      : undefined;
  if (cognito !== undefined && !cognito.userPoolId.startsWith(`${cognito.region}_`)) {
    issues.push({ key: `${prefix}COGNITO_USER_POOL_ID`, message: "must belong to COGNITO_REGION" });
  }

  const authMode: AuthMode =
    raw.AUTH_MODE ?? (raw.TALI_ENV === "local" ? "local" : cognito !== undefined ? "cognito" : "unavailable");
  if (authMode === "local" && raw.TALI_ENV !== "local") {
    issues.push({ key: `${prefix}AUTH_MODE`, message: "local sign-in is allowed only when TALI_ENV=local" });
  }
  if (authMode === "cognito" && cognito === undefined) {
    issues.push({ key: `${prefix}COGNITO_*`, message: "are required when AUTH_MODE=cognito" });
  }
  if (deployed && options.requireCognitoWhenDeployed && authMode !== "cognito") {
    issues.push({ key: `${prefix}AUTH_MODE`, message: `must be cognito when TALI_ENV=${raw.TALI_ENV}` });
  }

  if (issues.length > 0) {
    throw new ConfigurationError(scope, issues);
  }

  const base = { env: raw.TALI_ENV, apiBaseUrl: raw.API_BASE_URL };
  return { config: cognito === undefined ? base : { ...base, cognito: Object.freeze(cognito) }, authMode };
}

/**
 * Web public configuration from NEXT_PUBLIC_* variables. Next.js inlines only
 * statically referenced variables, so the web app passes an object literal of
 * explicit `process.env.NEXT_PUBLIC_*` reads. Only the keys in
 * PUBLIC_ENV_SUFFIXES are ever read. Deployed web builds must use Cognito.
 */
export function loadWebPublicConfig(env: EnvSource): WebPublicConfig {
  const { config, authMode } = loadPublicConfig("web public", WEB_PUBLIC_PREFIX, env, {
    requireCognitoWhenDeployed: true,
  });
  return Object.freeze({ ...config, authMode });
}

/**
 * Mobile public configuration from EXPO_PUBLIC_* variables (inlined by Expo the
 * same way). Deployed mobile builds must use Cognito (ADR-007).
 */
export function loadMobilePublicConfig(env: EnvSource): MobilePublicConfig {
  const { config, authMode } = loadPublicConfig("mobile public", MOBILE_PUBLIC_PREFIX, env, {
    requireCognitoWhenDeployed: true,
  });
  return Object.freeze({ ...config, authMode });
}
