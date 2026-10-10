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
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  CancelStocktakeRequestSchema,
  type CancelStocktakeResponse,
  CreateStocktakeRequestSchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  PageQuerySchema,
  PostStocktakeRequestSchema,
  type PostStocktakeResponse,
  RecordStocktakeCountRequestSchema,
  RemoveStocktakeLineRequestSchema,
  type StocktakeCreationResponse,
  type StocktakeLineChangeResponse,
  StocktakeLinePathSchema,
  type StocktakeLinesResponse,
  StocktakeListQuerySchema,
  StocktakePathSchema,
  type StocktakeResponse,
  type StocktakesResponse,
} from "@tali/shared";
import type { Response } from "express";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../business/businesses.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import {
  toCancelStocktakeResponse,
  toPostStocktakeResponse,
  toStocktakeCreationResponse,
  toStocktakeLineChangeResponse,
  toStocktakeLinesResponse,
  toStocktakeResponse,
  toStocktakesResponse,
} from "../http/inventory-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest, toPageInput } from "../http/validation.js";
import { bindDefaultLocation } from "./default-location.js";

/**
 * Stocktakes at the business's default location (Slice 6). Every route needs
 * `inventory:count`; posting and cancelling need `inventory:count-post`. Members without
 * `inventory:count-post` see BLIND stocktakes and lines, without expected
 * quantities or variances. Creating requires `Idempotency-Key`: a replay
 * answers 201 with the DRAFT version-1 creation snapshot, whatever happened
 * to the stocktake since. Counting, removing, posting and cancelling are
 * state-setting with `expectedVersion`; posting a POSTED stocktake answers
 * the current POSTED view.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class StocktakesController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  @Post("inventory/stocktakes")
  async create(
    @ResolvedBusinessContext() business: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StocktakeCreationResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(CreateStocktakeRequestSchema, body ?? {}, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const outcome = await this.#services.createStocktake.execute(context, {
      ...(input.note === undefined ? {} : { note: input.note }),
      idempotencyKey: key,
    });
    if (outcome.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    response.status(HttpStatus.CREATED);
    return toStocktakeCreationResponse(outcome);
  }

  @Get("inventory/stocktakes")
  async list(
    @ResolvedBusinessContext() business: BusinessContext,
    @Query() query: unknown,
  ): Promise<StocktakesResponse> {
    const input = parseRequest(StocktakeListQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    const page = await this.#services.listStocktakes.execute(context, {
      ...toPageInput(input),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return toStocktakesResponse(page);
  }

  @Get("inventory/stocktakes/:stocktakeId")
  async get(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<StocktakeResponse> {
    const { stocktakeId } = parseRequest(StocktakePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toStocktakeResponse(await this.#services.getStocktake.execute(context, { stocktakeId }));
  }

  /** Lines in variant-ID order, REMOVED lines included. */
  @Get("inventory/stocktakes/:stocktakeId/lines")
  async lines(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<StocktakeLinesResponse> {
    const { stocktakeId } = parseRequest(StocktakePathSchema, params, "path");
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    const context = await bindDefaultLocation(this.#services, business);
    return toStocktakeLinesResponse(await this.#services.listStocktakeLines.execute(context, { stocktakeId, ...page }));
  }

  /** Creates or replaces one variant's count; omit `expectedVersion` (or send 0) for a first count. */
  @Put("inventory/stocktakes/:stocktakeId/lines/:variantId")
  async count(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<StocktakeLineChangeResponse> {
    const { stocktakeId, variantId } = parseRequest(StocktakeLinePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RecordStocktakeCountRequestSchema, body, "body");
    const { count } = input;
    const context = await bindDefaultLocation(this.#services, business);
    return toStocktakeLineChangeResponse(
      await this.#services.recordStocktakeCount.execute(context, {
        stocktakeId,
        variantId,
        count:
          "packId" in count
            ? {
                packId: count.packId,
                packCount: count.packCount,
                ...(count.loose === undefined ? {} : { loose: count.loose }),
              }
            : count,
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      }),
    );
  }

  @Post("inventory/stocktakes/:stocktakeId/lines/:variantId/remove")
  @HttpCode(HttpStatus.OK)
  async removeLine(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<StocktakeLineChangeResponse> {
    const { stocktakeId, variantId } = parseRequest(StocktakeLinePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RemoveStocktakeLineRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toStocktakeLineChangeResponse(
      await this.#services.removeStocktakeLine.execute(context, {
        stocktakeId,
        variantId,
        expectedVersion: input.expectedVersion,
      }),
    );
  }

  /** `inventory:count-post`. One COUNT_CORRECTION per non-zero variance, in one transaction. */
  @Post("inventory/stocktakes/:stocktakeId/post")
  @HttpCode(HttpStatus.OK)
  async post(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<PostStocktakeResponse> {
    const { stocktakeId } = parseRequest(StocktakePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(PostStocktakeRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toPostStocktakeResponse(
      await this.#services.postStocktake.execute(context, { stocktakeId, expectedVersion: input.expectedVersion }),
    );
  }

  /** `inventory:count-post`. Cancels a DRAFT stocktake; nothing moves. */
  @Post("inventory/stocktakes/:stocktakeId/cancel")
  @HttpCode(HttpStatus.OK)
  async cancel(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<CancelStocktakeResponse> {
    const { stocktakeId } = parseRequest(StocktakePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(CancelStocktakeRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toCancelStocktakeResponse(
      await this.#services.cancelStocktake.execute(context, {
        stocktakeId,
        expectedVersion: input.expectedVersion,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    );
  }
}
