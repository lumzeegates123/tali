import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { NotFoundError } from "@tali/application";
import { BusinessPathSchema } from "@tali/shared";
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
 * Business-scoped routes (`/v1/businesses/:businessId/...`). Runs after
 * AuthenticationGuard and resolves the BusinessContext server-side through the
 * application resolvers (ADR-005 section 12): the user must be registered and
 * ACTIVE, then hold an ACTIVE membership of an ACTIVE business. The path value
 * is only a claim: an unknown, foreign, suspended or malformed business is
 * NOT_FOUND with one body, before any other validation of the request.
 *
 * Device headers (X-Tali-Device-*) are verified next, by DeviceContextGuard,
 * against the business resolved here (plan 003 section 5 step 8).
 */
@Injectable()
export class BusinessContextGuard implements CanActivate {
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
    const user = await this.#services.userContexts
      .resolve(identity, { correlationId: correlationIdOf(request), sourceChannel: HTTP_SOURCE_CHANNEL })
      .catch((error: unknown) => logContextDenial(this.#logger, error));
    // Nested routes carry more parameters; those are validated by the handler.
    const path = BusinessPathSchema.safeParse({ businessId: request.params["businessId"] });
    if (!path.success) logContextDenial(this.#logger, new NotFoundError("Business not found"), { userId: user.userId });
    request.userContext = user;
    request.businessContext = await this.#services.businessContexts
      .resolveForUser(user, path.data.businessId)
      .catch((error: unknown) => logContextDenial(this.#logger, error, { userId: user.userId }));
    return true;
  }
}
