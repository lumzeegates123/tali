import { EXTERNAL_IDENTITY_PROVIDERS } from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

/** Platform events: they concern a user's platform identity and carry no business (ADR-004 section 8.1). */
export const userRegistered = defineAuditAction({
  name: "user.registered",
  stream: "platform",
  entityType: "user",
  payloadSchemaVersion: 1,
  fields: { status: auditField.enumeration(["ACTIVE"]) },
});

/** Never includes the provider subject, tokens or claims. */
export const identityLinked = defineAuditAction({
  name: "identity.linked",
  stream: "platform",
  entityType: "external_identity",
  payloadSchemaVersion: 1,
  fields: { userId: auditField.id(), provider: auditField.enumeration(EXTERNAL_IDENTITY_PROVIDERS) },
});

export const identityAuditActions = [userRegistered, identityLinked] as const;
