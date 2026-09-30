import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  ChangeMemberRoleRequestSchema,
  CreateInvitationRequestSchema,
  type CreateInvitationResponse,
  EmptyBodySchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  InvitationPathSchema,
  type MemberChangeResponse,
  MemberPathSchema,
  MemberStatusChangeRequestSchema,
  type RevokeInvitationResponse,
} from "@tali/shared";
import type { Response } from "express";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import {
  toCreateInvitationResponse,
  toMemberChangeResponse,
  toRevokeInvitationResponse,
} from "../http/response-mappers.js";
import { parseRequest } from "../http/validation.js";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "./business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "./businesses.controller.js";

/** Responses that can carry a one-time secret are never stored by caches (ADR-004 section 12). */
export function preventCaching(response: Response): void {
  response.setHeader("Cache-Control", "no-store");
}

/**
 * Invitations and member management for one business (ADR-005 sections 9
 * and 14). Guarded like every business-scoped route; permissions
 * (`member:invite`, `member:manage`) are checked by the use cases, which also
 * re-read the acting membership in the transaction.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class BusinessTeamController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** Requires `Idempotency-Key`. The token is in the original 201 response only. */
  @Post("invitations")
  async createInvitation(
    @ResolvedBusinessContext() context: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateInvitationResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(CreateInvitationRequestSchema, body, "body");
    const outcome = await this.#services.createInvitation.execute(context, { role: input.role, idempotencyKey: key });
    preventCaching(response);
    if (outcome.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    response.status(HttpStatus.CREATED);
    return toCreateInvitationResponse(outcome);
  }

  @Post("invitations/:invitationId/revoke")
  @HttpCode(HttpStatus.OK)
  async revokeInvitation(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<RevokeInvitationResponse> {
    const { invitationId } = parseRequest(InvitationPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    parseRequest(EmptyBodySchema, body ?? {}, "body");
    const { invitation } = await this.#services.revokeInvitation.execute(context, { invitationId });
    return toRevokeInvitationResponse(invitation);
  }

  @Post("members/:membershipId/role")
  @HttpCode(HttpStatus.OK)
  async changeRole(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<MemberChangeResponse> {
    const { membershipId } = parseRequest(MemberPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ChangeMemberRoleRequestSchema, body, "body");
    const { membership } = await this.#services.changeMemberRole.execute(context, {
      membershipId,
      role: input.role,
      reason: input.reason,
    });
    return toMemberChangeResponse(membership);
  }

  @Post("members/:membershipId/suspend")
  @HttpCode(HttpStatus.OK)
  async suspend(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<MemberChangeResponse> {
    const { membershipId } = parseRequest(MemberPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const { reason } = parseRequest(MemberStatusChangeRequestSchema, body, "body");
    const { membership } = await this.#services.suspendMember.execute(context, { membershipId, reason });
    return toMemberChangeResponse(membership);
  }

  @Post("members/:membershipId/reactivate")
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<MemberChangeResponse> {
    const { membershipId } = parseRequest(MemberPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const { reason } = parseRequest(MemberStatusChangeRequestSchema, body, "body");
    const { membership } = await this.#services.reactivateMember.execute(context, { membershipId, reason });
    return toMemberChangeResponse(membership);
  }
}
