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
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  ArchiveCategoryRequestSchema,
  type CategoriesResponse,
  CategoryListQuerySchema,
  CategoryPathSchema,
  type CategoryResponse,
  CreateCategoryRequestSchema,
  EmptyQuerySchema,
  IdempotencyKeyHeaderSchema,
  UpdateCategoryRequestSchema,
} from "@tali/shared";
import type { Response } from "express";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import { IDEMPOTENT_REPLAYED_HEADER } from "../business/businesses.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { toCategoriesResponse, toCategoryResponse } from "../http/catalog-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest, toPageInput } from "../http/validation.js";

/**
 * Flat product categories of one business (ADR-008 section 3.3). Permissions
 * (`product:read`, `product:manage`) are checked by the use cases.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class CategoriesController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** `status` defaults to ACTIVE. */
  @Get("categories")
  async list(
    @ResolvedBusinessContext() context: BusinessContext,
    @Query() query: unknown,
  ): Promise<CategoriesResponse> {
    const input = parseRequest(CategoryListQuerySchema, query, "query");
    const page = await this.#services.listCategories.execute(context, {
      ...toPageInput(input),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    return toCategoriesResponse(page);
  }

  @Get("categories/:categoryId")
  async get(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<CategoryResponse> {
    const { categoryId } = parseRequest(CategoryPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    return toCategoryResponse(await this.#services.getCategory.execute(context, { categoryId }));
  }

  /** Requires `Idempotency-Key`; 201, and 201 with `Idempotent-Replayed: true` on replay. */
  @Post("categories")
  async create(
    @ResolvedBusinessContext() context: BusinessContext,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CategoryResponse> {
    const key = parseRequest(IdempotencyKeyHeaderSchema, idempotencyKey, "headers");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(CreateCategoryRequestSchema, body, "body");
    const outcome = await this.#services.createCategory.execute(context, { name: input.name, idempotencyKey: key });
    if (outcome.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    response.status(HttpStatus.CREATED);
    return toCategoryResponse(outcome.category);
  }

  @Patch("categories/:categoryId")
  async update(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<CategoryResponse> {
    const { categoryId } = parseRequest(CategoryPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(UpdateCategoryRequestSchema, body, "body");
    const { category } = await this.#services.updateCategory.execute(context, {
      categoryId,
      expectedVersion: input.expectedVersion,
      name: input.name,
    });
    return toCategoryResponse(category);
  }

  @Post("categories/:categoryId/archive")
  @HttpCode(HttpStatus.OK)
  async archive(
    @ResolvedBusinessContext() context: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<CategoryResponse> {
    const { categoryId } = parseRequest(CategoryPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ArchiveCategoryRequestSchema, body, "body");
    const { category } = await this.#services.archiveCategory.execute(context, {
      categoryId,
      expectedVersion: input.expectedVersion,
    });
    return toCategoryResponse(category);
  }
}
