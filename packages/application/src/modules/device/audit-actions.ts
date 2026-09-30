import { DEVICE_PLATFORMS, DEVICE_STATUSES } from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

/** The label is a free-text human hint and stays out of audit payloads. */
export const deviceRegistered = defineAuditAction({
  name: "device.registered",
  stream: "business",
  entityType: "device",
  payloadSchemaVersion: 1,
  fields: {
    platform: auditField.enumeration(DEVICE_PLATFORMS),
    status: auditField.enumeration(DEVICE_STATUSES),
    registeredByMembershipId: auditField.id(),
  },
});

export const deviceRevoked = defineAuditAction({
  name: "device.revoked",
  stream: "business",
  entityType: "device",
  payloadSchemaVersion: 1,
  fields: {
    platform: auditField.enumeration(DEVICE_PLATFORMS),
    status: auditField.enumeration(DEVICE_STATUSES),
  },
});

export const deviceAuditActions = [deviceRegistered, deviceRevoked] as const;
