import type {
  AccessibleBusiness,
  CreateBusinessResult,
  GetBusiness,
  GetCurrentUser,
  ListLocations,
  MemberListing,
  Page,
} from "@tali/application";
import {
  type BusinessResponse,
  BusinessResponseSchema,
  type CreateBusinessResponse,
  CreateBusinessResponseSchema,
  type CurrentUserResponse,
  CurrentUserResponseSchema,
  type LocationResponse,
  type LocationsResponse,
  LocationsResponseSchema,
  type MembersResponse,
  MembersResponseSchema,
  type MyBusinessesResponse,
  MyBusinessesResponseSchema,
} from "@tali/shared";

/**
 * Application results to wire DTOs. Each mapper names the fields it exposes
 * and parses the result with the strict shared response schema, so a storage
 * field (provider subject, membership version, timestamps, creator, audit or
 * idempotency data) can never be serialised by accident.
 */
type User = Awaited<ReturnType<GetCurrentUser["execute"]>>;
type Business = Awaited<ReturnType<GetBusiness["execute"]>>;
type Location = Awaited<ReturnType<ListLocations["execute"]>>["items"][number];

function business(value: Business): BusinessResponse {
  return { id: value.id, name: value.name, currencyCode: value.currencyCode, timeZone: value.timeZone };
}

function location(value: Location): LocationResponse {
  return { id: value.id, name: value.name, isDefault: value.isDefault, status: value.status };
}

export function toCurrentUserResponse(user: User): CurrentUserResponse {
  return CurrentUserResponseSchema.parse({ id: user.id, displayName: user.displayName });
}

export function toBusinessResponse(value: Business): BusinessResponse {
  return BusinessResponseSchema.parse(business(value));
}

export function toCreateBusinessResponse(result: CreateBusinessResult): CreateBusinessResponse {
  return CreateBusinessResponseSchema.parse({
    business: business(result.business),
    defaultLocation: location(result.location),
    membership: { id: result.membership.id, role: result.membership.role, status: result.membership.status },
  });
}

export function toMyBusinessesResponse(page: Page<AccessibleBusiness>): MyBusinessesResponse {
  return MyBusinessesResponseSchema.parse({
    items: page.items.map((entry) => ({
      business: business(entry.business),
      membership: { id: entry.membership.id, role: entry.membership.role },
    })),
    nextCursor: page.nextCursor,
  });
}

export function toLocationsResponse(page: Page<Location>): LocationsResponse {
  return LocationsResponseSchema.parse({ items: page.items.map(location), nextCursor: page.nextCursor });
}

export function toMembersResponse(page: Page<MemberListing>): MembersResponse {
  return MembersResponseSchema.parse({
    items: page.items.map((entry) => ({
      id: entry.membership.id,
      displayName: entry.displayName,
      role: entry.membership.role,
      status: entry.membership.status,
    })),
    nextCursor: page.nextCursor,
  });
}
