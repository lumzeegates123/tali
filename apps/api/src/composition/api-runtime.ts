import type {
  Clock,
  FingerprintHasher,
  IdentityProvider,
  IdGenerator,
  OneTimeSecretGenerator,
  SecretHasher,
} from "@tali/application";
import { FakeIdentityProvider } from "@tali/application/testing";
import type { ServerConfig } from "@tali/config/server";
import { createDatabase, type Database } from "@tali/database";
import { CognitoIdentityProvider, type JwksFetch } from "@tali/integrations/aws/cognito";
import { LocalIdentityProvider } from "@tali/integrations/local";
import {
  nodeOneTimeSecretGenerator,
  Sha256FingerprintHasher,
  sha256SecretHasher,
  uuidV7IdGenerator,
} from "@tali/integrations/platform";
import { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
import { JsonLogger, type Logger } from "../observability/logger.js";
import { type ApiServices, composeApiServices } from "./api-services.js";
import type { LocalSignIn } from "./local-sign-in.js";

/**
 * Everything the API process composes, built once at startup. Controllers and
 * guards receive these through tokens; they never construct adapters.
 */
export interface ApiRuntime {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly database: Database;
  readonly identityProvider: IdentityProvider;
  readonly services: ApiServices;
  /** Per-user limiter for invitation acceptance: a per-process safeguard only (ADR-005 section 18). */
  readonly invitationAcceptLimiter: FixedWindowRateLimiter;
  /** Present only when TALI_ENV=local and the local identity provider is composed (ADR-005 section 16). */
  readonly localSignIn?: LocalSignIn;
  /** Releases process resources (database pool). Idempotent. */
  close(): Promise<void>;
}

export const systemClock: Clock = { now: () => new Date() };

export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/** Local sign-in limits: a local safeguard only (ADR-005 section 18), per client address. */
export const LOCAL_SIGN_IN_LIMIT = { limit: 20, windowMs: 60_000, maxKeys: 256 } as const;

/**
 * Invitation acceptance limits, per authenticated user, in this process only.
 * Tokens carry 256 bits of entropy, so this is defense in depth and never a
 * global limit across tasks (plan 003 section 5).
 */
export const INVITATION_ACCEPT_LIMIT = { limit: 10, windowMs: 60_000, maxKeys: 4_096 } as const;

/**
 * Identity composition, selected only by IDENTITY_PROVIDER, with no fallback.
 * Server configuration already refuses `local` outside TALI_ENV=local and
 * `fake` outside local and test; composition checks again, so a hand-built or
 * altered config can never put a development provider in a deployed process.
 * Cognito verifies access tokens locally against the pool's JWKS; it is
 * constructed without any network access (the JWKS is fetched on first use).
 */
async function composeIdentityProvider(
  config: ServerConfig,
  clock: Clock,
  jwksFetch: JwksFetch | undefined,
): Promise<{ provider: IdentityProvider; local?: LocalIdentityProvider }> {
  switch (config.identity.provider) {
    case "fake":
      if (config.env !== "local" && config.env !== "test") {
        throw new CompositionError(`IDENTITY_PROVIDER=fake is not allowed in ${config.env}`);
      }
      return { provider: new FakeIdentityProvider(clock) };
    case "local": {
      if (config.env !== "local") {
        throw new CompositionError(`IDENTITY_PROVIDER=local is not allowed in ${config.env}`);
      }
      const local = await LocalIdentityProvider.create({ clock });
      return { provider: local, local };
    }
    case "cognito": {
      if (jwksFetch !== undefined && config.env !== "local" && config.env !== "test") {
        throw new CompositionError(`A replacement JWKS fetch is not allowed in ${config.env}`);
      }
      const { region, userPoolId, clientIds } = config.identity;
      return {
        provider: new CognitoIdentityProvider({
          region,
          userPoolId,
          clientIds,
          clock,
          ...(jwksFetch === undefined ? {} : { fetch: jwksFetch }),
        }),
      };
    }
  }
}

export interface ApiRuntimeOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly database?: Database;
  readonly identityProvider?: IdentityProvider;
  readonly ids?: IdGenerator;
  readonly hasher?: FingerprintHasher;
  readonly secrets?: OneTimeSecretGenerator;
  readonly secretHasher?: SecretHasher;
  /** Tests only (TALI_ENV local or test): serves the Cognito JWKS without the network. */
  readonly cognitoJwksFetch?: JwksFetch;
}

export async function createApiRuntime(config: ServerConfig, overrides: ApiRuntimeOverrides = {}): Promise<ApiRuntime> {
  const logger =
    overrides.logger ??
    new JsonLogger({ service: `${config.observability.serviceName}-api`, level: config.observability.logLevel });
  const clock = overrides.clock ?? systemClock;
  const identity =
    overrides.identityProvider === undefined
      ? await composeIdentityProvider(config, clock, overrides.cognitoJwksFetch)
      : { provider: overrides.identityProvider };
  const database =
    overrides.database ??
    createDatabase({
      connectionString: config.database.url,
      applicationName: `${config.observability.serviceName}-api`,
    });
  const services = composeApiServices({
    database,
    clock,
    ids: overrides.ids ?? uuidV7IdGenerator,
    hasher: overrides.hasher ?? new Sha256FingerprintHasher(),
    secrets: overrides.secrets ?? nodeOneTimeSecretGenerator,
    secretHasher: overrides.secretHasher ?? sha256SecretHasher,
  });
  const invitationAcceptLimiter = new FixedWindowRateLimiter({ clock, ...INVITATION_ACCEPT_LIMIT });
  const localSignIn: LocalSignIn | undefined =
    config.env === "local" && identity.local !== undefined
      ? { issuer: identity.local, limiter: new FixedWindowRateLimiter({ clock, ...LOCAL_SIGN_IN_LIMIT }) }
      : undefined;

  let closed: Promise<void> | undefined;
  return {
    config,
    logger,
    clock,
    database,
    identityProvider: identity.provider,
    services,
    invitationAcceptLimiter,
    ...(localSignIn === undefined ? {} : { localSignIn }),
    close() {
      closed ??= database.disconnect();
      return closed;
    },
  };
}
