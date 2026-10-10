import {
  ADJUSTMENT_REASON_CODES,
  INVENTORY_ADJUSTMENT_KINDS,
  MAX_INVENTORY_DOCUMENT_LINES,
  MAX_STOCKTAKE_LINES,
  WRITE_OFF_REASON_CODES,
} from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

const UNIT_CODE_MAX_LENGTH = 16;
/** Digits of the quantity bound 10^15 (ADR-008 section 4.3): the threshold ceiling. */
const QUANTITY_MINOR_MAX_LENGTH = 16;

const lineCount = auditField.integer(1, MAX_INVENTORY_DOCUMENT_LINES);
const thresholdMinor = auditField.integerString({ maxLength: QUANTITY_MINOR_MAX_LENGTH, allowNegative: false });

export const inventoryOpeningRecorded = defineAuditAction({
  name: "inventory.opening_recorded",
  stream: "business",
  entityType: "inventory_opening_batch",
  payloadSchemaVersion: 1,
  fields: { lineCount },
});

export const inventoryReceived = defineAuditAction({
  name: "inventory.received",
  stream: "business",
  entityType: "goods_receipt",
  payloadSchemaVersion: 1,
  fields: { lineCount, referencePresent: auditField.boolean() },
});

/** The reversal reason is the audit record's reason. */
export const inventoryReceiptReversed = defineAuditAction({
  name: "inventory.receipt_reversed",
  stream: "business",
  entityType: "goods_receipt",
  payloadSchemaVersion: 1,
  fields: { lineCount },
});

/** The audit reason is the reason note when present, otherwise the reason code (plan decision D10). */
export const inventoryAdjusted = defineAuditAction({
  name: "inventory.adjusted",
  stream: "business",
  entityType: "inventory_adjustment",
  payloadSchemaVersion: 1,
  fields: { reasonCode: auditField.enumeration(ADJUSTMENT_REASON_CODES), lineCount },
});

/** The audit reason is the reason note when present, otherwise the reason code (plan decision D10). */
export const inventoryWrittenOff = defineAuditAction({
  name: "inventory.written_off",
  stream: "business",
  entityType: "inventory_adjustment",
  payloadSchemaVersion: 1,
  fields: { reasonCode: auditField.enumeration(WRITE_OFF_REASON_CODES), lineCount },
});

/** The reversal reason is the audit record's reason. */
export const inventoryAdjustmentReversed = defineAuditAction({
  name: "inventory.adjustment_reversed",
  stream: "business",
  entityType: "inventory_adjustment",
  payloadSchemaVersion: 1,
  fields: { kind: auditField.enumeration(INVENTORY_ADJUSTMENT_KINDS), lineCount },
});

/** `fromThresholdMinor` is absent when no threshold was configured. */
export const inventoryLowStockThresholdSet = defineAuditAction({
  name: "inventory.low_stock_threshold_set",
  stream: "business",
  entityType: "inventory_stock_threshold",
  payloadSchemaVersion: 1,
  fields: {
    variantId: auditField.id(),
    stockUnit: auditField.string(UNIT_CODE_MAX_LENGTH),
    fromThresholdMinor: auditField.optional(thresholdMinor),
    toThresholdMinor: thresholdMinor,
  },
});

export const inventoryLowStockThresholdCleared = defineAuditAction({
  name: "inventory.low_stock_threshold_cleared",
  stream: "business",
  entityType: "inventory_stock_threshold",
  payloadSchemaVersion: 1,
  fields: {
    variantId: auditField.id(),
    stockUnit: auditField.string(UNIT_CODE_MAX_LENGTH),
    fromThresholdMinor: thresholdMinor,
  },
});

const stocktakeLineCount = auditField.integer(0, MAX_STOCKTAKE_LINES);

/** Starting a stocktake records who opened it; there is nothing else to bound. */
export const inventoryStocktakeStarted = defineAuditAction({
  name: "inventory.stocktake_started",
  stream: "business",
  entityType: "stocktake",
  payloadSchemaVersion: 1,
  fields: {},
});

/** The optional cancellation reason is the audit record's reason. */
export const inventoryStocktakeCancelled = defineAuditAction({
  name: "inventory.stocktake_cancelled",
  stream: "business",
  entityType: "stocktake",
  payloadSchemaVersion: 1,
  fields: { countedLineCount: stocktakeLineCount },
});

/**
 * `correctionMovementCount + zeroVarianceCount = countedLineCount`. Per-line
 * quantities stay on the COUNT_CORRECTION movements and the stocktake lines.
 */
export const inventoryStocktakePosted = defineAuditAction({
  name: "inventory.stocktake_posted",
  stream: "business",
  entityType: "stocktake",
  payloadSchemaVersion: 1,
  fields: {
    countedLineCount: auditField.integer(1, MAX_STOCKTAKE_LINES),
    correctionMovementCount: stocktakeLineCount,
    zeroVarianceCount: stocktakeLineCount,
  },
});

/**
 * Inventory audit actions (ADR-008 section 16). Payloads are bounded and built
 * explicitly: no quantities or movement history go into document audits, because
 * the append-only movements carry the per-line before and after values. Counting
 * and removing stocktake lines is draft work and is not audited; starting,
 * cancelling and posting are.
 */
export const inventoryAuditActions = [
  inventoryOpeningRecorded,
  inventoryReceived,
  inventoryReceiptReversed,
  inventoryAdjusted,
  inventoryWrittenOff,
  inventoryAdjustmentReversed,
  inventoryLowStockThresholdSet,
  inventoryLowStockThresholdCleared,
  inventoryStocktakeStarted,
  inventoryStocktakeCancelled,
  inventoryStocktakePosted,
] as const;
