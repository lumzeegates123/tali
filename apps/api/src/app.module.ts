import { type DynamicModule, Module, type Type } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthenticationGuard } from "./auth/authentication.guard.js";
import { TestIdentityController } from "./auth/test-identity.controller.js";
import type { ApiRuntime } from "./composition/api-runtime.js";
import { API_RUNTIME, CLOCK, DATABASE_HEALTH, IDENTITY_PROVIDER, LOGGER, SERVER_CONFIG } from "./composition/tokens.js";
import { ErrorEnvelopeFilter } from "./errors/error-envelope.filter.js";
import { HealthController } from "./health/health.controller.js";
import { RuntimeShutdown } from "./lifecycle/runtime-shutdown.js";

/**
 * Root module. Built from an ApiRuntime (the composition root's output) so
 * Nest only wires values; it never constructs adapters itself.
 */
@Module({})
export class AppModule {
  static register(runtime: ApiRuntime): DynamicModule {
    const controllers: Type[] = [HealthController];
    if (runtime.config.api.testRoutesEnabled) {
      controllers.push(TestIdentityController);
    }

    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: SERVER_CONFIG, useValue: runtime.config },
        { provide: LOGGER, useValue: runtime.logger },
        { provide: CLOCK, useValue: runtime.clock },
        { provide: DATABASE_HEALTH, useValue: runtime.database },
        { provide: IDENTITY_PROVIDER, useValue: runtime.identityProvider },
        { provide: API_RUNTIME, useValue: runtime },
        { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
        AuthenticationGuard,
        RuntimeShutdown,
      ],
    };
  }
}
