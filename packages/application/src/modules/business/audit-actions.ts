import {
  BUSINESS_STATUSES,
  INVITABLE_ROLES,
  INVITATION_STATUSES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
} from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

export const businessCreated = defineAuditAction({
  name: "business.created",
  stream: "business",
  entityType: "business",
  payloadSchemaVersion: 1,
  fields: {
    currencyCode: auditField.string(3),
    timeZone: auditField.string(64),
    status: auditField.enumeration(BUSINESS_STATUSES),
  },
});

/** Names are free text (they may name a person), so the payload records which field changed, not its values. */
export const businessRenamed = defineAuditAction({
  name: "business.renamed",
  stream: "business",
  entityType: "business",
  payloadSchemaVersion: 1,
  fields: {
    changedField: auditField.enumeration(["name"]),
  },
});

export const membershipCreated = defineAuditAction({
  name: "membership.created",
  stream: "business",
  entityType: "membership",
  payloadSchemaVersion: 1,
  fields: {
    userId: auditField.id(),
    role: auditField.enumeration(MEMBERSHIP_ROLES),
    status: auditField.enumeration(MEMBERSHIP_STATUSES),
  },
});

export const membershipRoleChanged = defineAuditAction({
  name: "membership.role_changed",
  stream: "business",
  entityType: "membership",
  payloadSchemaVersion: 1,
  fields: {
    userId: auditField.id(),
    previousRole: auditField.enumeration(MEMBERSHIP_ROLES),
    role: auditField.enumeration(MEMBERSHIP_ROLES),
  },
});

export const membershipSuspended = defineAuditAction({
  name: "membership.suspended",
  stream: "business",
  entityType: "membership",
  payloadSchemaVersion: 1,
  fields: {
    userId: auditField.id(),
    role: auditField.enumeration(MEMBERSHIP_ROLES),
    status: auditField.enumeration(MEMBERSHIP_STATUSES),
  },
});

export const membershipReactivated = defineAuditAction({
  name: "membership.reactivated",
  stream: "business",
  entityType: "membership",
  payloadSchemaVersion: 1,
  fields: {
    userId: auditField.id(),
    role: auditField.enumeration(MEMBERSHIP_ROLES),
    status: auditField.enumeration(MEMBERSHIP_STATUSES),
  },
});

export const invitationCreated = defineAuditAction({
  name: "invitation.created",
  stream: "business",
  entityType: "invitation",
  payloadSchemaVersion: 1,
  fields: {
    role: auditField.enumeration(INVITABLE_ROLES),
    status: auditField.enumeration(INVITATION_STATUSES),
    expiresAt: auditField.instant(),
  },
});

export const invitationRevoked = defineAuditAction({
  name: "invitation.revoked",
  stream: "business",
  entityType: "invitation",
  payloadSchemaVersion: 1,
  fields: {
    role: auditField.enumeration(INVITABLE_ROLES),
    status: auditField.enumeration(INVITATION_STATUSES),
  },
});

export const invitationAccepted = defineAuditAction({
  name: "invitation.accepted",
  stream: "business",
  entityType: "invitation",
  payloadSchemaVersion: 1,
  fields: {
    role: auditField.enumeration(INVITABLE_ROLES),
    status: auditField.enumeration(INVITATION_STATUSES),
    membershipId: auditField.id(),
  },
});

export const businessAuditActions = [
  businessCreated,
  businessRenamed,
  membershipCreated,
  membershipRoleChanged,
  membershipSuspended,
  membershipReactivated,
  invitationCreated,
  invitationRevoked,
  invitationAccepted,
] as const;
