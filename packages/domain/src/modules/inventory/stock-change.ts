import { DomainError } from "../../errors.js";
import { Quantity } from "../../kernel/index.js";
import type { BusinessId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import type { AdjustmentReason } from "./adjustment.js";
import { parseAdjustmentReason } from "./adjustment.js";
import type { StockBalance } from "./balance.js";
import type { InventoryReasonNote, InventoryRecording } from "./common.js";
import { MAX_INVENTORY_DOCUMENT_LINES, parseInventoryReasonNote } from "./common.js";
import type { InventoryMovementId } from "./ids.js";
import type { InventoryMovement, InventoryMovementSource, InventoryMovementType, PackSnapshot } from "./movement.js";
import { parseInventoryMovementType, requireOriginalDirection, requireSourceForType } from "./movement.js";
import { applyEntries, requireDistinct } from "./stock-application.js";

/** One normalized document line: an exact stock-unit delta for one variant, with its new movement ID. */
export interface StockChangeLine {
  readonly movementId: InventoryMovementId;
  readonly variantId: ProductVariantId;
  readonly delta: Quantity;
  readonly pack?: PackSnapshot;
}

/** The movements to append and the balances to write, both in ascending variant order. */
export interface StockChangePlan {
  readonly movements: readonly InventoryMovement[];
  readonly balances: readonly StockBalance[];
}

function requireLineCount(count: number, field: string): void {
  if (count < 1 || count > MAX_INVENTORY_DOCUMENT_LINES) {
    throw new DomainError("INVALID_VALUE", `a document has 1 to ${MAX_INVENTORY_DOCUMENT_LINES} lines`, field);
  }
}

/**
 * Plans the movements of a new opening batch, goods receipt, adjustment or
 * write-off (ADR-008 sections 7, 9 and 10) against the locked balances of its
 * lines. Pure and deterministic.
 *
 * - Each line's direction must suit the type: OPENING and PURCHASE_RECEIPT
 *   positive, WRITE_OFF negative, ADJUSTMENT non-zero.
 * - OPENING requires the stock item to have no movement (balance version 0),
 *   otherwise INVALID_TRANSITION.
 * - Build 2 manual-decrease policy: a decrease whose result is below zero is
 *   INSUFFICIENT_STOCK. Increases are always allowed.
 * - Each movement gets `balanceAfter = balance + delta` and
 *   `balanceVersion = version + 1`; movements and balances are returned in
 *   ascending variant order.
 */
export function planStockChange(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly type: InventoryMovementType;
  readonly source: InventoryMovementSource;
  readonly lines: readonly StockChangeLine[];
  readonly balances: readonly StockBalance[];
  readonly reason?: AdjustmentReason;
  readonly recording: InventoryRecording;
}): StockChangePlan {
  const type = parseInventoryMovementType(props.type);
  if (type === "COUNT_CORRECTION") {
    throw new DomainError("INVALID_VALUE", "COUNT_CORRECTION is planned by planCountCorrections", "type");
  }
  requireSourceForType(type, props.source);
  requireLineCount(props.lines.length, "lines");
  requireDistinct(
    props.lines.map((line) => line.variantId),
    "a document has one line per variant",
    "lines",
  );
  requireDistinct(
    props.lines.map((line) => line.movementId),
    "every line needs its own movement id",
    "lines",
  );
  let reason: AdjustmentReason | undefined;
  if (type === "ADJUSTMENT" || type === "WRITE_OFF") {
    if (props.reason === undefined) {
      throw new DomainError("INVALID_VALUE", `a ${type} requires a reason`, "reasonCode");
    }
    reason = parseAdjustmentReason({
      kind: type,
      reasonCode: props.reason.reasonCode,
      reasonNote: props.reason.reasonNote,
    });
  } else if (props.reason !== undefined) {
    throw new DomainError("INVALID_VALUE", `a ${type} carries no reason`, "reasonCode");
  }
  for (const line of props.lines) {
    if (!(line.delta instanceof Quantity)) {
      throw new DomainError("INVALID_VALUE", "a line quantity must be a Quantity", "quantity");
    }
    requireOriginalDirection(type, line.delta);
  }
  return applyEntries({
    businessId: props.businessId,
    locationId: props.locationId,
    type,
    source: props.source,
    entries: props.lines.map((line) => ({
      movementId: line.movementId,
      variantId: line.variantId,
      delta: line.delta,
      ...(line.pack === undefined ? {} : { pack: line.pack }),
      ...(reason === undefined ? {} : reason),
    })),
    balances: props.balances,
    recording: props.recording,
  });
}

/**
 * Plans the reversal of a whole document (ADR-008 section 11): one reversal
 * movement per original line that exactly negates it, with the same business,
 * location, variant, type and source document, `reversesMovementId` set, no
 * pack snapshot, no reason code and the reversal reason as its note. Balances
 * advance by one version per movement and the same negative-stock policy
 * applies. OPENING is not reversible, and a reversal is never reversed.
 */
export function reverseDocumentMovements(props: {
  readonly originals: readonly InventoryMovement[];
  readonly balances: readonly StockBalance[];
  readonly reversalMovementIds: ReadonlyMap<InventoryMovementId, InventoryMovementId>;
  readonly reason: InventoryReasonNote;
  readonly recording: InventoryRecording;
}): StockChangePlan {
  const { originals } = props;
  requireLineCount(originals.length, "originals");
  const first = originals[0] as InventoryMovement;
  for (const original of originals) {
    if (original.reversesMovementId !== undefined) {
      throw new DomainError("INVALID_TRANSITION", "a reversal movement cannot itself be reversed", "originals");
    }
    if (original.type === "OPENING") {
      throw new DomainError("INVALID_TRANSITION", "opening stock is not reversible", "originals");
    }
    if (original.type === "COUNT_CORRECTION") {
      throw new DomainError(
        "INVALID_TRANSITION",
        "a count correction is not reversed; count again or record an adjustment",
        "originals",
      );
    }
    if (
      original.businessId !== first.businessId ||
      original.locationId !== first.locationId ||
      original.type !== first.type ||
      original.source.kind !== first.source.kind ||
      original.source.id !== first.source.id
    ) {
      throw new DomainError("INVALID_VALUE", "the movements do not belong to one document", "originals");
    }
  }
  requireDistinct(
    originals.map((original) => original.variantId),
    "a document has one line per variant",
    "originals",
  );
  requireDistinct(
    originals.map((original) => original.id),
    "a movement is listed twice",
    "originals",
  );
  const newIds = originals.map((original) => props.reversalMovementIds.get(original.id));
  const originalIds = new Set<string>(originals.map((original) => original.id));
  if (
    props.reversalMovementIds.size !== originals.length ||
    newIds.some((id) => id === undefined || originalIds.has(id)) ||
    new Set(newIds).size !== newIds.length
  ) {
    throw new DomainError(
      "INVALID_VALUE",
      "every original needs exactly one new, distinct reversal movement id",
      "reversalMovementIds",
    );
  }
  const reason = parseInventoryReasonNote(props.reason, "reason");
  return applyEntries({
    businessId: first.businessId,
    locationId: first.locationId,
    type: first.type,
    source: first.source,
    entries: originals.map((original, index) => ({
      movementId: newIds[index] as InventoryMovementId,
      variantId: original.variantId,
      delta: original.delta.negate(),
      reversesMovementId: original.id,
      reasonNote: reason,
    })),
    balances: props.balances,
    recording: props.recording,
  });
}
