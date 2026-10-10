import { DomainError } from "../../errors.js";
import { KernelError, Quantity } from "../../kernel/index.js";
import type { BusinessId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import type { StockBalance } from "./balance.js";
import type { InventoryRecording } from "./common.js";
import { compareIds, MAX_STOCKTAKE_LINES } from "./common.js";
import type { InventoryMovementId, StocktakeId } from "./ids.js";
import type { InventoryMovement } from "./movement.js";
import { applyEntries, requireDistinct } from "./stock-application.js";

/** One COUNTED stocktake line ready to become a correction, or a zero-variance no-op. */
export interface CountCorrectionLine {
  readonly variantId: ProductVariantId;
  readonly counted: Quantity;
  readonly balance: StockBalance;
  readonly movementId: InventoryMovementId;
}

/** Variance for every counted input line, including zeros that produce no movement. */
export interface CountCorrectionVariance {
  readonly variantId: ProductVariantId;
  readonly variance: Quantity;
}

/**
 * Movements and next balances only for non-zero variances; a variance row for
 * every counted input line. All three lists are in ascending variant order.
 */
export interface CountCorrectionPlan {
  readonly movements: readonly InventoryMovement[];
  readonly balances: readonly StockBalance[];
  readonly variances: readonly CountCorrectionVariance[];
}

function requireCountedQuantity(value: unknown, field: string): Quantity {
  if (!(value instanceof Quantity)) {
    throw new DomainError("INVALID_VALUE", "counted quantity must be a Quantity", field);
  }
  if (value.isNegative()) {
    throw new DomainError("INVALID_VALUE", "counted quantity cannot be negative", field);
  }
  return value;
}

/**
 * Plans COUNT_CORRECTION movements that set each stock item to its counted
 * quantity (ADR-008 sections 10 and 12.4). Zero variance writes nothing.
 * Counted is 0 or more, so the resulting balance is never negative and the
 * manual-decrease INSUFFICIENT_STOCK rule cannot fire.
 */
export function planCountCorrections(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly stocktakeId: StocktakeId;
  readonly lines: readonly CountCorrectionLine[];
  readonly recording: InventoryRecording;
}): CountCorrectionPlan {
  if (props.lines.length < 1 || props.lines.length > MAX_STOCKTAKE_LINES) {
    throw new DomainError("INVALID_VALUE", `a stocktake posts 1 to ${MAX_STOCKTAKE_LINES} counted lines`, "lines");
  }
  requireDistinct(
    props.lines.map((line) => line.variantId),
    "a stocktake has one counted line per variant",
    "lines",
  );
  requireDistinct(
    props.lines.map((line) => line.movementId),
    "every counted line needs its own movement id",
    "lines",
  );

  const ordered = [...props.lines].sort((a, b) => compareIds(a.variantId, b.variantId));
  const variances: CountCorrectionVariance[] = [];
  const changing: CountCorrectionLine[] = [];
  for (const line of ordered) {
    const counted = requireCountedQuantity(line.counted, "quantity");
    if (line.balance.variantId !== line.variantId) {
      throw new DomainError("INVALID_VALUE", "a balance belongs to a different variant", "balances");
    }
    if (counted.unit !== line.balance.quantity.unit) {
      throw new KernelError(
        "UNIT_MISMATCH",
        `counted quantity (${counted.unit}) and on-hand (${line.balance.quantity.unit}) must share a unit`,
      );
    }
    const variance = counted.subtract(line.balance.quantity);
    variances.push(Object.freeze({ variantId: line.variantId, variance }));
    if (!variance.isZero()) changing.push(line);
  }

  if (changing.length === 0) {
    return Object.freeze({
      movements: Object.freeze([]),
      balances: Object.freeze([]),
      variances: Object.freeze(variances),
    });
  }

  const planned = applyEntries({
    businessId: props.businessId,
    locationId: props.locationId,
    type: "COUNT_CORRECTION",
    source: { kind: "STOCKTAKE", id: props.stocktakeId },
    entries: changing.map((line) => ({
      movementId: line.movementId,
      variantId: line.variantId,
      delta: line.counted.subtract(line.balance.quantity),
    })),
    balances: changing.map((line) => line.balance),
    recording: props.recording,
  });
  return Object.freeze({
    movements: planned.movements,
    balances: planned.balances,
    variances: Object.freeze(variances),
  });
}
