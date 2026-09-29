import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/index.js";
import { isCurrencyCode } from "../../kernel/index.js";
import { normalizeBoundedName } from "../../text.js";
import type { UserId } from "../identity/index.js";
import type { BusinessId } from "./ids.js";
import type { BusinessTimeZoneId } from "./time-zone.js";
import { isCanonicalBusinessTimeZone } from "./time-zone.js";

export const BUSINESS_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

declare const businessNameBrand: unique symbol;

/** 1 to 120 characters after trimming and NFC normalization (ADR-005 section 5). */
export type BusinessName = string & { readonly [businessNameBrand]: true };

export const BUSINESS_NAME_MAX_LENGTH = 120;

export function parseBusinessName(value: string): BusinessName {
  return normalizeBoundedName(value, "name", BUSINESS_NAME_MAX_LENGTH) as BusinessName;
}

/**
 * A business (the tenant). Currency and time zone are set at creation and
 * Build 1 has no operation that changes them (ADR-005 section 5). The currency
 * is whatever approved ISO 4217 code the business was created with; no
 * currency is special-cased here.
 */
export interface Business {
  readonly id: BusinessId;
  readonly name: BusinessName;
  readonly currencyCode: CurrencyCode;
  readonly timeZone: BusinessTimeZoneId;
  readonly status: BusinessStatus;
  readonly createdByUserId: UserId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function validInstant(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

/** A newly created business is ACTIVE. */
export function foundBusiness(props: {
  readonly id: BusinessId;
  readonly name: BusinessName;
  readonly currencyCode: CurrencyCode;
  readonly timeZone: BusinessTimeZoneId;
  readonly createdByUserId: UserId;
  readonly now: Date;
}): Business {
  const now = validInstant(props.now, "now");
  return Object.freeze({
    id: props.id,
    name: props.name,
    currencyCode: props.currencyCode,
    timeZone: props.timeZone,
    status: "ACTIVE",
    createdByUserId: props.createdByUserId,
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
}

/**
 * Validates a business read from storage or built by controlled test setup.
 * Build 1 has no suspension operation; SUSPENDED businesses only arrive here.
 */
export function restoreBusiness(props: {
  readonly id: BusinessId;
  readonly name: string;
  readonly currencyCode: string;
  readonly timeZone: string;
  readonly status: string;
  readonly createdByUserId: UserId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): Business {
  if (!(BUSINESS_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown business status", "status");
  }
  if (!isCurrencyCode(props.currencyCode)) {
    throw new DomainError("INVALID_VALUE", "currencyCode must be an ISO 4217 code", "currencyCode");
  }
  if (!isCanonicalBusinessTimeZone(props.timeZone)) {
    throw new DomainError("INVALID_VALUE", "timeZone must be a canonical IANA zone", "timeZone");
  }
  return Object.freeze({
    id: props.id,
    name: parseBusinessName(props.name),
    currencyCode: props.currencyCode,
    timeZone: props.timeZone,
    status: props.status as BusinessStatus,
    createdByUserId: props.createdByUserId,
    createdAt: validInstant(props.createdAt, "createdAt"),
    updatedAt: validInstant(props.updatedAt, "updatedAt"),
  });
}

export function isBusinessActive(business: Business): boolean {
  return business.status === "ACTIVE";
}

/**
 * Sets the business name. Setting the current name is a no-op (ADR-004
 * section 7). Locations are not renamed: their names are independent.
 */
export function renameBusiness(
  business: Business,
  name: BusinessName,
  now: Date,
): { readonly changed: boolean; readonly business: Business } {
  if (business.name === name) return { changed: false, business };
  return {
    changed: true,
    business: Object.freeze({ ...business, name, updatedAt: validInstant(now, "now") }),
  };
}
