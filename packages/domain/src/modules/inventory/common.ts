import { DomainError } from "../../errors.js";
import type { TimeZoneId } from "../../kernel/index.js";
import { BusinessDate } from "../../kernel/index.js";
import { normalizeBoundedName } from "../../text.js";
import type { MembershipId } from "../business/index.js";
import type { DeviceId } from "../device/index.js";

declare const inventoryNoteBrand: unique symbol;
declare const inventoryReasonNoteBrand: unique symbol;

/** Optional free text on an inventory document: 1 to 500 characters after trimming and NFC normalization. */
export type InventoryNote = string & { readonly [inventoryNoteBrand]: true };

/**
 * The reason recorded with an adjustment or write-off, or the required reason
 * for a reversal: 1 to 500 characters after trimming and NFC normalization.
 */
export type InventoryReasonNote = string & { readonly [inventoryReasonNoteBrand]: true };

export const INVENTORY_NOTE_MAX_LENGTH = 500;
export const INVENTORY_REASON_NOTE_MAX_LENGTH = 500;

/** A document carries 1 to 200 lines, one per variant (ADR-008 section 9). */
export const MAX_INVENTORY_DOCUMENT_LINES = 200;

export function parseInventoryNote(value: string): InventoryNote {
  return normalizeBoundedName(value, "note", INVENTORY_NOTE_MAX_LENGTH) as InventoryNote;
}

export function parseInventoryReasonNote(value: string, field = "reasonNote"): InventoryReasonNote {
  return normalizeBoundedName(value, field, INVENTORY_REASON_NOTE_MAX_LENGTH) as InventoryReasonNote;
}

export function validInstant(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_VALUE", `${field} must be a valid instant`, field);
  }
  return new Date(value.getTime());
}

/** Persisted versions start at 1. */
export function validPositiveVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError("INVALID_VALUE", `${field} must be a positive integer`, field);
  }
  return value;
}

/** Version 0 stands for "no row yet" (a missing balance or threshold). */
export function validNonNegativeVersion(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_VALUE", `${field} must be a non-negative integer`, field);
  }
  return value;
}

function validToken(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DomainError("INVALID_VALUE", `${field} is required`, field);
  }
  return value;
}

/**
 * Who recorded an inventory change, through which channel and when. The source
 * channel and correlation ID are validated by the application's business
 * context; the domain records them as given. `occurredAt` is server time in
 * Build 2 (no backdating), `businessDate` is its calendar date in the business
 * time zone, and `recordedAt` is when Tali stored it.
 */
export interface InventoryRecording {
  readonly actorMembershipId: MembershipId;
  readonly deviceId?: DeviceId;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
  readonly recordedAt: Date;
}

/** The recording metadata for a change made now; the business date comes from the business time zone. */
export function createInventoryRecording(props: {
  readonly actorMembershipId: MembershipId;
  readonly deviceId?: DeviceId;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly now: Date;
  readonly timeZone: TimeZoneId;
}): InventoryRecording {
  const now = validInstant(props.now, "now");
  return restoreInventoryRecording({
    actorMembershipId: props.actorMembershipId,
    ...(props.deviceId === undefined ? {} : { deviceId: props.deviceId }),
    sourceChannel: props.sourceChannel,
    correlationId: props.correlationId,
    occurredAt: now,
    businessDate: BusinessDate.fromInstant(now, props.timeZone),
    recordedAt: now,
  });
}

/** Validates recording metadata read from storage. A change is never recorded before it occurred. */
export function restoreInventoryRecording(props: {
  readonly actorMembershipId: MembershipId;
  readonly deviceId?: DeviceId | undefined;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
  readonly recordedAt: Date;
}): InventoryRecording {
  const occurredAt = validInstant(props.occurredAt, "occurredAt");
  const recordedAt = validInstant(props.recordedAt, "recordedAt");
  if (recordedAt.getTime() < occurredAt.getTime()) {
    throw new DomainError("INVALID_VALUE", "recordedAt cannot precede occurredAt", "recordedAt");
  }
  if (!(props.businessDate instanceof BusinessDate)) {
    throw new DomainError("INVALID_VALUE", "businessDate must be a BusinessDate", "businessDate");
  }
  return Object.freeze({
    actorMembershipId: props.actorMembershipId,
    ...(props.deviceId === undefined ? {} : { deviceId: props.deviceId }),
    sourceChannel: validToken(props.sourceChannel, "sourceChannel"),
    correlationId: validToken(props.correlationId, "correlationId"),
    occurredAt,
    businessDate: props.businessDate,
    recordedAt,
  });
}

/** Copies recording metadata onto a new record, so no two records share a Date instance. */
export function recordingFields(recording: InventoryRecording): InventoryRecording {
  return restoreInventoryRecording(recording);
}

export const INVENTORY_DOCUMENT_STATUSES = ["POSTED", "REVERSED"] as const;
export type InventoryDocumentStatus = (typeof INVENTORY_DOCUMENT_STATUSES)[number];

/** The lifecycle of a reversible document: POSTED, then optionally REVERSED with who, when and why. */
export interface DocumentReversalState {
  readonly status: InventoryDocumentStatus;
  readonly reversedAt?: Date;
  readonly reversedByMembershipId?: MembershipId;
  readonly reversalReason?: InventoryReasonNote;
}

/** Validates stored reversal columns: all absent when POSTED, all present when REVERSED. */
export function restoreReversalState(props: {
  readonly status: string;
  readonly reversedAt?: Date | undefined;
  readonly reversedByMembershipId?: MembershipId | undefined;
  readonly reversalReason?: string | undefined;
}): DocumentReversalState {
  if (!(INVENTORY_DOCUMENT_STATUSES as readonly string[]).includes(props.status)) {
    throw new DomainError("INVALID_VALUE", "unknown document status", "status");
  }
  const status = props.status as InventoryDocumentStatus;
  const set = [props.reversedAt, props.reversedByMembershipId, props.reversalReason].filter(
    (value) => value !== undefined,
  ).length;
  if (!((status === "POSTED" && set === 0) || (status === "REVERSED" && set === 3))) {
    throw new DomainError("INVALID_VALUE", "document reversal columns do not match its status", "status");
  }
  if (status === "POSTED") return { status };
  return {
    status,
    reversedAt: validInstant(props.reversedAt as Date, "reversedAt"),
    reversedByMembershipId: props.reversedByMembershipId as MembershipId,
    reversalReason: parseInventoryReasonNote(props.reversalReason as string, "reversalReason"),
  };
}

/**
 * POSTED to REVERSED. Reversing a REVERSED document is not a transition: the
 * application treats a repeat as a no-op before it reaches the domain.
 */
export function reversedState(props: {
  readonly current: DocumentReversalState;
  readonly reversedByMembershipId: MembershipId;
  readonly reason: InventoryReasonNote;
  readonly now: Date;
}): DocumentReversalState {
  if (props.current.status !== "POSTED") {
    throw new DomainError("INVALID_TRANSITION", "the document is already reversed", "status");
  }
  return {
    status: "REVERSED",
    reversedAt: validInstant(props.now, "now"),
    reversedByMembershipId: props.reversedByMembershipId,
    reversalReason: parseInventoryReasonNote(props.reason, "reason"),
  };
}

/** Deterministic, locale-independent ordering of canonical lowercase UUID strings (matches PostgreSQL uuid order). */
export function compareIds(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
