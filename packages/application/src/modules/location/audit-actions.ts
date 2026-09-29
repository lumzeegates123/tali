import { LOCATION_STATUSES } from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

export const locationCreated = defineAuditAction({
  name: "location.created",
  stream: "business",
  entityType: "location",
  payloadSchemaVersion: 1,
  fields: { isDefault: auditField.boolean(), status: auditField.enumeration(LOCATION_STATUSES) },
});

export const locationAuditActions = [locationCreated] as const;
