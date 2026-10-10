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
  AdjustmentPathSchema,
  type AdjustmentResponse,
  type AdjustmentReversalResponse,
  EmptyQuerySchema,
  GoodsReceiptPathSchema,
  type GoodsReceiptResponse,
  type GoodsReceiptReversalResponse,
  IdempotencyKeyHeaderSchema,
  OpeningBatchPathSchema,
  type OpeningBatchResponse,
  PostGoodsReceiptRequestSchema,
  RecordAdjustmentRequestSchema,
  RecordOpeningStockRequestSchema,
  RecordWriteOffRequestSchema,
  ReverseDocumentRequestSchema,
} from "@tali/shared";
import type { Response } from "express";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../business/businesses.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import {
  toAdjustmentCreatedResponse,
  toAdjustmentResponse,
  toAdjustmentReversalResponse,
  toGoodsReceiptCreatedResponse,
  toGoodsReceiptResponse,
  toGoodsReceiptReversalResponse,
  toOpeningBatchCreatedResponse,
  toOpeningBatchResponse,
} from "../http/inventory-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest } from "../http/validation.js";
import { bindDefaultLocation } from "./default-location.js";

function created(response: Response, replayed: boolean): void {
  if (replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
  response.status(HttpStatus.CREATED);
}

/**
 * Stock documents at the business's default location: opening stock, goods
 * receipts, adjustments and write-offs, their reads and their reversals
 * (ADR-008 sections 9 to 11). Creates require `Idempotency-Key` and answer
 * 201, with `Idempotent-Replayed: true` on replay; a replay returns the
 * stored creation snapshot and the original movements. Reversals are
 * state-setting: reversing a REVERSED document is a 200 no-op.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class InventoryDocumentsController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** `inventory:opening`. */
  @Post("inventory/opening-stock")
  async recordOpeningStock(
    @ResolvedBusinessContext() business: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OpeningBatchResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RecordOpeningStockRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const outcome = await this.#services.recordOpeningStock.execute(context, {
      lines: input.lines,
      ...(input.note === undefined ? {} : { note: input.note }),
      idempotencyKey: key,
    });
    created(response, outcome.replayed);
    return toOpeningBatchCreatedResponse(outcome);
  }

  @Get("inventory/opening-batches/:openingBatchId")
  async getOpeningBatch(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<OpeningBatchResponse> {
    const { openingBatchId } = parseRequest(OpeningBatchPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toOpeningBatchResponse(
      await this.#services.getOpeningBatch.execute(context, { documentId: openingBatchId }),
    );
  }

  /** `inventory:receive`. No supplier, cost or purchase order. */
  @Post("inventory/goods-receipts")
  async postGoodsReceipt(
    @ResolvedBusinessContext() business: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GoodsReceiptResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(PostGoodsReceiptRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const outcome = await this.#services.postGoodsReceipt.execute(context, {
      lines: input.lines,
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      ...(input.note === undefined ? {} : { note: input.note }),
      idempotencyKey: key,
    });
    created(response, outcome.replayed);
    return toGoodsReceiptCreatedResponse(outcome);
  }

  @Get("inventory/goods-receipts/:goodsReceiptId")
  async getGoodsReceipt(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<GoodsReceiptResponse> {
    const { goodsReceiptId } = parseRequest(GoodsReceiptPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toGoodsReceiptResponse(
      await this.#services.getGoodsReceipt.execute(context, { documentId: goodsReceiptId }),
    );
  }

  /** `inventory:adjust`. Reverses the whole receipt. */
  @Post("inventory/goods-receipts/:goodsReceiptId/reverse")
  @HttpCode(HttpStatus.OK)
  async reverseGoodsReceipt(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<GoodsReceiptReversalResponse> {
    const { goodsReceiptId } = parseRequest(GoodsReceiptPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ReverseDocumentRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toGoodsReceiptReversalResponse(
      await this.#services.reverseGoodsReceipt.execute(context, { documentId: goodsReceiptId, reason: input.reason }),
    );
  }

  /** `inventory:adjust`. Each line has a direction and a positive magnitude. */
  @Post("inventory/adjustments")
  async recordAdjustment(
    @ResolvedBusinessContext() business: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdjustmentResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RecordAdjustmentRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const outcome = await this.#services.recordAdjustment.execute(context, {
      lines: input.lines,
      reasonCode: input.reasonCode,
      ...(input.reasonNote === undefined ? {} : { reasonNote: input.reasonNote }),
      ...(input.note === undefined ? {} : { note: input.note }),
      idempotencyKey: key,
    });
    created(response, outcome.replayed);
    return toAdjustmentCreatedResponse(outcome);
  }

  /** `inventory:adjust`. Positive magnitudes, each recorded as a decrease. */
  @Post("inventory/write-offs")
  async recordWriteOff(
    @ResolvedBusinessContext() business: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdjustmentResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RecordWriteOffRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const outcome = await this.#services.recordWriteOff.execute(context, {
      lines: input.lines,
      reasonCode: input.reasonCode,
      ...(input.reasonNote === undefined ? {} : { reasonNote: input.reasonNote }),
      ...(input.note === undefined ? {} : { note: input.note }),
      idempotencyKey: key,
    });
    created(response, outcome.replayed);
    return toAdjustmentCreatedResponse(outcome);
  }

  /** An adjustment or a write-off: `kind` tells them apart. */
  @Get("inventory/adjustments/:adjustmentId")
  async getAdjustment(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<AdjustmentResponse> {
    const { adjustmentId } = parseRequest(AdjustmentPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toAdjustmentResponse(await this.#services.getAdjustment.execute(context, { documentId: adjustmentId }));
  }

  /** `inventory:adjust`. Reverses a whole adjustment or write-off. */
  @Post("inventory/adjustments/:adjustmentId/reverse")
  @HttpCode(HttpStatus.OK)
  async reverseAdjustment(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<AdjustmentReversalResponse> {
    const { adjustmentId } = parseRequest(AdjustmentPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ReverseDocumentRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toAdjustmentReversalResponse(
      await this.#services.reverseAdjustment.execute(context, { documentId: adjustmentId, reason: input.reason }),
    );
  }
}
