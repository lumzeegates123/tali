import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  ClearLowStockThresholdRequestSchema,
  EmptyQuerySchema,
  InventoryItemListQuerySchema,
  InventoryItemPathSchema,
  type InventoryItemResponse,
  type InventoryItemsResponse,
  type InventoryMovementsResponse,
  type LowStockThresholdResponse,
  PageQuerySchema,
  SetLowStockThresholdRequestSchema,
} from "@tali/shared";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import {
  toInventoryItemResponse,
  toInventoryItemsResponse,
  toInventoryMovementsResponse,
  toLowStockThresholdResponse,
} from "../http/inventory-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest, toPageInput } from "../http/validation.js";
import { bindDefaultLocation } from "./default-location.js";

/**
 * Stock items at the business's default location: balances, one item, its
 * movement history and its low-stock threshold (ADR-008 sections 7 and 15).
 * Reads need `inventory:read` (every role); thresholds need
 * `inventory:threshold`. The use cases check permissions and re-read the
 * acting membership for every mutation.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class InventoryItemsController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  /** Tracked ACTIVE items with or without stock, and ARCHIVED items still holding stock; `lowStock=true` filters. */
  @Get("inventory/balances")
  async list(
    @ResolvedBusinessContext() business: BusinessContext,
    @Query() query: unknown,
  ): Promise<InventoryItemsResponse> {
    const input = parseRequest(InventoryItemListQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    const page = await this.#services.listInventoryItems.execute(context, {
      ...toPageInput(input),
      ...(input.q === undefined ? {} : { q: input.q }),
      lowStockOnly: input.lowStock ?? false,
    });
    return toInventoryItemsResponse(page);
  }

  @Get("inventory/items/:variantId")
  async get(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<InventoryItemResponse> {
    const { variantId } = parseRequest(InventoryItemPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const context = await bindDefaultLocation(this.#services, business);
    return toInventoryItemResponse(await this.#services.getInventoryItem.execute(context, { variantId }));
  }

  /** Newest first. `after` is a movement ID from a previous page; any other cursor is VALIDATION_FAILED. */
  @Get("inventory/items/:variantId/movements")
  async movements(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<InventoryMovementsResponse> {
    const { variantId } = parseRequest(InventoryItemPathSchema, params, "path");
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    const context = await bindDefaultLocation(this.#services, business);
    return toInventoryMovementsResponse(
      await this.#services.listItemMovements.execute(context, { variantId, ...page }),
    );
  }

  /** State-setting with `expectedVersion` (0 when no threshold row exists). Not a movement. */
  @Put("inventory/items/:variantId/threshold")
  async setThreshold(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<LowStockThresholdResponse> {
    const { variantId } = parseRequest(InventoryItemPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(SetLowStockThresholdRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toLowStockThresholdResponse(
      await this.#services.setLowStockThreshold.execute(context, {
        variantId,
        expectedVersion: input.expectedVersion,
        threshold: input.threshold,
      }),
    );
  }

  /** Clearing an absent or cleared threshold is a 200 no-op. */
  @Post("inventory/items/:variantId/threshold/clear")
  @HttpCode(HttpStatus.OK)
  async clearThreshold(
    @ResolvedBusinessContext() business: BusinessContext,
    @Param() params: unknown,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<LowStockThresholdResponse> {
    const { variantId } = parseRequest(InventoryItemPathSchema, params, "path");
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(ClearLowStockThresholdRequestSchema, body, "body");
    const context = await bindDefaultLocation(this.#services, business);
    return toLowStockThresholdResponse(
      await this.#services.clearLowStockThreshold.execute(context, {
        variantId,
        expectedVersion: input.expectedVersion,
      }),
    );
  }
}
