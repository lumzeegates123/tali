import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthenticationGuard } from "./auth/authentication.guard.js";
import { BusinessContextGuard } from "./auth/business-context.guard.js";
import { DeviceContextGuard } from "./auth/device-context.guard.js";
import { LocalSignInController } from "./auth/local-sign-in.controller.js";
import { RegisteredUserGuard } from "./auth/registered-user.guard.js";
import { TestIdentityController } from "./auth/test-identity.controller.js";
import { BusinessDevicesController } from "./business/business-devices.controller.js";
import { BusinessScopedController } from "./business/business-scoped.controller.js";
import { BusinessTeamController } from "./business/business-team.controller.js";
import { BusinessesController } from "./business/businesses.controller.js";
import type { ApiRuntime } from "./composition/api-runtime.js";
import {
  API_RUNTIME,
  API_SERVICES,
  CLOCK,
  DATABASE_HEALTH,
  IDENTITY_PROVIDER,
  INVITATION_ACCEPT_LIMITER,
  LOCAL_SIGN_IN,
  LOGGER,
  SERVER_CONFIG,
} from "./composition/tokens.js";
import { ErrorEnvelopeFilter } from "./errors/error-envelope.filter.js";
import { HealthController } from "./health/health.controller.js";
import { InvitationAcceptanceController } from "./identity/invitation-acceptance.controller.js";
import { MeController } from "./identity/me.controller.js";
import { RuntimeShutdown } from "./lifecycle/runtime-shutdown.js";

/**
 * Root module. Built from an ApiRuntime (the composition root's output) so
 * Nest only wires values; it never constructs adapters itself.
 *
 * Environment-gated routes are not mounted at all outside their environment,
 * rather than mounted and refused: the test identity probe in local and test
 * only, and local sign-in only when TALI_ENV=local and the local identity
 * provider was composed (ADR-005 section 16).
 */
@Module({})
export class AppModule {
  static register(runtime: ApiRuntime): DynamicModule {
    const controllers: Type[] = [
      HealthController,
      MeController,
      BusinessesController,
      InvitationAcceptanceController,
      BusinessScopedController,
      BusinessTeamController,
      BusinessDevicesController,
    ];
    const providers: Provider[] = [
      { provide: SERVER_CONFIG, useValue: runtime.config },
      { provide: LOGGER, useValue: runtime.logger },
      { provide: CLOCK, useValue: runtime.clock },
      { provide: DATABASE_HEALTH, useValue: runtime.database },
      { provide: IDENTITY_PROVIDER, useValue: runtime.identityProvider },
      { provide: API_SERVICES, useValue: runtime.services },
      { provide: API_RUNTIME, useValue: runtime },
      { provide: INVITATION_ACCEPT_LIMITER, useValue: runtime.invitationAcceptLimiter },
      { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
      AuthenticationGuard,
      RegisteredUserGuard,
      BusinessContextGuard,
      DeviceContextGuard,
      RuntimeShutdown,
    ];
    if (runtime.config.api.testRoutesEnabled) {
      controllers.push(TestIdentityController);
    }
    if (runtime.config.env === "local" && runtime.localSignIn !== undefined) {
      controllers.push(LocalSignInController);
      providers.push({ provide: LOCAL_SIGN_IN, useValue: runtime.localSignIn });
    }

    return { module: AppModule, controllers, providers };
  }
}
