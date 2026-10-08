import type { InventoryRecording } from "@tali/domain";
import { BusinessDate, parseDeviceId, parseMembershipId } from "@tali/domain";

/**
 * A business date is a calendar date (PostgreSQL DATE). Prisma carries it as
 * a Date at UTC midnight, so it is written and read in UTC and never through
 * the server's local time zone.
 */
export function toDateColumn(date: BusinessDate): Date {
  return new Date(`${date.toString()}T00:00:00.000Z`);
}

export function fromDateColumn(value: Date): BusinessDate {
  return BusinessDate.parse(value.toISOString().slice(0, 10));
}

/** The recording columns every inventory table shares. */
export interface RecordingColumns {
  readonly actorMembershipId: string;
  readonly deviceId: string | null;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: Date;
  readonly recordedAt: Date;
}

export function recordingColumns(recording: InventoryRecording): RecordingColumns {
  return {
    actorMembershipId: recording.actorMembershipId,
    deviceId: recording.deviceId ?? null,
    sourceChannel: recording.sourceChannel,
    correlationId: recording.correlationId,
    occurredAt: recording.occurredAt,
    businessDate: toDateColumn(recording.businessDate),
    recordedAt: recording.recordedAt,
  };
}

export function recordingProps(row: RecordingColumns) {
  return {
    actorMembershipId: parseMembershipId(row.actorMembershipId),
    ...(row.deviceId === null ? {} : { deviceId: parseDeviceId(row.deviceId) }),
    sourceChannel: row.sourceChannel,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
    businessDate: fromDateColumn(row.businessDate),
    recordedAt: row.recordedAt,
  };
}

/** The reversal columns of a reversible document header, written only on POSTED to REVERSED. */
export function reversalColumns(document: {
  readonly status: string;
  readonly reversedAt?: Date;
  readonly reversedByMembershipId?: string;
  readonly reversalReason?: string;
}) {
  return {
    status: document.status,
    reversedAt: document.reversedAt ?? null,
    reversedByMembershipId: document.reversedByMembershipId ?? null,
    reversalReason: document.reversalReason ?? null,
  };
}

export function reversalProps(row: {
  readonly status: string;
  readonly reversedAt: Date | null;
  readonly reversedByMembershipId: string | null;
  readonly reversalReason: string | null;
}) {
  return {
    status: row.status,
    ...(row.reversedAt === null ? {} : { reversedAt: row.reversedAt }),
    ...(row.reversedByMembershipId === null
      ? {}
      : { reversedByMembershipId: parseMembershipId(row.reversedByMembershipId) }),
    ...(row.reversalReason === null ? {} : { reversalReason: row.reversalReason }),
  };
}
