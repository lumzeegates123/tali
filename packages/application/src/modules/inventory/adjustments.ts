import type {
  AdjustmentReason,
  AdjustmentReasonCode,
  InventoryAdjustment,
  InventoryAdjustmentKind,
  WriteOffReasonCode,
} from "@tali/domain";
import { createInventoryAdjustment, parseAdjustmentReason } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { canonicalEnum } from "../../idempotency/canonical-command.js";
import { inventoryPermissions } from "../identity/index.js";
import { inventoryAdjusted, inventoryWrittenOff } from "./audit-actions.js";
import type { AdjustmentSnapshot } from "./codecs.js";
import { adjustmentSnapshot, adjustmentSnapshotCodec } from "./codecs.js";
import type { AdjustmentLineInput, StockLineInput, StockLineSyntax } from "./inventory-common.js";
import { parseOptionalNote, parseStockLines } from "./inventory-common.js";
import type { InventoryAdjustmentRepository } from "./ports.js";
import type {
  PreparedInventoryCommand,
  StockDocumentDependencies,
  StockDocumentKind,
  StockDocumentOutcome,
  StockDocumentRequest,
} from "./stock-document.js";
import { prepareInventoryCommand, runStockDocument } from "./stock-document.js";

export const RECORD_ADJUSTMENT_OPERATION = "inventory.adjustment.record.v1";
export const RECORD_WRITE_OFF_OPERATION = "inventory.write_off.record.v1";

const ADJUSTMENT: StockDocumentKind<AdjustmentSnapshot> = {
  operation: RECORD_ADJUSTMENT_OPERATION,
  commandSchemaVersion: 1,
  resourceType: "inventory_adjustment",
  movementType: "ADJUSTMENT",
  archivedAllowed: true,
  codec: adjustmentSnapshotCodec,
};

const WRITE_OFF: StockDocumentKind<AdjustmentSnapshot> = {
  operation: RECORD_WRITE_OFF_OPERATION,
  commandSchemaVersion: 1,
  resourceType: "inventory_adjustment",
  movementType: "WRITE_OFF",
  archivedAllowed: true,
  codec: adjustmentSnapshotCodec,
};

export interface RecordAdjustmentInput {
  /** Each line has a direction and a positive magnitude (plan decision D3). */
  readonly lines: readonly AdjustmentLineInput[];
  readonly reasonCode: AdjustmentReasonCode;
  /** Required when the reason code is OTHER; at most 500 characters. */
  readonly reasonNote?: string;
  readonly note?: string;
  readonly idempotencyKey: string | undefined;
}

export interface RecordWriteOffInput {
  /** Positive magnitudes; each is recorded as a decrease. */
  readonly lines: readonly StockLineInput[];
  readonly reasonCode: WriteOffReasonCode;
  /** Required when the reason code is OTHER; at most 500 characters. */
  readonly reasonNote?: string;
  readonly note?: string;
  readonly idempotencyKey: string | undefined;
}

export type InventoryAdjustmentOutcome = StockDocumentOutcome<AdjustmentSnapshot>;

/**
 * `inventory:adjust` (OWNER, MANAGER). Keyed. Increases and decreases
 * stock with a reason from the ADJUSTMENT list. ARCHIVED products may be
 * adjusted so residual stock can be cleared; untracked products are a
 * CONFLICT; a decrease below zero is INSUFFICIENT_STOCK (ADR-008 section 10).
 */
export interface RecordAdjustment {
  execute(context: LocationBoundContext, input: RecordAdjustmentInput): Promise<InventoryAdjustmentOutcome>;
}

/**
 * `inventory:adjust` (OWNER, MANAGER). Keyed. Removes damaged, expired,
 * spoiled or lost stock with a reason from the WRITE_OFF list. ARCHIVED
 * products may be written off; a result below zero is INSUFFICIENT_STOCK.
 */
export interface RecordWriteOff {
  execute(context: LocationBoundContext, input: RecordWriteOffInput): Promise<InventoryAdjustmentOutcome>;
}

type AdjustmentDependencies = StockDocumentDependencies & {
  readonly adjustments: InventoryAdjustmentRepository;
  readonly audit: AuditRecorder;
};

function parseReason(kind: InventoryAdjustmentKind, reasonCode: unknown, reasonNote: unknown): AdjustmentReason {
  return withDomainRules(() =>
    parseAdjustmentReason({
      kind,
      reasonCode: reasonCode as string,
      reasonNote: reasonNote as string | undefined,
    }),
  );
}

function adjustmentRequest(
  dependencies: AdjustmentDependencies,
  prepared: PreparedInventoryCommand,
  kind: InventoryAdjustmentKind,
  lines: readonly StockLineSyntax[],
  reason: AdjustmentReason,
  note: string | undefined,
): StockDocumentRequest<InventoryAdjustment, AdjustmentSnapshot> {
  const parsedNote = parseOptionalNote(note);
  return {
    kind: kind === "ADJUSTMENT" ? ADJUSTMENT : WRITE_OFF,
    lines,
    fields: { reasonCode: canonicalEnum(reason.reasonCode), reasonNote: reason.reasonNote, note: parsedNote },
    reason,
    signed:
      kind === "ADJUSTMENT"
        ? (magnitude, line) => (line.direction === "DECREASE" ? magnitude.negate() : magnitude)
        : (magnitude) => magnitude.negate(),
    createHeader: (plan) =>
      createInventoryAdjustment({
        id: dependencies.ids.newId("InventoryAdjustment"),
        businessId: plan.businessId,
        locationId: plan.locationId,
        kind,
        reason,
        ...(parsedNote === undefined ? {} : { note: parsedNote }),
        recording: plan.recording,
      }),
    snapshot: adjustmentSnapshot,
    insertHeader: (scope, header) => dependencies.adjustments.insert(scope, header),
    audit: (scope, header, key, lineCount) => {
      const envelope = {
        ...businessAuditEnvelope(prepared.context, key),
        locationId: prepared.context.locationId,
        entityId: header.id,
        reason: header.reasonNote ?? header.reasonCode,
      };
      return header.kind === "ADJUSTMENT"
        ? dependencies.audit.recordBusinessEvent(scope, inventoryAdjusted, {
            ...envelope,
            payload: { reasonCode: header.reasonCode as AdjustmentReasonCode, lineCount },
          })
        : dependencies.audit.recordBusinessEvent(scope, inventoryWrittenOff, {
            ...envelope,
            payload: { reasonCode: header.reasonCode as WriteOffReasonCode, lineCount },
          });
    },
  };
}

export function createRecordAdjustment(dependencies: AdjustmentDependencies): RecordAdjustment {
  const permission = inventoryPermissions.permissions["inventory:adjust"];
  return {
    async execute(context, input) {
      const prepared = prepareInventoryCommand(context, permission, input.idempotencyKey);
      const lines = parseStockLines(input.lines, { directions: true });
      const reason = parseReason("ADJUSTMENT", input.reasonCode, input.reasonNote);
      return runStockDocument(
        dependencies,
        prepared,
        adjustmentRequest(dependencies, prepared, "ADJUSTMENT", lines, reason, input.note),
      );
    },
  };
}

export function createRecordWriteOff(dependencies: AdjustmentDependencies): RecordWriteOff {
  const permission = inventoryPermissions.permissions["inventory:adjust"];
  return {
    async execute(context, input) {
      const prepared = prepareInventoryCommand(context, permission, input.idempotencyKey);
      const lines = parseStockLines(input.lines, { directions: false });
      const reason = parseReason("WRITE_OFF", input.reasonCode, input.reasonNote);
      return runStockDocument(
        dependencies,
        prepared,
        adjustmentRequest(dependencies, prepared, "WRITE_OFF", lines, reason, input.note),
      );
    },
  };
}
