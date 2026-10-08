import { createOpeningBatch } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { inventoryPermissions } from "../identity/index.js";
import { inventoryOpeningRecorded } from "./audit-actions.js";
import type { OpeningBatchSnapshot } from "./codecs.js";
import { openingBatchSnapshot, openingBatchSnapshotCodec } from "./codecs.js";
import type { StockLineInput } from "./inventory-common.js";
import { parseOptionalNote, parseStockLines } from "./inventory-common.js";
import type { OpeningBatchRepository } from "./ports.js";
import type { StockDocumentDependencies, StockDocumentKind, StockDocumentOutcome } from "./stock-document.js";
import { prepareInventoryCommand, runStockDocument } from "./stock-document.js";

export const RECORD_OPENING_STOCK_OPERATION = "inventory.opening_batch.record.v1";

const OPENING_STOCK: StockDocumentKind<OpeningBatchSnapshot> = {
  operation: RECORD_OPENING_STOCK_OPERATION,
  commandSchemaVersion: 1,
  resourceType: "inventory_opening_batch",
  movementType: "OPENING",
  archivedAllowed: false,
  codec: openingBatchSnapshotCodec,
};

export interface RecordOpeningStockInput {
  readonly lines: readonly StockLineInput[];
  readonly note?: string;
  readonly idempotencyKey: string | undefined;
}

export type RecordOpeningStockOutcome = StockDocumentOutcome<OpeningBatchSnapshot>;

/**
 * `inventory:opening` (OWNER, MANAGER). Keyed. Records the first stock of
 * 1 to 200 ACTIVE, tracked products at the context's location, all or
 * nothing. Every line is positive, and each stock item must have no movement
 * yet (balance version 0), otherwise CONFLICT. Opening stock is never
 * reversed: a mistake is corrected with an adjustment (ADR-008 section 11).
 */
export interface RecordOpeningStock {
  execute(context: LocationBoundContext, input: RecordOpeningStockInput): Promise<RecordOpeningStockOutcome>;
}

export function createRecordOpeningStock(
  dependencies: StockDocumentDependencies & {
    readonly openings: OpeningBatchRepository;
    readonly audit: AuditRecorder;
  },
): RecordOpeningStock {
  const permission = inventoryPermissions.permissions["inventory:opening"];
  return {
    async execute(context, input) {
      const prepared = prepareInventoryCommand(context, permission, input.idempotencyKey);
      const lines = parseStockLines(input.lines, { directions: false });
      const note = parseOptionalNote(input.note);
      return runStockDocument(dependencies, prepared, {
        kind: OPENING_STOCK,
        lines,
        fields: { note },
        signed: (magnitude) => magnitude,
        createHeader: (plan) =>
          createOpeningBatch({
            id: dependencies.ids.newId("OpeningBatch"),
            businessId: plan.businessId,
            locationId: plan.locationId,
            ...(note === undefined ? {} : { note }),
            recording: plan.recording,
          }),
        snapshot: openingBatchSnapshot,
        insertHeader: (scope, header) => dependencies.openings.insert(scope, header),
        audit: (scope, header, key, lineCount) =>
          dependencies.audit.recordBusinessEvent(scope, inventoryOpeningRecorded, {
            ...businessAuditEnvelope(prepared.context, key),
            locationId: prepared.context.locationId,
            entityId: header.id,
            payload: { lineCount },
          }),
      });
    },
  };
}
