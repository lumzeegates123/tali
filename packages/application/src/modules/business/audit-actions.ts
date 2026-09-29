import { BUSINESS_STATUSES, MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES } from "@tali/domain";
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

export const businessAuditActions = [businessCreated, membershipCreated] as const;
