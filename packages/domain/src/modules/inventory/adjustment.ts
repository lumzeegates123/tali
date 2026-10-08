import { DomainError } from "../../errors.js";
import type { BusinessId, MembershipId } from "../business/index.js";
import type { LocationId } from "../location/index.js";
import type { DocumentReversalState, InventoryNote, InventoryReasonNote, InventoryRecording } from "./common.js";
import {
  parseInventoryNote,
  parseInventoryReasonNote,
  recordingFields,
  restoreInventoryRecording,
  restoreReversalState,
  reversedState,
} from "./common.js";
import type { InventoryAdjustmentId } from "./ids.js";

/** An adjustment document is either a two-way ADJUSTMENT or a decrease-only WRITE_OFF (ADR-008 section 11). */
export const INVENTORY_ADJUSTMENT_KINDS = ["ADJUSTMENT", "WRITE_OFF"] as const;
export type InventoryAdjustmentKind = (typeof INVENTORY_ADJUSTMENT_KINDS)[number];

export const ADJUSTMENT_REASON_CODES = ["FOUND_STOCK", "DATA_ENTRY_CORRECTION", "OTHER"] as const;
export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];

export const WRITE_OFF_REASON_CODES = ["DAMAGED", "EXPIRED", "SPOILED", "THEFT_OR_LOSS", "OTHER"] as const;
export type WriteOffReasonCode = (typeof WRITE_OFF_REASON_CODES)[number];

export type InventoryReasonCode = AdjustmentReasonCode | WriteOffReasonCode;

/** The closed reason-code list for a kind. */
export function reasonCodesFor(kind: InventoryAdjustmentKind): readonly InventoryReasonCode[] {
  return kind === "ADJUSTMENT" ? ADJUSTMENT_REASON_CODES : WRITE_OFF_REASON_CODES;
}

export function parseInventoryAdjustmentKind(value: string): InventoryAdjustmentKind {
  if (!(INVENTORY_ADJUSTMENT_KINDS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown adjustment kind", "kind");
  }
  return value as InventoryAdjustmentKind;
}

/** Why stock was adjusted or written off. OTHER always needs a note. */
export interface AdjustmentReason {
  readonly reasonCode: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
}

/** Validates a reason against its kind's closed list; OTHER requires a non-blank note of at most 500 characters. */
export function parseAdjustmentReason(props: {
  readonly kind: InventoryAdjustmentKind;
  readonly reasonCode: string;
  readonly reasonNote?: string | undefined;
}): AdjustmentReason {
  const kind = parseInventoryAdjustmentKind(props.kind);
  if (!(reasonCodesFor(kind) as readonly string[]).includes(props.reasonCode)) {
    throw new DomainError("INVALID_VALUE", `reasonCode is not a valid ${kind} reason`, "reasonCode");
  }
  const reasonCode = props.reasonCode as InventoryReasonCode;
  const reasonNote = props.reasonNote === undefined ? undefined : parseInventoryReasonNote(props.reasonNote);
  if (reasonCode === "OTHER" && reasonNote === undefined) {
    throw new DomainError("INVALID_VALUE", "reasonNote is required when the reason is OTHER", "reasonNote");
  }
  return Object.freeze({ reasonCode, ...(reasonNote === undefined ? {} : { reasonNote }) });
}

/**
 * An adjustment or write-off document header. Its lines are the movements
 * themselves (ADR-008 section 8). It is never edited: a mistake is reversed,
 * which records reversal movements and sets the reversal columns.
 */
export interface InventoryAdjustment extends InventoryRecording, DocumentReversalState {
  readonly id: InventoryAdjustmentId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly kind: InventoryAdjustmentKind;
  readonly reasonCode: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
  readonly note?: InventoryNote;
}

export function createInventoryAdjustment(props: {
  readonly id: InventoryAdjustmentId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly kind: InventoryAdjustmentKind;
  readonly reason: AdjustmentReason;
  readonly note?: InventoryNote;
  readonly recording: InventoryRecording;
}): InventoryAdjustment {
  const reason = parseAdjustmentReason({
    kind: props.kind,
    reasonCode: props.reason.reasonCode,
    reasonNote: props.reason.reasonNote,
  });
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    kind: props.kind,
    ...reason,
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    status: "POSTED",
    ...recordingFields(props.recording),
  });
}

export function restoreInventoryAdjustment(props: {
  readonly id: InventoryAdjustmentId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly kind: string;
  readonly reasonCode: string;
  readonly reasonNote?: string | undefined;
  readonly note?: string | undefined;
  readonly status: string;
  readonly reversedAt?: Date | undefined;
  readonly reversedByMembershipId?: MembershipId | undefined;
  readonly reversalReason?: string | undefined;
  readonly actorMembershipId: MembershipId;
  readonly deviceId?: InventoryRecording["deviceId"] | undefined;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: InventoryRecording["businessDate"];
  readonly recordedAt: Date;
}): InventoryAdjustment {
  const kind = parseInventoryAdjustmentKind(props.kind);
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    kind,
    ...parseAdjustmentReason({ kind, reasonCode: props.reasonCode, reasonNote: props.reasonNote }),
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    ...restoreReversalState(props),
    ...restoreInventoryRecording(props),
  });
}

/** POSTED to REVERSED with the required reason. Already REVERSED is INVALID_TRANSITION here; the use case no-ops first. */
export function reverseInventoryAdjustment(props: {
  readonly adjustment: InventoryAdjustment;
  readonly reversedByMembershipId: MembershipId;
  readonly reason: InventoryReasonNote;
  readonly now: Date;
}): InventoryAdjustment {
  return Object.freeze({
    ...props.adjustment,
    ...reversedState({
      current: props.adjustment,
      reversedByMembershipId: props.reversedByMembershipId,
      reason: props.reason,
      now: props.now,
    }),
  });
}
