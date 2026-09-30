import type {
  AcceptInvitationResult,
  AccessibleBusiness,
  CreateBusinessResult,
  CreateInvitationOutcome,
  GetBusiness,
  GetCurrentUser,
  ListLocations,
  MemberListing,
  Page,
  RegisterDeviceOutcome,
} from "@tali/application";
import {
  type AcceptInvitationResponse,
  AcceptInvitationResponseSchema,
  type BusinessResponse,
  BusinessResponseSchema,
  type CreateInvitationResponse,
  CreateInvitationResponseSchema,
  type DeviceResponse,
  type DevicesResponse,
  DevicesResponseSchema,
  type InvitationResponse,
  type MemberChangeResponse,
  MemberChangeResponseSchema,
  type RegisterDeviceResponse,
  RegisterDeviceResponseSchema,
  type RevokeDeviceResponse,
  RevokeDeviceResponseSchema,
  type RevokeInvitationResponse,
  RevokeInvitationResponseSchema,
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
type BusinessInvitation = CreateInvitationOutcome["invitation"];
type BusinessMembership = AcceptInvitationResult["membership"];
type Device = RegisterDeviceOutcome["device"];

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

function invitation(value: BusinessInvitation): InvitationResponse {
  return { id: value.id, role: value.role, status: value.status, expiresAt: value.expiresAt.toISOString() };
}

function membershipSummary(value: BusinessMembership) {
  return { id: value.id, role: value.role, status: value.status };
}

function device(value: Device): DeviceResponse {
  return { id: value.id, platform: value.platform, label: value.label, status: value.status };
}

/** The token is added only to the original response; a replay says `tokenAvailable: false` (ADR-004 section 12). */
export function toCreateInvitationResponse(outcome: CreateInvitationOutcome): CreateInvitationResponse {
  return CreateInvitationResponseSchema.parse(
    outcome.replayed
      ? { invitation: invitation(outcome.invitation), tokenAvailable: false }
      : { invitation: invitation(outcome.invitation), tokenAvailable: true, token: outcome.token },
  );
}

export function toRevokeInvitationResponse(value: BusinessInvitation): RevokeInvitationResponse {
  return RevokeInvitationResponseSchema.parse({ invitation: invitation(value) });
}

export function toAcceptInvitationResponse(result: AcceptInvitationResult): AcceptInvitationResponse {
  return AcceptInvitationResponseSchema.parse({
    business: business(result.business),
    membership: membershipSummary(result.membership),
  });
}

export function toMemberChangeResponse(value: BusinessMembership): MemberChangeResponse {
  return MemberChangeResponseSchema.parse({ membership: membershipSummary(value) });
}

/** The credential is added only to the original response; a replay says `credentialAvailable: false`. */
export function toRegisterDeviceResponse(outcome: RegisterDeviceOutcome): RegisterDeviceResponse {
  return RegisterDeviceResponseSchema.parse(
    outcome.replayed
      ? { device: device(outcome.device), credentialAvailable: false }
      : { device: device(outcome.device), credentialAvailable: true, credential: outcome.credential },
  );
}

export function toDevicesResponse(page: Page<Device>): DevicesResponse {
  return DevicesResponseSchema.parse({ items: page.items.map(device), nextCursor: page.nextCursor });
}

export function toRevokeDeviceResponse(value: Device): RevokeDeviceResponse {
  return RevokeDeviceResponseSchema.parse({ device: device(value) });
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
