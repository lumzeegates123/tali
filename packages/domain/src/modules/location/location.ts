import { DomainError } from "../../errors.js";
import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";
import { normalizeBoundedName } from "../../text.js";
import type { Business, BusinessId } from "../business/index.js";
import { BUSINESS_NAME_MAX_LENGTH } from "../business/index.js";

/** Brand kept as "Location" for the BusinessLocation entity (plan 003 section 0). */
export type LocationId = Id<"Location">;

export function parseLocationId(value: string): LocationId {
  return parseId("Location", value);
}

export const LOCATION_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

declare const locationNameBrand: unique symbol;

/**
 * Build 1 location names are only ever a snapshot of the business name, so
 * they follow the business-name bounds. A separate contract arrives with
 * location management.
 */
export type LocationName = string & { readonly [locationNameBrand]: true };

/**
 * A physical place of a business where stock and cash are held. The MVP has
 * exactly one ACTIVE default location per business (data-principles section 5).
 */
export interface BusinessLocation {
  readonly id: LocationId;
  readonly businessId: BusinessId;
  readonly name: LocationName;
  readonly isDefault: boolean;
  readonly status: LocationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function validInstant(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

/**
 * The ACTIVE default location created with a business. Its name is a
 * snapshot of the business name at creation; renaming the business later
 * does not rename it (ADR-005 section 6).
 */
export function createDefaultLocation(props: {
  readonly id: LocationId;
  readonly business: Business;
  readonly now: Date;
}): BusinessLocation {
  const now = validInstant(props.now, "now");
  return Object.freeze({
    id: props.id,
    businessId: props.business.id,
    name: props.business.name as string as LocationName,
    isDefault: true,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
}

/** Validates a location read from storage or built by controlled test setup. */
export function restoreLocation(props: {
  readonly id: LocationId;
  readonly businessId: BusinessId;
  readonly name: string;
  readonly isDefault: boolean;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): BusinessLocation {
  if (!(LOCATION_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown location status", "status");
  }
  if (props.isDefault && props.status !== "ACTIVE") {
    throw new DomainError("INVALID_VALUE", "a default location must be ACTIVE", "status");
  }
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    name: normalizeBoundedName(props.name, "name", BUSINESS_NAME_MAX_LENGTH) as LocationName,
    isDefault: props.isDefault,
    status: props.status as LocationStatus,
    createdAt: validInstant(props.createdAt, "createdAt"),
    updatedAt: validInstant(props.updatedAt, "updatedAt"),
  });
}
