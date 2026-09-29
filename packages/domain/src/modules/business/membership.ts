import { DomainError } from "../../errors.js";
import { codePointLength, isWellFormedText } from "../../text.js";
import type { UserId } from "../identity/index.js";
import type { BusinessId, MembershipId } from "./ids.js";

/** The APPROVED role vocabulary (mvp-scope "Staff roles"; ADR-005 section 7). No Role entity exists. */
export const MEMBERSHIP_ROLES = ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

/** A user's membership of one business. The role is stored here, never on the User. */
export interface BusinessMembership {
  readonly id: MembershipId;
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  /** Incremented by every change; optimistic-concurrency token for storage. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

declare const reasonBrand: unique symbol;

/**
 * The reason required for role changes, suspension and reactivation
 * (ADR-005 section 9): non-blank, at most 500 characters (the ADR-004 audit
 * reason limit). Stored as given; no normalization contract applies.
 */
export type MembershipChangeReason = string & { readonly [reasonBrand]: true };

export const MEMBERSHIP_CHANGE_REASON_MAX_LENGTH = 500;

export function parseMembershipChangeReason(value: string): MembershipChangeReason {
  if (!isWellFormedText(value) || value.trim().length === 0) {
    throw new DomainError("INVALID_VALUE", "a reason is required", "reason");
  }
  if (codePointLength(value) > MEMBERSHIP_CHANGE_REASON_MAX_LENGTH) {
    throw new DomainError(
      "INVALID_VALUE",
      `reason must be at most ${MEMBERSHIP_CHANGE_REASON_MAX_LENGTH} characters`,
      "reason",
    );
  }
  return value as MembershipChangeReason;
}

function validInstant(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

/** The OWNER membership created with a new business for its creator. */
export function createFoundingOwnerMembership(props: {
  readonly id: MembershipId;
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly now: Date;
}): BusinessMembership {
  const now = validInstant(props.now, "now");
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    userId: props.userId,
    role: "OWNER",
    status: "ACTIVE",
    version: 1,
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
}

/** Validates a membership read from storage or built by controlled test setup. */
export function restoreMembership(props: {
  readonly id: MembershipId;
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly role: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): BusinessMembership {
  if (!isMembershipRole(props.role)) {
    throw new DomainError("INVALID_VALUE", "unknown membership role", "role");
  }
  if (!(MEMBERSHIP_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown membership status", "status");
  }
  if (!Number.isSafeInteger(props.version) || props.version < 1) {
    throw new DomainError("INVALID_VALUE", "version must be a positive integer", "version");
  }
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    userId: props.userId,
    role: props.role,
    status: props.status as MembershipStatus,
    version: props.version,
    createdAt: validInstant(props.createdAt, "createdAt"),
    updatedAt: validInstant(props.updatedAt, "updatedAt"),
  });
}

export function isMembershipActive(membership: BusinessMembership): boolean {
  return membership.status === "ACTIVE";
}

export function isActiveOwner(membership: BusinessMembership): boolean {
  return membership.status === "ACTIVE" && membership.role === "OWNER";
}

/** The number of ACTIVE OWNER memberships among memberships of one business. */
export function countActiveOwners(memberships: readonly BusinessMembership[]): number {
  return memberships.filter(isActiveOwner).length;
}

/** The result of a membership transition. `unchanged` is the successful no-op of ADR-004 section 7. */
export type MembershipTransition =
  | { readonly outcome: "unchanged"; readonly membership: BusinessMembership }
  | { readonly outcome: "changed"; readonly membership: BusinessMembership; readonly previous: BusinessMembership };

/**
 * Current state the owner invariant depends on. `activeOwnerCount` is the
 * number of ACTIVE OWNER memberships in the target's business, read under the
 * business row lock by the caller (ADR-005 section 10). This function does
 * not lock anything.
 */
export interface OwnerInvariantState {
  readonly activeOwnerCount: number;
}

function requireActingMembership(actor: BusinessMembership, target: BusinessMembership): void {
  if (actor.businessId !== target.businessId) {
    throw new DomainError("INVALID_VALUE", "the acting membership belongs to another business", "actor");
  }
  if (!isMembershipActive(actor)) {
    throw new DomainError("INVALID_TRANSITION", "a suspended membership cannot change memberships");
  }
}

/**
 * Every business keeps at least one ACTIVE OWNER (ADR-005 section 10). Rejects
 * any change that turns the target from an active owner into something else
 * when it is the last one.
 */
function requireOwnerRemains(before: BusinessMembership, after: BusinessMembership, state: OwnerInvariantState): void {
  const { activeOwnerCount } = state;
  if (!Number.isSafeInteger(activeOwnerCount) || activeOwnerCount < 0) {
    throw new DomainError("INVALID_VALUE", "activeOwnerCount must be a non-negative integer", "activeOwnerCount");
  }
  if (isActiveOwner(before) && activeOwnerCount < 1) {
    throw new DomainError("INVALID_VALUE", "activeOwnerCount does not include the target owner", "activeOwnerCount");
  }
  const remaining = activeOwnerCount - (isActiveOwner(before) ? 1 : 0) + (isActiveOwner(after) ? 1 : 0);
  if (remaining < 1) {
    throw new DomainError("LAST_ACTIVE_OWNER", "a business must keep at least one active owner");
  }
}

function changed(before: BusinessMembership, patch: Partial<BusinessMembership>, now: Date): MembershipTransition {
  const membership = Object.freeze({
    ...before,
    ...patch,
    version: before.version + 1,
    updatedAt: validInstant(now, "now"),
  });
  return { outcome: "changed", membership, previous: before };
}

/**
 * Changes an ACTIVE membership's role. Granting or removing OWNER requires an
 * ACTIVE OWNER actor, and the last active owner cannot be demoted. The
 * current role is a no-op.
 */
export function changeMembershipRole(props: {
  readonly target: BusinessMembership;
  readonly role: MembershipRole;
  readonly actor: BusinessMembership;
  readonly reason: MembershipChangeReason;
  readonly owners: OwnerInvariantState;
  readonly now: Date;
}): MembershipTransition {
  const { target, role, actor } = props;
  requireActingMembership(actor, target);
  if (target.role === role) return { outcome: "unchanged", membership: target };
  if (!isMembershipActive(target)) {
    throw new DomainError("INVALID_TRANSITION", "the role of a suspended membership cannot be changed");
  }
  if ((role === "OWNER" || target.role === "OWNER") && !isActiveOwner(actor)) {
    throw new DomainError("OWNER_REQUIRED", "only an owner can grant or remove the owner role");
  }
  const next = changed(target, { role }, props.now);
  requireOwnerRemains(target, next.membership, props.owners);
  return next;
}

/** ACTIVE to SUSPENDED. The last active owner cannot be suspended. Already SUSPENDED is a no-op. */
export function suspendMembership(props: {
  readonly target: BusinessMembership;
  readonly actor: BusinessMembership;
  readonly reason: MembershipChangeReason;
  readonly owners: OwnerInvariantState;
  readonly now: Date;
}): MembershipTransition {
  const { target, actor } = props;
  requireActingMembership(actor, target);
  if (target.status === "SUSPENDED") return { outcome: "unchanged", membership: target };
  const next = changed(target, { status: "SUSPENDED" }, props.now);
  requireOwnerRemains(target, next.membership, props.owners);
  return next;
}

/**
 * SUSPENDED to ACTIVE, by another ACTIVE membership of the same business. A
 * suspended membership cannot act, so it can never reactivate itself.
 * Already ACTIVE is a no-op.
 */
export function reactivateMembership(props: {
  readonly target: BusinessMembership;
  readonly actor: BusinessMembership;
  readonly reason: MembershipChangeReason;
  readonly now: Date;
}): MembershipTransition {
  const { target, actor } = props;
  requireActingMembership(actor, target);
  if (target.status === "ACTIVE") return { outcome: "unchanged", membership: target };
  return changed(target, { status: "ACTIVE" }, props.now);
}
