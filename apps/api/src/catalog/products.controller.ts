import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  ArchiveProductRequestSchema,
  CreateProductRequestSchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  PageQuerySchema,
  type PriceHistoryResponse,
  ProductListQuerySchema,
  ProductPathSchema,
  type ProductResponse,
  type ProductsResponse,
  ReactivateProductRequestSchema,
  SetSellingPriceRequestSchema,
  UpdateProductRequestSchema,
} from "@tali/shared";
import type { Response } from "express";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../business/businesses.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { toPriceHistoryResponse, toProductResponse, toProductsResponse } from "../http/catalog-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest, toPageInput } from "../http/validation.js";

/**
 * Products of one business with their hidden default variant (ADR-008
 * sections 3 and 15). Guarded like every business-scoped route; permissions
 * (`product:read`, `product:manage`, `product:price`) are checked by the use
 * cases, which also re-read the acting membership for every mutation.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class ProductsController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** `status` defaults to ACTIVE; `q` matches name (contains), SKU or barcode (exact, normalized). */
  @Get("products")
  async list(@ResolvedBusinessContext() context: BusinessContext, @Query() query: unknown): Promise<ProductsResponse> {
    const input = parseRequest(ProductListQuerySchema, query, "query");
    const page = await this.#services.listProducts.execute(context, {
      ...toPageInput(input),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.q === undefined ? {} : { q: input.q }),
    });
    return toProductsResponse(page);
  }

  @Get("products/:productId")
  async get(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<ProductResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    return toProductResponse(await this.#services.getProduct.execute(context, { productId }));
  }

  /** Requires `Idempotency-Key`; 201, and 201 with `Idempotent-Replayed: true` on replay. */
  @Post("products")
  async create(
    @ResolvedBusinessContext() context: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProductResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(CreateProductRequestSchema, body, "body");
    const outcome = await this.#services.createProduct.execute(context, {
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.sku === undefined ? {} : { sku: input.sku }),
      ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
      stockUnit: input.stockUnit,
      trackInventory: input.trackInventory,
      ...(input.initialPrice === undefined ? {} : { initialPrice: input.initialPrice }),
      idempotencyKey: key,
    });
    if (outcome.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    response.status(HttpStatus.CREATED);
    return toProductResponse(outcome.item);
  }

  /** State-setting with `expectedVersion`; an unchanged request is a 200 no-op. */
  @Patch("products/:productId")
  async update(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<ProductResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(UpdateProductRequestSchema, body, "body");
    const { item } = await this.#services.updateProduct.execute(context, {
      productId,
      expectedVersion: input.expectedVersion,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.sku === undefined ? {} : { sku: input.sku }),
      ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
      ...(input.stockUnit === undefined ? {} : { stockUnit: input.stockUnit }),
      ...(input.trackInventory === undefined ? {} : { trackInventory: input.trackInventory }),
    });
    return toProductResponse(item);
  }

  @Post("products/:productId/archive")
  @HttpCode(HttpStatus.OK)
  async archive(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<ProductResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ArchiveProductRequestSchema, body, "body");
    const { item } = await this.#services.archiveProduct.execute(context, {
      productId,
      expectedVersion: input.expectedVersion,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return toProductResponse(item);
  }

  @Post("products/:productId/reactivate")
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<ProductResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ReactivateProductRequestSchema, body, "body");
    const { item } = await this.#services.reactivateProduct.execute(context, {
      productId,
      expectedVersion: input.expectedVersion,
    });
    return toProductResponse(item);
  }

  /** `product:price`. The price is integer minor units as a string, in the business currency. */
  @Put("products/:productId/price")
  async setPrice(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<ProductResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(SetSellingPriceRequestSchema, body, "body");
    const { item } = await this.#services.setSellingPrice.execute(context, {
      productId,
      expectedVersion: input.expectedVersion,
      price: input.price,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return toProductResponse(item);
  }

  @Get("products/:productId/prices")
  async prices(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<PriceHistoryResponse> {
    const { productId } = parseRequest(ProductPathSchema, params, "path");
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    return toPriceHistoryResponse(
      await this.#services.listProductPriceHistory.execute(context, { productId, ...page }),
    );
  }
}
