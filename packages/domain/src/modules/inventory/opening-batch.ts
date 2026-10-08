import type { BusinessId, MembershipId } from "../business/index.js";
import type { LocationId } from "../location/index.js";
import type { InventoryNote, InventoryRecording } from "./common.js";
import { parseInventoryNote, recordingFields, restoreInventoryRecording } from "./common.js";
import type { OpeningBatchId } from "./ids.js";

/**
 * An opening-stock document header (ADR-008 section 11). Its lines are
 * OPENING movements. It has no status because it is never reversed: a wrong
 * opening is corrected by an adjustment or a count.
 */
export interface OpeningBatch extends InventoryRecording {
  readonly id: OpeningBatchId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly note?: InventoryNote;
}

export function createOpeningBatch(props: {
  readonly id: OpeningBatchId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly note?: InventoryNote;
  readonly recording: InventoryRecording;
}): OpeningBatch {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    ...recordingFields(props.recording),
  });
}

export function restoreOpeningBatch(props: {
  readonly id: OpeningBatchId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly note?: string | undefined;
  readonly actorMembershipId: MembershipId;
  readonly deviceId?: InventoryRecording["deviceId"] | undefined;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: InventoryRecording["businessDate"];
  readonly recordedAt: Date;
}): OpeningBatch {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    ...restoreInventoryRecording(props),
  });
}
