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
import type { BusinessContext, RecordSaleLineInput, RecordSaleTenderInput } from "@tali/application";
import {
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  PageQuerySchema,
  RecordSaleRequestSchema,
  ReverseSaleRequestSchema,
  type SaleLineRequestWire,
  SalePathSchema,
  type SaleResponse,
  type SalesResponse,
  type SaleTenderRequestWire,
} from "@tali/shared";
import type { Response } from "express";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../business/businesses.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { toSaleResponse, toSalesResponse } from "../http/sales-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest, toPageInput } from "../http/validation.js";
import { bindDefaultLocation } from "../inventory/default-location.js";

function replayed(response: Response, wasReplayed: boolean): void {
  if (wasReplayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
}

function line(wire: SaleLineRequestWire): RecordSaleLineInput {
  return {
    variantId: wire.variantId,
    quantityMinor: wire.quantity.quantityMinor,
    unit: wire.quantity.unit,
    expectedPriceVersion: wire.expectedPriceVersion,
    ...(wire.discount === undefined ? {} : { discount: wire.discount }),
  };
}

function tender(wire: SaleTenderRequestWire): RecordSaleTenderInput {
  return {
    method: wire.method,
    amount: wire.amount,
    ...(wire.reference === undefined ? {} : { reference: wire.reference }),
    ...(wire.cashReceived === undefined ? {} : { cashReceived: wire.cashReceived }),
  };
}

/**
 * Sales at the business's default location (ADR-011). Prices, totals, tax,
 * stock, cost, receipt numbers, permissions and idempotency are decided by the
 * application; this controller only parses, binds the location and maps.
 * Recording requires `Idempotency-Key` equal to `saleId` and answers 201, with
 * `Idempotent-Replayed: true` on replay. A reversal requires its own
 * `Idempotency-Key` and answers 200, with the same header on replay.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class SalesController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** `sales:create`; a discount also needs `sales:discount`. */
  @Post("sales")
  async recordSale(
    @ResolvedBusinessContext() business: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SaleResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(RecordSaleRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const result = await this.#services.recordSale.execute(context, {
      saleId: input.saleId,
      idempotencyKey: key,
      ...(input.deviceReportedAt === undefined ? {} : { deviceReportedAt: input.deviceReportedAt }),
      lines: input.lines.map(line),
      tenders: input.tenders.map(tender),
    });
    replayed(response, result.replayed);
    response.status(HttpStatus.CREATED);
    return toSaleResponse(result.sale);
  }

  /** `sales:read`, or `sales:read-own` for the caller's own sales; ascending by sale ID. */
  @Get("sales")
  async listSales(
    @ResolvedBusinessContext() business: BusinessContext,
    @Query() query: unknown,
  ): Promise<SalesResponse> {
    const page = parseRequest(PageQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toSalesResponse(await this.#services.listSales.execute(context, toPageInput(page)));
  }

  @Get("sales/:saleId")
  async getSale(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<SaleResponse> {
    const { saleId } = parseRequest(SalePathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toSaleResponse(await this.#services.getSale.execute(context, saleId));
  }

  /** `sales:reverse`. The whole sale; the cashier confirms the tender was unwound. */
  @Post("sales/:saleId/reversal")
  @HttpCode(HttpStatus.OK)
  async reverseSale(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SaleResponse> {
    const { saleId } = parseRequest(SalePathSchema, params, "path");
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ReverseSaleRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    const result = await this.#services.reverseSale.execute(context, {
      saleId,
      reason: input.reason,
      tenderUnwoundConfirmed: input.tenderUnwoundConfirmed,
      idempotencyKey: key,
    });
    replayed(response, result.replayed);
    return toSaleResponse(result.sale);
  }
}
