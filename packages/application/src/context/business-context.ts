import type { CurrencyCode, Id, TimeZoneId } from "@tali/domain";
import type { Permission, PermissionSet } from "../authorization/permissions.js";
import { requirePermission } from "../authorization/permissions.js";
import { LocationRequiredError, ValidationError } from "../errors/application-error.js";

export type BusinessId = Id<"Business">;
export type LocationId = Id<"Location">;
export type UserId = Id<"User">;
export type MembershipId = Id<"Membership">;
export type DeviceId = Id<"Device">;

declare const correlationIdBrand: unique symbol;

/** Traces one request, job or event across processes. Never an authorization input. */
export type CorrelationId = string & { readonly [correlationIdBrand]: true };

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseCorrelationId(value: string): CorrelationId {
  if (!CORRELATION_ID_PATTERN.test(value)) {
    throw new ValidationError("invalid correlation id");
  }
  return value as CorrelationId;
}

/** A person acting through their membership of the business. */
export interface UserActor {
  readonly type: "user";
  readonly userId: UserId;
  readonly membershipId: MembershipId;
}

/** A named background process acting on the business's behalf (e.g. a scheduled job). */
export interface SystemActor {
  readonly type: "system";
  readonly process: string;
}

/** An external provider whose authenticated event is being processed. */
export interface IntegrationActor {
  readonly type: "integration";
  readonly provider: string;
}

export type Actor = UserActor | SystemActor | IntegrationActor;

export type SourceChannel =
  "web" | "mobile" | "whatsapp" | "api" | "webhook" | "ai_assistant" | "offline_sync" | "system";

/**
 * Tenant context, resolved server-side once per request, job or event from
 * Tali's database (never from client input or identity-provider claims alone)
 * and passed explicitly to every use case.
 */
export interface BusinessContext {
  readonly businessId: BusinessId;
  readonly locationId?: LocationId;
  readonly actor: Actor;
  readonly permissions: PermissionSet;
  readonly deviceId?: DeviceId;
  readonly sourceChannel: SourceChannel;
  readonly correlationId: CorrelationId;
  readonly currency: CurrencyCode;
  readonly timeZone: TimeZoneId;
}

/**
 * Context for location-bound use cases (sales, inventory, receiving, cash).
 * Default-location resolution happens before the use case is invoked.
 */
export interface LocationBoundContext extends BusinessContext {
  readonly locationId: LocationId;
}

export function isLocationBound(context: BusinessContext): context is LocationBoundContext {
  return context.locationId !== undefined;
}

export function requireLocationBound(context: BusinessContext): LocationBoundContext {
  if (!isLocationBound(context)) {
    throw new LocationRequiredError();
  }
  return context;
}

export function requireContextPermission(context: BusinessContext, permission: Permission): void {
  requirePermission(context.permissions, permission);
}
