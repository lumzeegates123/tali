import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

/**
 * Chart provisioning summary only (ADR-009 section 27 / Plan 005 S1). Never
 * dumps accounts, journal lines or repository entities.
 */
export const ledgerChartProvisioned = defineAuditAction({
  name: "ledger.chart_provisioned",
  stream: "business",
  entityType: "business",
  payloadSchemaVersion: 1,
  fields: {
    templateVersion: auditField.integer(1, 10_000),
    accountCount: auditField.integer(1, 10_000),
  },
});

export const ledgerAuditActions = [ledgerChartProvisioned] as const;
