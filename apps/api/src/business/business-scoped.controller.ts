import { Body, Controller, Get, Inject, Patch, Query, UseGuards } from "@nestjs/common";
import type { BusinessContext } from "@tali/application";
import {
  type BusinessCurrencyResponse,
  type BusinessResponse,
  EmptyQuerySchema,
  type LocationsResponse,
  type MembersResponse,
  PageQuerySchema,
  UpdateBusinessNameRequestSchema,
} from "@tali/shared";
import { AuthenticationGuard } from "../auth/authentication.guard.js";
import { BusinessContextGuard } from "../auth/business-context.guard.js";
import { DeviceContextGuard } from "../auth/device-context.guard.js";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES } from "../composition/tokens.js";
import { ResolvedBusinessContext } from "../http/request-context.js";
import {
  toBusinessCurrencyResponse,
  toBusinessResponse,
  toLocationsResponse,
  toMembersResponse,
} from "../http/response-mappers.js";
import { parseRequest, toPageInput } from "../http/validation.js";

/** The path prefix of every business-scoped route (ADR-005 section 12). */
export const BUSINESS_SCOPED_PATH = "v1/businesses/:businessId";

/**
 * The guards of every business-scoped controller, in order: authenticate the
 * user, resolve the BusinessContext for the route's business, then verify
 * optional device headers against that business. The business is never taken
 * from anywhere else. Permissions are checked by the use cases.
 * `test/compat/business-route-guards.test.ts` fails if any route with a
 * `:businessId` parameter is served without exactly these guards.
 */
export const BUSINESS_SCOPED_GUARDS = [AuthenticationGuard, BusinessContextGuard, DeviceContextGuard] as const;

/** The business itself, its locations and its members. */
@Controller(BUSINESS_SCOPED_PATH)
@UseGuards(...BUSINESS_SCOPED_GUARDS)
export class BusinessScopedController {
  readonly #services: ApiServices;

  constructor(@Inject(API_SERVICES) services: ApiServices) {
    this.#services = services;
  }

  @Get()
  async get(@ResolvedBusinessContext() context: BusinessContext, @Query() query: unknown): Promise<BusinessResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    return toBusinessResponse(await this.#services.getBusiness.execute(context));
  }

  /** `business:update`: the name only. Setting the current name is a no-op (200, no audit record). */
  @Patch()
  async rename(
    @ResolvedBusinessContext() context: BusinessContext,
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<BusinessResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    const input = parseRequest(UpdateBusinessNameRequestSchema, body, "body");
    const { business } = await this.#services.updateBusinessName.execute(context, { name: input.name });
    return toBusinessResponse(business);
  }

  /** `business:read`: the business currency's code and minor-unit digits. */
  @Get("currency")
  async currency(
    @ResolvedBusinessContext() context: BusinessContext,
    @Query() query: unknown,
  ): Promise<BusinessCurrencyResponse> {
    parseRequest(EmptyQuerySchema, query, "query");
    return toBusinessCurrencyResponse(await this.#services.getBusinessCurrency.execute(context));
  }

  @Get("locations")
  async locations(
    @ResolvedBusinessContext() context: BusinessContext,
    @Query() query: unknown,
  ): Promise<LocationsResponse> {
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    return toLocationsResponse(await this.#services.listLocations.execute(context, page));
  }

  @Get("members")
  async members(
    @ResolvedBusinessContext() context: BusinessContext,
    @Query() query: unknown,
  ): Promise<MembersResponse> {
    const page = toPageInput(parseRequest(PageQuerySchema, query, "query"));
    return toMembersResponse(await this.#services.listMembers.execute(context, page));
  }
}
