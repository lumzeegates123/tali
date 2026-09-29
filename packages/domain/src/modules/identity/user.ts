import { DomainError } from "../../errors.js";
import { normalizeBoundedName } from "../../text.js";
import type { UserId } from "./ids.js";

export const USER_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

declare const displayNameBrand: unique symbol;

/** 1 to 100 characters after trimming and NFC normalization (ADR-005 section 4). */
export type DisplayName = string & { readonly [displayNameBrand]: true };

export const DISPLAY_NAME_MAX_LENGTH = 100;

export function parseDisplayName(value: string): DisplayName {
  return normalizeBoundedName(value, "displayName", DISPLAY_NAME_MAX_LENGTH) as DisplayName;
}

/**
 * A Tali user. It carries no business, role, membership, email or phone:
 * business access comes only from memberships (ADR-005 section 4).
 */
export interface User {
  readonly id: UserId;
  readonly displayName: DisplayName;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function validInstant(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

/** A newly registered user is ACTIVE. */
export function registerUser(props: {
  readonly id: UserId;
  readonly displayName: DisplayName;
  readonly now: Date;
}): User {
  const now = validInstant(props.now, "now");
  return Object.freeze({
    id: props.id,
    displayName: props.displayName,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
}

/**
 * Validates a user read from storage or built by controlled test setup. Build 1
 * has no disable operation (ADR-005 section 4); DISABLED users only arrive here.
 */
export function restoreUser(props: {
  readonly id: UserId;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): User {
  if (!(USER_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown user status", "status");
  }
  return Object.freeze({
    id: props.id,
    displayName: parseDisplayName(props.displayName),
    status: props.status as UserStatus,
    createdAt: validInstant(props.createdAt, "createdAt"),
    updatedAt: validInstant(props.updatedAt, "updatedAt"),
  });
}

export function isUserActive(user: User): boolean {
  return user.status === "ACTIVE";
}
