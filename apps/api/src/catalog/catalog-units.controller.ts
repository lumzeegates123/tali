import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import { EmptyQuerySchema, type UnitsResponse } from "@tali/shared";
import { BUSINESS_SCOPED_GUARDS, BUSINESS_SCOPED_PATH } from "../business/business-scoped.controller.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { toUnitsResponse } from "../http/catalog-response-mappers.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import { parseRequest } from "../http/validation.js";

/**
 * The approved units of measure (global reference data; ADR-008 section 4.2),
 * served under the business so that reading them requires an active
 * membership with `product:read`, checked by the use case.
 */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class CatalogUnitsController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  @Get("catalog/units")
  async units(@ResolvedBusinessContext() context: BusinessContext, @Query() query: unknown): Promise<UnitsResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    return toUnitsResponse(await this.#services.listUnitsOfMeasure.execute(context));
  }
}
