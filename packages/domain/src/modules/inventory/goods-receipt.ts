import { normalizeBoundedName } from "../../text.js";
import type { BusinessId, MembershipId } from "../business/index.js";
import type { LocationId } from "../location/index.js";
import type { DocumentReversalState, InventoryNote, InventoryReasonNote, InventoryRecording } from "./common.js";
import {
  parseInventoryNote,
  recordingFields,
  restoreInventoryRecording,
  restoreReversalState,
  reversedState,
} from "./common.js";
import type { GoodsReceiptId } from "./ids.js";

declare const goodsReceiptReferenceBrand: unique symbol;

/** An optional delivery-note or invoice number: 1 to 64 characters after trimming and NFC normalization. */
export type GoodsReceiptReference = string & { readonly [goodsReceiptReferenceBrand]: true };

export const GOODS_RECEIPT_REFERENCE_MAX_LENGTH = 64;

export function parseGoodsReceiptReference(value: string): GoodsReceiptReference {
  return normalizeBoundedName(value, "reference", GOODS_RECEIPT_REFERENCE_MAX_LENGTH) as GoodsReceiptReference;
}

/**
 * A quantity-only goods receipt header (ADR-008 section 11): no supplier, no
 * purchase order and no cost. Its lines are PURCHASE_RECEIPT movements.
 */
export interface GoodsReceipt extends InventoryRecording, DocumentReversalState {
  readonly id: GoodsReceiptId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly reference?: GoodsReceiptReference;
  readonly note?: InventoryNote;
}

export function createGoodsReceipt(props: {
  readonly id: GoodsReceiptId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly reference?: GoodsReceiptReference;
  readonly note?: InventoryNote;
  readonly recording: InventoryRecording;
}): GoodsReceipt {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    ...(props.reference === undefined ? {} : { reference: parseGoodsReceiptReference(props.reference) }),
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    status: "POSTED",
    ...recordingFields(props.recording),
  });
}

export function restoreGoodsReceipt(props: {
  readonly id: GoodsReceiptId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly reference?: string | undefined;
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
}): GoodsReceipt {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    ...(props.reference === undefined ? {} : { reference: parseGoodsReceiptReference(props.reference) }),
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    ...restoreReversalState(props),
    ...restoreInventoryRecording(props),
  });
}

/** POSTED to REVERSED with the required reason. Already REVERSED is INVALID_TRANSITION here; the use case no-ops first. */
export function reverseGoodsReceipt(props: {
  readonly receipt: GoodsReceipt;
  readonly reversedByMembershipId: MembershipId;
  readonly reason: InventoryReasonNote;
  readonly now: Date;
}): GoodsReceipt {
  return Object.freeze({
    ...props.receipt,
    ...reversedState({
      current: props.receipt,
      reversedByMembershipId: props.reversedByMembershipId,
      reason: props.reason,
      now: props.now,
    }),
  });
}
