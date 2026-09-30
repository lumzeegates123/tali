import { Body, Controller, Headers, HttpStatus, Inject, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { AuthenticatedUserContext } from "@tali/application";
import {
  CreateBusinessRequestSchema,
  type CreateBusinessResponse,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
} from "@tali/shared";
import type { Response } from "express";
import { AuthenticationGuard } from "../auth/authentication.guard.js";
import { RegisteredUserGuard } from "../auth/registered-user.guard.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES, LOGGER } from "../composition/tokens.js";
import { UserContext } from "../http/request-context.js";
import { toCreateBusinessResponse } from "../http/response-mappers.js";
import { parseRequest } from "../http/validation.js";
import type { Logger } from "../observability/logger.js";

/** ADR-004 section 4.2: a replayed keyed mutation returns the original response with this header. */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

/**
 * Business creation, a user-level operation: no business exists yet, so no
 * BusinessContext applies. Business-scoped routes live in
 * BusinessScopedController under `v1/businesses/:businessId`.
 */
@Controller("v1/businesses")
@UseGuards(AuthenticationGuard, RegisteredUserGuard)
export class BusinessesController {
  readonly #services: ApiServices;
  readonly #logger: Logger;

  constructor(@Inject(API_SERVICES) services: ApiServices, @Inject(LOGGER) logger: Logger) {
    this.#services = services;
    this.#logger = logger;
  }

  /** Requires `Idempotency-Key` (RFC 9562 UUID). A replay answers 201 with the stored result. */
  @Post()
  async create(
    @UserContext() user: AuthenticatedUserContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateBusinessResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(CreateBusinessRequestSchema, body, "body");
    const { result, replayed } = await this.#services.createBusiness.execute(user, {
      name: input.name,
      currencyCode: input.currencyCode,
      timeZone: input.timeZone,
      idempotencyKey: key,
    });
    if (replayed) {
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    } else {
      this.#logger.info("business.created", { businessId: result.business.id, userId: user.userId });
    }
    response.status(HttpStatus.CREATED);
    return toCreateBusinessResponse(result);
  }
}
