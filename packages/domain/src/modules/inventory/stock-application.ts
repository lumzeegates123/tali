import { DomainError } from "../../errors.js";
import type { Quantity } from "../../kernel/index.js";
import type { BusinessId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import type { InventoryReasonCode } from "./adjustment.js";
import type { StockBalance } from "./balance.js";
import { applyMovementToBalance } from "./balance.js";
import type { InventoryReasonNote, InventoryRecording } from "./common.js";
import { compareIds } from "./common.js";
import type { InventoryMovementId } from "./ids.js";
import type { InventoryMovement, InventoryMovementSource, InventoryMovementType, PackSnapshot } from "./movement.js";
import { restoreMovement } from "./movement.js";

/**
 * One planned stock-item change. Module-internal: used by planStockChange,
 * reverseDocumentMovements and planCountCorrections. Not a public export.
 */
export interface PlannedEntry {
  readonly movementId: InventoryMovementId;
  readonly variantId: ProductVariantId;
  readonly delta: Quantity;
  readonly pack?: PackSnapshot;
  readonly reversesMovementId?: InventoryMovementId;
  readonly reasonCode?: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
}

export function requireDistinct(values: readonly string[], message: string, field: string): void {
  if (new Set(values).size !== values.length) {
    throw new DomainError("INVALID_VALUE", message, field);
  }
}

/** Indexes the locked balances by variant: exactly one per entry, all at this business and location. */
function balancesByVariant(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantIds: readonly ProductVariantId[];
  readonly balances: readonly StockBalance[];
}): ReadonlyMap<ProductVariantId, StockBalance> {
  const byVariant = new Map<ProductVariantId, StockBalance>();
  for (const balance of props.balances) {
    if (balance.businessId !== props.businessId || balance.locationId !== props.locationId) {
      throw new DomainError("INVALID_VALUE", "a balance belongs to a different business or location", "balances");
    }
    if (byVariant.has(balance.variantId)) {
      throw new DomainError("INVALID_VALUE", "a stock item has more than one balance", "balances");
    }
    byVariant.set(balance.variantId, balance);
  }
  if (byVariant.size !== props.variantIds.length || props.variantIds.some((id) => !byVariant.has(id))) {
    throw new DomainError("INVALID_VALUE", "exactly the locked balance of every line is required", "balances");
  }
  return byVariant;
}

/**
 * Shared exact movement/balance application: identity checks, quantity
 * addition, version + 1, balanceAfter, lastMovementId, and ascending variant
 * order. The Build 2 manual-decrease rule stays here so planStockChange and
 * reversals are unchanged. planCountCorrections only reaches it with
 * counted >= 0, so the rule cannot fire.
 */
export function applyEntries(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly type: InventoryMovementType;
  readonly source: InventoryMovementSource;
  readonly entries: readonly PlannedEntry[];
  readonly balances: readonly StockBalance[];
  readonly recording: InventoryRecording;
}): { readonly movements: readonly InventoryMovement[]; readonly balances: readonly StockBalance[] } {
  const entries = [...props.entries].sort((a, b) => compareIds(a.variantId, b.variantId));
  const byVariant = balancesByVariant({
    businessId: props.businessId,
    locationId: props.locationId,
    variantIds: entries.map((entry) => entry.variantId),
    balances: props.balances,
  });
  const steps = entries.map((entry) => {
    const balance = byVariant.get(entry.variantId) as StockBalance;
    if (props.type === "OPENING" && balance.version !== 0) {
      throw new DomainError(
        "INVALID_TRANSITION",
        "opening stock can only be recorded before any movement of the stock item",
        "lines",
      );
    }
    return { entry, balance, after: balance.quantity.add(entry.delta) };
  });
  for (const { entry, after } of steps) {
    if (entry.delta.isNegative() && after.isNegative()) {
      throw new DomainError("INSUFFICIENT_STOCK", "the change would take on-hand stock below zero", "quantity");
    }
  }
  const movements: InventoryMovement[] = [];
  const balances: StockBalance[] = [];
  for (const { entry, balance, after } of steps) {
    const movement = restoreMovement({
      id: entry.movementId,
      businessId: props.businessId,
      locationId: props.locationId,
      variantId: entry.variantId,
      type: props.type,
      delta: entry.delta,
      balanceAfter: after,
      balanceVersion: balance.version + 1,
      source: props.source,
      pack: entry.pack,
      reversesMovementId: entry.reversesMovementId,
      reasonCode: entry.reasonCode,
      reasonNote: entry.reasonNote,
      ...props.recording,
    });
    movements.push(movement);
    balances.push(applyMovementToBalance(balance, movement));
  }
  return Object.freeze({ movements: Object.freeze(movements), balances: Object.freeze(balances) });
}
