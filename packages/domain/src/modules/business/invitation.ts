import { DomainError } from "../../errors.js";
import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";
import type { BusinessId, MembershipId } from "./ids.js";
import type { MembershipRole } from "./membership.js";

export type InvitationId = Id<"Invitation">;

export function parseInvitationId(value: string): InvitationId {
  return parseId("Invitation", value);
}

/** An invitation never grants OWNER (ADR-005 section 14); the database CHECK repeats this. */
export const INVITABLE_ROLES = [
  "MANAGER",
  "CASHIER",
  "STOCK_KEEPER",
  "ACCOUNTANT",
] as const satisfies readonly MembershipRole[];
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Stored states only. "Expired" is derived from `expiresAt` against the server clock and never stored. */
export const INVITATION_STATUSES = ["PENDING", "ACCEPTED", "REVOKED"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** ADR-005 section 14: default invitation lifetime. */
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

export function isInvitableRole(value: string): value is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(value);
}

export function parseInvitableRole(value: string): InvitableRole {
  if (!isInvitableRole(value)) {
    throw new DomainError("INVALID_VALUE", "role must be MANAGER, CASHIER, STOCK_KEEPER or ACCOUNTANT", "role");
  }
  return value;
}

/**
 * A bearer invitation to join one business with one role. The token is not
 * part of the entity: only the storage adapter holds its digest, and the
 * plaintext exists only in the creation response.
 */
export interface BusinessInvitation {
  readonly id: InvitationId;
  readonly businessId: BusinessId;
  readonly role: InvitableRole;
  readonly status: InvitationStatus;
  readonly expiresAt: Date;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
  readonly acceptedByMembershipId?: MembershipId;
  readonly acceptedAt?: Date;
  readonly revokedByMembershipId?: MembershipId;
  readonly revokedAt?: Date;
}

function validInstant(value: Date, field: string): Date {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

/** A new PENDING invitation that expires `ttlMs` after `now`. */
export function createInvitation(props: {
  readonly id: InvitationId;
  readonly businessId: BusinessId;
  readonly role: InvitableRole;
  readonly createdByMembershipId: MembershipId;
  readonly now: Date;
  readonly ttlMs?: number;
}): BusinessInvitation {
  const now = validInstant(props.now, "now");
  const ttlMs = props.ttlMs ?? INVITATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new DomainError("INVALID_VALUE", "ttlMs must be a positive integer", "ttlMs");
  }
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    role: parseInvitableRole(props.role),
    status: "PENDING",
    expiresAt: new Date(now.getTime() + ttlMs),
    createdByMembershipId: props.createdByMembershipId,
    createdAt: now,
  });
}

/** Validates an invitation read from storage; the state columns must agree with the status. */
export function restoreInvitation(props: {
  readonly id: InvitationId;
  readonly businessId: BusinessId;
  readonly role: string;
  readonly status: string;
  readonly expiresAt: Date;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
  readonly acceptedByMembershipId?: MembershipId | undefined;
  readonly acceptedAt?: Date | undefined;
  readonly revokedByMembershipId?: MembershipId | undefined;
  readonly revokedAt?: Date | undefined;
}): BusinessInvitation {
  if (!(INVITATION_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown invitation status", "status");
  }
  const status = props.status as InvitationStatus;
  const accepted = props.acceptedByMembershipId !== undefined && props.acceptedAt !== undefined;
  const acceptedNone = props.acceptedByMembershipId === undefined && props.acceptedAt === undefined;
  const revoked = props.revokedByMembershipId !== undefined && props.revokedAt !== undefined;
  const revokedNone = props.revokedByMembershipId === undefined && props.revokedAt === undefined;
  const consistent =
    (status === "PENDING" && acceptedNone && revokedNone) ||
    (status === "ACCEPTED" && accepted && revokedNone) ||
    (status === "REVOKED" && revoked && acceptedNone);
  if (!consistent) {
    throw new DomainError("INVALID_VALUE", "invitation state columns do not match its status", "status");
  }
  const createdAt = validInstant(props.createdAt, "createdAt");
  const expiresAt = validInstant(props.expiresAt, "expiresAt");
  if (expiresAt.getTime() <= createdAt.getTime()) {
    throw new DomainError("INVALID_VALUE", "expiresAt must be after createdAt", "expiresAt");
  }
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    role: parseInvitableRole(props.role),
    status,
    expiresAt,
    createdByMembershipId: props.createdByMembershipId,
    createdAt,
    ...(props.acceptedByMembershipId === undefined ? {} : { acceptedByMembershipId: props.acceptedByMembershipId }),
    ...(props.acceptedAt === undefined ? {} : { acceptedAt: validInstant(props.acceptedAt, "acceptedAt") }),
    ...(props.revokedByMembershipId === undefined ? {} : { revokedByMembershipId: props.revokedByMembershipId }),
    ...(props.revokedAt === undefined ? {} : { revokedAt: validInstant(props.revokedAt, "revokedAt") }),
  });
}

/** Expiry is derived from the server clock; the invitation stays PENDING in storage. */
export function isInvitationExpired(invitation: BusinessInvitation, now: Date): boolean {
  return validInstant(now, "now").getTime() >= invitation.expiresAt.getTime();
}

/** Usable for acceptance: PENDING and not expired at `now`. */
export function isInvitationOpen(invitation: BusinessInvitation, now: Date): boolean {
  return invitation.status === "PENDING" && !isInvitationExpired(invitation, now);
}

export type InvitationTransition =
  | { readonly outcome: "unchanged"; readonly invitation: BusinessInvitation }
  | { readonly outcome: "changed"; readonly invitation: BusinessInvitation; readonly previous: BusinessInvitation };

/**
 * PENDING (expired or not) to REVOKED. Already REVOKED is a no-op (ADR-004
 * section 7); an ACCEPTED invitation cannot be revoked.
 */
export function revokeInvitation(props: {
  readonly invitation: BusinessInvitation;
  readonly revokedByMembershipId: MembershipId;
  readonly now: Date;
}): InvitationTransition {
  const { invitation } = props;
  if (invitation.status === "REVOKED") return { outcome: "unchanged", invitation };
  if (invitation.status === "ACCEPTED") {
    throw new DomainError("INVALID_TRANSITION", "an accepted invitation cannot be revoked");
  }
  const now = validInstant(props.now, "now");
  return {
    outcome: "changed",
    previous: invitation,
    invitation: Object.freeze({
      ...invitation,
      status: "REVOKED",
      revokedByMembershipId: props.revokedByMembershipId,
      revokedAt: now,
    }),
  };
}

/** PENDING and unexpired to ACCEPTED, bound to the membership the acceptance created. */
export function acceptInvitation(props: {
  readonly invitation: BusinessInvitation;
  readonly acceptedByMembershipId: MembershipId;
  readonly now: Date;
}): { readonly invitation: BusinessInvitation; readonly previous: BusinessInvitation } {
  const { invitation } = props;
  if (!isInvitationOpen(invitation, props.now)) {
    throw new DomainError("INVALID_TRANSITION", "the invitation is not open for acceptance");
  }
  return {
    previous: invitation,
    invitation: Object.freeze({
      ...invitation,
      status: "ACCEPTED",
      acceptedByMembershipId: props.acceptedByMembershipId,
      acceptedAt: validInstant(props.now, "now"),
    }),
  };
}
