import {
  ADJUSTMENT_REASON_CODES,
  INVENTORY_ADJUSTMENT_KINDS,
  MAX_INVENTORY_DOCUMENT_LINES,
  MAX_STOCKTAKE_LINES,
  STOCK_VALUATION_KINDS,
  VALUATION_STATUSES,
  WRITE_OFF_REASON_CODES,
} from "@tali/domain";
import { defineAuditAction } from "../../audit/audit-action.js";
import { auditField } from "../../audit/audit-payload.js";

const UNIT_CODE_MAX_LENGTH = 16;
/** Digits of the quantity bound 10^15 (ADR-008 section 4.3): the threshold ceiling. */
const QUANTITY_MINOR_MAX_LENGTH = 16;

const lineCount = auditField.integer(1, MAX_INVENTORY_DOCUMENT_LINES);
const thresholdMinor = auditField.integerString({ maxLength: QUANTITY_MINOR_MAX_LENGTH, allowNegative: false });
const moneyMinor = auditField.integerString({ maxLength: 20, allowNegative: true });
const optionalJournal = auditField.optional(auditField.id());
const optionalValueDelta = auditField.optional(moneyMinor);
const optionalStatusAfter = auditField.optional(auditField.enumeration(VALUATION_STATUSES));
const valuationExtras = {
  journalEntryId: optionalJournal,
  valueDeltaMinor: optionalValueDelta,
  valuationStatusAfter: optionalStatusAfter,
} as const;

export const inventoryOpeningRecorded = defineAuditAction({
  name: "inventory.opening_recorded",
  stream: "business",
  entityType: "inventory_opening_batch",
  payloadSchemaVersion: 2,
  fields: { lineCount, ...valuationExtras },
});

export const inventoryReceived = defineAuditAction({
  name: "inventory.received",
  stream: "business",
  entityType: "goods_receipt",
  payloadSchemaVersion: 2,
  fields: { lineCount, referencePresent: auditField.boolean(), ...valuationExtras },
});

/** The reversal reason is the audit record's reason. */
export const inventoryReceiptReversed = defineAuditAction({
  name: "inventory.receipt_reversed",
  stream: "business",
  entityType: "goods_receipt",
  payloadSchemaVersion: 2,
  fields: { lineCount, ...valuationExtras },
});

/** The audit reason is the reason note when present, otherwise the reason code (plan decision D10). */
export const inventoryAdjusted = defineAuditAction({
  name: "inventory.adjusted",
  stream: "business",
  entityType: "inventory_adjustment",
  payloadSchemaVersion: 2,
  fields: { reasonCode: auditField.enumeration(ADJUSTMENT_REASON_CODES), lineCount, ...valuationExtras },
});

/** The audit reason is the reason note when present, otherwise the reason code (plan decision D10). */
export const inventoryWrittenOff = defineAuditAction({
  name: "inventory.written_off",
  stream: "business",
  entityType: "inventory_adjustment",
  payloadSchemaVersion: 2,
  fields: { reasonCode: auditField.enumeration(WRITE_OFF_REASON_CODES), lineCount, ...valuationExtras },
});

/** The reversal reason is the audit record's reason. */
export const inventoryAdjustmentReversed = defineAuditAction({
  name: "inventory.adjustment_reversed",
  stream: "business",
  entityType: "inventory_adjustment",
  payloadSchemaVersion: 2,
  fields: { kind: auditField.enumeration(INVENTORY_ADJUSTMENT_KINDS), lineCount, ...valuationExtras },
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
  payloadSchemaVersion: 2,
  fields: {
    countedLineCount: auditField.integer(1, MAX_STOCKTAKE_LINES),
    correctionMovementCount: stocktakeLineCount,
    zeroVarianceCount: stocktakeLineCount,
    ...valuationExtras,
  },
});

export const inventoryValuationRecorded = defineAuditAction({
  name: "inventory.valuation_recorded",
  stream: "business",
  entityType: "stock_valuation",
  payloadSchemaVersion: 2,
  fields: {
    valuationId: auditField.id(),
    kind: auditField.enumeration(STOCK_VALUATION_KINDS),
    variantId: auditField.id(),
    quantityMinor: auditField.integerString({ maxLength: QUANTITY_MINOR_MAX_LENGTH, allowNegative: false }),
    previousValueMinor: auditField.integerString({ maxLength: 20, allowNegative: true }),
    newValueMinor: auditField.integerString({ maxLength: 20, allowNegative: false }),
    journalEntryId: optionalJournal,
    triggerMovementId: auditField.optional(auditField.id()),
  },
});

/**
 * Inventory audit actions (ADR-008 section 16; ADR-009 section 27). Payloads
 * are bounded and built explicitly. Optional journal and value fields appear
 * only when a Build 3 S3 posting occurred.
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
  inventoryValuationRecorded,
] as const;
