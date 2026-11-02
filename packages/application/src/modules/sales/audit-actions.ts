import { SALE_COST_STATUSES } from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

const minor = auditField.integerString({ maxLength: 40, allowNegative: false });

/** Bounded sale audit (ADR-011 section 22). No line or tender detail. */
export const saleRecorded = defineAuditAction({
  name: "sale.recorded",
  stream: "business",
  entityType: "sale",
  payloadSchemaVersion: 1,
  fields: {
    receiptNumber: auditField.string(40),
    lineCount: auditField.integer(1, 200),
    tenderCount: auditField.integer(1, 10),
    totalMinor: minor,
    discountTotalMinor: minor,
    taxTotalMinor: minor,
    costStatus: auditField.enumeration(SALE_COST_STATUSES),
    journalEntryId: auditField.id(),
  },
});

export const saleReversed = defineAuditAction({
  name: "sale.reversed",
  stream: "business",
  entityType: "sale",
  payloadSchemaVersion: 1,
  fields: {
    receiptNumber: auditField.string(40),
    reversalJournalEntryId: auditField.id(),
    tenderUnwoundConfirmed: auditField.boolean(),
  },
});

export const salesAuditActions = [saleRecorded, saleReversed] as const;
