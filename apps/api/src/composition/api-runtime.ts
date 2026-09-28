import type { Clock, IdentityProvider } from "@tali/application";
import { FakeIdentityProvider } from "@tali/application/testing";
import type { ServerConfig } from "@tali/config/server";
import { createDatabase, type Database } from "@tali/database";
import { JsonLogger, type Logger } from "../observability/logger.js";

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

/**
 * Identity composition. Only the fake provider exists in Wave B; config
 * already rejects it outside local/test. The dev-JWT local provider and
 * Cognito are later plan steps and fail loudly rather than fall back.
 */
function composeIdentityProvider(config: ServerConfig, clock: Clock): IdentityProvider {
  switch (config.identity.provider) {
    case "fake":
      return new FakeIdentityProvider(clock);
    case "local":
      throw new CompositionError(
        "IDENTITY_PROVIDER=local is not implemented yet (plan step 8); use fake in local/test",
      );
    case "cognito":
      throw new CompositionError(
        "IDENTITY_PROVIDER=cognito is not implemented yet; no AWS integration exists in Wave B",
      );
  }
}

export interface ApiRuntimeOverrides {
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly database?: Database;
  readonly identityProvider?: IdentityProvider;
}

export function createApiRuntime(config: ServerConfig, overrides: ApiRuntimeOverrides = {}): ApiRuntime {
  const logger =
    overrides.logger ??
    new JsonLogger({ service: `${config.observability.serviceName}-api`, level: config.observability.logLevel });
  const clock = overrides.clock ?? systemClock;
  const identityProvider = overrides.identityProvider ?? composeIdentityProvider(config, clock);
  const database =
    overrides.database ??
    createDatabase({
      connectionString: config.database.url,
      applicationName: `${config.observability.serviceName}-api`,
    });

  let closed: Promise<void> | undefined;
  return {
    config,
    logger,
    clock,
    database,
    identityProvider,
    close() {
      closed ??= database.disconnect();
      return closed;
    },
  };
}
