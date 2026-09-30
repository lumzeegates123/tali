import type { Clock, FingerprintHasher, IdentityProvider, IdGenerator } from "@tali/application";
import { FakeIdentityProvider } from "@tali/application/testing";
import type { ServerConfig } from "@tali/config/server";
import { createDatabase, type Database } from "@tali/database";
import { LocalIdentityProvider } from "@tali/integrations/local";
import { Sha256FingerprintHasher, uuidV7IdGenerator } from "@tali/integrations/platform";
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
 * Identity composition. Server configuration already refuses `local` outside
 * TALI_ENV=local and `fake` outside local and test; composition checks again,
 * so a hand-built or altered config can never put a development provider in a
 * deployed process. Cognito is blocked on ADR-003 and fails loudly.
 */
async function composeIdentityProvider(
  config: ServerConfig,
  clock: Clock,
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
    case "cognito":
      throw new CompositionError("IDENTITY_PROVIDER=cognito is not implemented yet (blocked on ADR-003)");
  }
}

export interface ApiRuntimeOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly database?: Database;
  readonly identityProvider?: IdentityProvider;
  readonly ids?: IdGenerator;
  readonly hasher?: FingerprintHasher;
}

export async function createApiRuntime(config: ServerConfig, overrides: ApiRuntimeOverrides = {}): Promise<ApiRuntime> {
  const logger =
    overrides.logger ??
    new JsonLogger({ service: `${config.observability.serviceName}-api`, level: config.observability.logLevel });
  const clock = overrides.clock ?? systemClock;
  const identity =
    overrides.identityProvider === undefined
      ? await composeIdentityProvider(config, clock)
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
  });
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
    ...(localSignIn === undefined ? {} : { localSignIn }),
    close() {
      closed ??= database.disconnect();
      return closed;
    },
  };
}
