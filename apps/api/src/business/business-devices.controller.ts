import {
  Body,
  Controller,
  Get,
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
  DevicePathSchema,
  type DevicesResponse,
  EmptyBodySchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  PageQuerySchema,
  RegisterDeviceRequestSchema,
  type RegisterDeviceResponse,
  type RevokeDeviceResponse,
} from "@tali/shared";
import type { Response } from "express";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { toDevicesResponse, toRegisterDeviceResponse, toRevokeDeviceResponse } from "../http/response-mappers.js";
import { parseRequest, toPageInput } from "../http/validation.js";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "./business-scoped.controller.js";
import { preventCaching } from "./business-team.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "./businesses.controller.js";

/**
 * Device registrations of one business (ADR-005 section 15). A device never
 * authenticates a user: these routes, like every business-scoped route,
 * require the normal user authentication and business context first.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class BusinessDevicesController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** `device:register`, requires `Idempotency-Key`. The credential is in the original 201 response only. */
  @Post("devices")
  async register(
    @ResolvedBusinessContext() context: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisterDeviceResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RegisterDeviceRequestSchema, body, "body");
    const outcome = await this.#services.registerDevice.execute(context, {
      platform: input.platform,
      label: input.label,
      idempotencyKey: key,
    });
    preventCaching(response);
    if (outcome.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    response.status(HttpStatus.CREATED);
    return toRegisterDeviceResponse(outcome);
  }

  /** `device:read` (OWNER, MANAGER): safe metadata only. */
  @Get("devices")
  async list(@ResolvedBusinessContext() context: BusinessContext, @Query() query: unknown): Promise<DevicesResponse> {
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    return toDevicesResponse(await this.#services.listDevices.execute(context, page));
  }

  /** `device:revoke` (OWNER). Revoking a REVOKED device is a no-op. */
  @Post("devices/:deviceId/revoke")
  @HttpCode(HttpStatus.OK)
  async revoke(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<RevokeDeviceResponse> {
    const { deviceId } = parseRequest(DevicePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    parseRequest(EmptyBodySchema, body ?? {}, "body");
    const { device } = await this.#services.revokeDevice.execute(context, { deviceId });
    return toRevokeDeviceResponse(device);
  }
}
