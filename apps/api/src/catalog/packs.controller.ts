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
  AddPackRequestSchema,
  EmptyBodySchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  PackListQuerySchema,
  PackPathSchema,
  type PackResponse,
  type PacksResponse,
  ProductPathSchema,
} from "@tali/shared";
import type { Response } from "express";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../business/businesses.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { toPackResponse, toPacksResponse } from "../http/catalog-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest, toPageInput } from "../http/validation.js";

/**
 * Data-entry pack conversions of a product's default variant (ADR-008
 * section 3.4). Packs carry no price and no barcode. Retirement is addressed
 * by business and pack ID only and takes no version. Permissions
 * (`product:read`, `product:manage`) are checked by the use cases.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class PacksController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** `status` defaults to ACTIVE. */
  @Get("products/:productId/packs")
  async list(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<PacksResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    const input = parseRequest(PackListQuerySchema, query, "query");
    const page = await this.#services.listProductPacks.execute(context, {
      productId,
      ...toPageInput(input),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return toPacksResponse(page);
  }

  /** Requires `Idempotency-Key`; 201, and 201 with `Idempotent-Replayed: true` on replay. */
  @Post("products/:productId/packs")
  async add(
    @ResolvedBusinessContext() context: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PackResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(AddPackRequestSchema, body, "body");
    const outcome = await this.#services.addPack.execute(context, {
      productId,
      name: input.name,
      factorMinor: input.factorMinor,
      idempotencyKey: key,
    });
    if (outcome.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    response.status(HttpStatus.CREATED);
    return toPackResponse(outcome.pack);
  }

  /** ACTIVE to RETIRED; retiring a RETIRED pack is a 200 no-op. */
  @Post("packs/:packId/retire")
  @HttpCode(HttpStatus.OK)
  async retire(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<PackResponse> {
    const { packId } = parseRequest(PackPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    parseRequest(EmptyBodySchema, body ?? {}, "body");
    const { pack } = await this.#services.retirePack.execute(context, { packId });
    return toPackResponse(pack);
  }
}
