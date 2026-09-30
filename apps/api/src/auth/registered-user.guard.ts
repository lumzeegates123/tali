import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { API_SERVICES, LOGGER } from "../composition/tokens.js";
import type { ApiServices } from "../composition/api-services.js";
import {
  correlationIdOf,
  HTTP_SOURCE_CHANNEL,
  RequestPipelineError,
  type TaliRequest,
} from "../http/request-context.js";
import type { Logger } from "../observability/logger.js";
import { logContextDenial } from "./context-denial.js";

/**
 * User-level routes (`/v1/me`, business creation). Runs after
 * AuthenticationGuard and resolves the verified identity to an ACTIVE Tali
 * user through the application resolver: an unlinked identity is
 * USER_NOT_REGISTERED, a disabled user USER_DISABLED.
 */
@Injectable()
export class RegisteredUserGuard implements CanActivate {
  readonly #services: ApiServices;
  readonly #logger: Logger;

  constructor(@Inject(API_SERVICES) services: ApiServices, @Inject(LOGGER) logger: Logger) {
    this.#services = services;
    this.#logger = logger;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TaliRequest>();
    const identity = request.identity;
    if (identity === undefined) throw new RequestPipelineError("a verified identity");
    request.userContext = await this.#services.userContexts
      .resolve(identity, { correlationId: correlationIdOf(request), sourceChannel: HTTP_SOURCE_CHANNEL })
      .catch((error: unknown) => logContextDenial(this.#logger, error));
    return true;
  }
}
