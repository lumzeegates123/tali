import { Body, Controller, Get, HttpStatus, Inject, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { AuthenticatedUserContext, CorrelationId, VerifiedIdentity } from "@tali/application";
import {
  type CurrentUserResponse,
  EmptyQuerySchema,
  type MyBusinessesResponse,
  PageQuerySchema,
  RegisterCurrentUserRequestSchema,
} from "@tali/shared";
import type { Response } from "express";
import { AuthenticationGuard } from "../auth/authentication.guard.js";
import { RegisteredUserGuard } from "../auth/registered-user.guard.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES, LOGGER } from "../composition/tokens.js";
import {
  HTTP_SOURCE_CHANNEL,
  RequestCorrelationId,
  UserContext,
  VerifiedRequestIdentity,
} from "../http/request-context.js";
import { toCurrentUserResponse, toMyBusinessesResponse } from "../http/response-mappers.js";
import { parseRequest, toPageInput } from "../http/validation.js";
import type { Logger } from "../observability/logger.js";

/** The caller's own Tali user: explicit registration, profile and accessible businesses. */
@Controller("v1/me")
export class MeController {
  readonly #services: ApiServices;
  readonly #logger: Logger;

  constructor(@Inject(API_SERVICES) services: ApiServices, @Inject(LOGGER) logger: Logger) {
    this.#services = services;
    this.#logger = logger;
  }

  /**
   * Links the verified identity to a new Tali user (201), or returns the
   * already-linked user unchanged (200). Naturally idempotent through the
   * identity's unique key: no Idempotency-Key and no second audit record.
   */
  @Post("registration")
  @UseGuards(AuthenticationGuard)
  async register(
    @VerifiedRequestIdentity() identity: VerifiedIdentity,
    @RequestCorrelationId() correlationId: CorrelationId,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CurrentUserResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RegisterCurrentUserRequestSchema, body, "body");
    const { user, registered } = await this.#services.registerCurrentUser.execute({
      identity,
      displayName: input.displayName,
      correlationId,
      sourceChannel: HTTP_SOURCE_CHANNEL,
    });
    if (registered) this.#logger.info("user.registered", { userId: user.id });
    response.status(registered ? HttpStatus.CREATED : HttpStatus.OK);
    return toCurrentUserResponse(user);
  }

  @Get()
  @UseGuards(AuthenticationGuard, RegisteredUserGuard)
  async current(@UserContext() user: AuthenticatedUserContext, @Query() query: unknown): Promise<CurrentUserResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    return toCurrentUserResponse(await this.#services.getCurrentUser.execute(user));
  }

  @Get("businesses")
  @UseGuards(AuthenticationGuard, RegisteredUserGuard)
  async businesses(
    @UserContext() user: AuthenticatedUserContext,
    @Query() query: unknown,
  ): Promise<MyBusinessesResponse> {
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    return toMyBusinessesResponse(await this.#services.listMyBusinesses.execute(user, page));
  }
}
