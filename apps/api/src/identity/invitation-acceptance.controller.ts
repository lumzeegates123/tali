import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { AuthenticatedUserContext } from "@tali/application";
import { AcceptInvitationRequestSchema, type AcceptInvitationResponse, EmptyQuerySchema } from "@tali/shared";
import type { Response } from "express";
import { AuthenticationGuard } from "../auth/authentication.guard.js";
import type { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";
import { RegisteredUserGuard } from "../auth/registered-user.guard.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES, INVITATION_ACCEPT_LIMITER, LOGGER } from "../composition/tokens.js";
import { UserContext } from "../http/request-context.js";
import { toAcceptInvitationResponse } from "../http/response-mappers.js";
import { parseRequest } from "../http/validation.js";
import type { Logger } from "../observability/logger.js";

/**
 * `POST /v1/invitations/accept` (ADR-005 section 14): a user-level route, as
 * no business context exists until the invitation is accepted. The token
 * travels only in the body and is never logged. Unknown, expired, revoked and
 * foreign invitations answer one uniform NOT_FOUND. Attempts are limited per
 * user in this process only (defense in depth; never a global limit).
 */
@Controller("v1/invitations")
@UseGuards(AuthenticationGuard, RegisteredUserGuard)
export class InvitationAcceptanceController {
  readonly #services: ApiServices;
  readonly #limiter: FixedWindowRateLimiter;
  readonly #logger: Logger;

  constructor(
    @Inject(API_SERVICES) services: ApiServices,
    @Inject(INVITATION_ACCEPT_LIMITER) limiter: FixedWindowRateLimiter,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#services = services;
    this.#limiter = limiter;
    this.#logger = logger;
  }

  @Post("accept")
  @HttpCode(HttpStatus.OK)
  async accept(
    @UserContext() user: AuthenticatedUserContext,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AcceptInvitationResponse> {
    if (!this.#limiter.tryConsume(user.userId)) {
      throw new HttpException("Too many invitation attempts; try again later", HttpStatus.TOO_MANY_REQUESTS);
    }
    parseRequest(EmptyQuerySchema, query, "query");
    const { token } = parseRequest(AcceptInvitationRequestSchema, body, "body");
    const result = await this.#services.acceptInvitation.execute(user, { token });
    response.setHeader("Cache-Control", "no-store");
    if (!result.replayed) {
      this.#logger.info("invitation.accepted", {
        businessId: result.business.id,
        membershipId: result.membership.id,
        userId: user.userId,
      });
    }
    return toAcceptInvitationResponse(result);
  }
}
