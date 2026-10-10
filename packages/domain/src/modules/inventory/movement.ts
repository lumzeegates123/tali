import { DomainError } from "../../errors.js";
import { KernelError, MAX_QUANTITY_MINOR, Quantity } from "../../kernel/index.js";
import type { BusinessId, MembershipId } from "../business/index.js";
import type { PackName, ProductPackId, ProductVariantId } from "../catalog/index.js";
import { parsePackFactor, parsePackName } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import type { InventoryReasonCode } from "./adjustment.js";
import { parseAdjustmentReason } from "./adjustment.js";
import type { InventoryReasonNote, InventoryRecording } from "./common.js";
import { parseInventoryReasonNote, restoreInventoryRecording, validPositiveVersion } from "./common.js";
import type { GoodsReceiptId, InventoryAdjustmentId, InventoryMovementId, OpeningBatchId, StocktakeId } from "./ids.js";

/**
 * The movement types Build 2 implements (ADR-008 section 7.1). SALE,
 * CUSTOMER_RETURN and SUPPLIER_RETURN arrive with their own use cases.
 */
export const INVENTORY_MOVEMENT_TYPES = [
  "OPENING",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT",
  "WRITE_OFF",
  "COUNT_CORRECTION",
] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

/** The document a movement belongs to: one typed reference per type (ADR-008 section 8). */
export type InventoryMovementSource =
  | { readonly kind: "OPENING_BATCH"; readonly id: OpeningBatchId }
  | { readonly kind: "GOODS_RECEIPT"; readonly id: GoodsReceiptId }
  | { readonly kind: "ADJUSTMENT"; readonly id: InventoryAdjustmentId }
  | { readonly kind: "STOCKTAKE"; readonly id: StocktakeId };

export type InventoryMovementSourceKind = InventoryMovementSource["kind"];

const SOURCE_KIND_BY_TYPE: Readonly<Record<InventoryMovementType, InventoryMovementSourceKind>> = Object.freeze({
  OPENING: "OPENING_BATCH",
  PURCHASE_RECEIPT: "GOODS_RECEIPT",
  ADJUSTMENT: "ADJUSTMENT",
  WRITE_OFF: "ADJUSTMENT",
  COUNT_CORRECTION: "STOCKTAKE",
});

export function parseInventoryMovementType(value: string): InventoryMovementType {
  if (!(INVENTORY_MOVEMENT_TYPES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown inventory movement type", "type");
  }
  return value as InventoryMovementType;
}

/** The document kind a movement type must reference. */
export function sourceKindFor(type: InventoryMovementType): InventoryMovementSourceKind {
  return SOURCE_KIND_BY_TYPE[type];
}

export function requireSourceForType(type: InventoryMovementType, source: InventoryMovementSource): void {
  const kind = (source as { readonly kind?: unknown } | null | undefined)?.kind;
  if (kind !== sourceKindFor(type)) {
    throw new DomainError("INVALID_VALUE", `a ${type} movement must reference its ${sourceKindFor(type)}`, "source");
  }
}

/**
 * Immutable evidence that an original movement was entered as whole packs: the
 * pack, its name and factor at the time, and the count. The movement's delta
 * is always in the stock unit; the pack converts to it, never the reverse.
 */
export interface PackSnapshot {
  readonly packId: ProductPackId;
  readonly name: PackName;
  readonly count: bigint;
  readonly factorMinor: bigint;
}

export function parsePackSnapshot(props: {
  readonly packId: ProductPackId;
  readonly name: string;
  readonly count: bigint;
  readonly factorMinor: bigint;
}): PackSnapshot {
  if (typeof props.count !== "bigint" || props.count < 1n || props.count > MAX_QUANTITY_MINOR) {
    throw new DomainError("INVALID_VALUE", "pack count must be a positive whole number within range", "packCount");
  }
  return Object.freeze({
    packId: props.packId,
    name: parsePackName(props.name),
    count: props.count,
    factorMinor: parsePackFactor(props.factorMinor),
  });
}

/**
 * One append-only stock change for one variant at one location (ADR-008
 * section 7.1). `balanceAfter` and `balanceVersion` are the stock item's
 * balance and version after this movement; versions form a gap-free sequence
 * from 1. A reversal (`reversesMovementId` set) exactly negates its original,
 * has the same type, location, variant and document, carries no pack snapshot
 * and records the reversal reason as its note.
 */
export interface InventoryMovement extends InventoryRecording {
  readonly id: InventoryMovementId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly type: InventoryMovementType;
  readonly delta: Quantity;
  readonly balanceAfter: Quantity;
  readonly balanceVersion: number;
  readonly source: InventoryMovementSource;
  readonly pack?: PackSnapshot;
  readonly reversesMovementId?: InventoryMovementId;
  readonly reasonCode?: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
}

function requireDirection(type: InventoryMovementType, delta: Quantity, reversal: boolean): void {
  if (delta.isZero()) {
    throw new DomainError("INVALID_VALUE", "a movement quantity cannot be zero", "quantity");
  }
  switch (type) {
    case "OPENING":
      if (reversal) {
        throw new DomainError("INVALID_TRANSITION", "opening stock is not reversible", "reversesMovementId");
      }
      if (!delta.isPositive()) {
        throw new DomainError("INVALID_VALUE", "an OPENING movement must be positive", "quantity");
      }
      return;
    case "PURCHASE_RECEIPT":
      if (delta.isPositive() === reversal) {
        throw new DomainError(
          "INVALID_VALUE",
          reversal ? "a PURCHASE_RECEIPT reversal must be negative" : "a PURCHASE_RECEIPT movement must be positive",
          "quantity",
        );
      }
      return;
    case "WRITE_OFF":
      if (delta.isNegative() === reversal) {
        throw new DomainError(
          "INVALID_VALUE",
          reversal ? "a WRITE_OFF reversal must be positive" : "a WRITE_OFF movement must be negative",
          "quantity",
        );
      }
      return;
    case "ADJUSTMENT":
      return;
    case "COUNT_CORRECTION":
      if (reversal) {
        throw new DomainError(
          "INVALID_TRANSITION",
          "a count correction is not reversed; count again or record an adjustment",
          "reversesMovementId",
        );
      }
      return;
  }
}

/** The direction an original line of the given type must have (zero is never allowed). */
export function requireOriginalDirection(type: InventoryMovementType, delta: Quantity): void {
  requireDirection(type, delta, false);
}

interface MovementReason {
  readonly reasonCode?: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
}

function validMovementReason(props: {
  readonly type: InventoryMovementType;
  readonly reversal: boolean;
  readonly reasonCode: string | undefined;
  readonly reasonNote: string | undefined;
}): MovementReason {
  if (props.reversal) {
    if (props.reasonCode !== undefined) {
      throw new DomainError("INVALID_VALUE", "a reversal movement carries no reason code", "reasonCode");
    }
    if (props.reasonNote === undefined) {
      throw new DomainError("INVALID_VALUE", "a reversal movement requires its reversal reason", "reasonNote");
    }
    return { reasonNote: parseInventoryReasonNote(props.reasonNote) };
  }
  if (props.type === "OPENING" || props.type === "PURCHASE_RECEIPT" || props.type === "COUNT_CORRECTION") {
    if (props.reasonCode !== undefined || props.reasonNote !== undefined) {
      throw new DomainError("INVALID_VALUE", `a ${props.type} movement carries no reason`, "reasonCode");
    }
    return {};
  }
  if (props.reasonCode === undefined) {
    throw new DomainError("INVALID_VALUE", `a ${props.type} movement requires a reason code`, "reasonCode");
  }
  return parseAdjustmentReason({ kind: props.type, reasonCode: props.reasonCode, reasonNote: props.reasonNote });
}

/** Validates every movement invariant and returns the frozen movement. */
export function restoreMovement(props: {
  readonly id: InventoryMovementId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly type: string;
  readonly delta: Quantity;
  readonly balanceAfter: Quantity;
  readonly balanceVersion: number;
  readonly source: InventoryMovementSource;
  readonly pack?:
    | {
        readonly packId: ProductPackId;
        readonly name: string;
        readonly count: bigint;
        readonly factorMinor: bigint;
      }
    | undefined;
  readonly reversesMovementId?: InventoryMovementId | undefined;
  readonly reasonCode?: string | undefined;
  readonly reasonNote?: string | undefined;
  readonly actorMembershipId: MembershipId;
  readonly deviceId?: InventoryRecording["deviceId"] | undefined;
  readonly sourceChannel: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly businessDate: InventoryRecording["businessDate"];
  readonly recordedAt: Date;
}): InventoryMovement {
  const type = parseInventoryMovementType(props.type);
  requireSourceForType(type, props.source);
  if (!(props.delta instanceof Quantity) || !(props.balanceAfter instanceof Quantity)) {
    throw new DomainError("INVALID_VALUE", "delta and balanceAfter must be quantities", "quantity");
  }
  if (props.delta.unit !== props.balanceAfter.unit) {
    throw new KernelError(
      "UNIT_MISMATCH",
      `a movement's delta (${props.delta.unit}) and balance (${props.balanceAfter.unit}) must share a unit`,
    );
  }
  const reversal = props.reversesMovementId !== undefined;
  if (reversal && props.reversesMovementId === props.id) {
    throw new DomainError("INVALID_VALUE", "a movement cannot reverse itself", "reversesMovementId");
  }
  requireDirection(type, props.delta, reversal);
  const balanceVersion = validPositiveVersion(props.balanceVersion, "balanceVersion");
  let pack: PackSnapshot | undefined;
  if (props.pack !== undefined) {
    if (reversal) {
      throw new DomainError("INVALID_VALUE", "a reversal movement carries no pack snapshot", "pack");
    }
    if (type === "COUNT_CORRECTION") {
      throw new DomainError("INVALID_VALUE", "a COUNT_CORRECTION movement carries no pack snapshot", "pack");
    }
    pack = parsePackSnapshot(props.pack);
    if (props.delta.abs().amountMinor !== pack.count * pack.factorMinor) {
      throw new DomainError("INVALID_VALUE", "the movement quantity must equal pack count times pack factor", "pack");
    }
  }
  const reason = validMovementReason({
    type,
    reversal,
    reasonCode: props.reasonCode,
    reasonNote: props.reasonNote,
  });
  const source: InventoryMovementSource = Object.freeze({ ...props.source });
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    variantId: props.variantId,
    type,
    delta: props.delta,
    balanceAfter: props.balanceAfter,
    balanceVersion,
    source,
    ...(pack === undefined ? {} : { pack }),
    ...(props.reversesMovementId === undefined ? {} : { reversesMovementId: props.reversesMovementId }),
    ...reason,
    ...restoreInventoryRecording(props),
  });
}
