import { DomainError } from "../../errors.js";
import type { UnitCode } from "../../kernel/index.js";
import { Quantity } from "../../kernel/index.js";
import type { BusinessId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import { validNonNegativeVersion } from "./common.js";
import type { InventoryMovementId } from "./ids.js";
import type { InventoryMovement } from "./movement.js";

/**
 * The transactional projection of one stock item (variant at a location),
 * ADR-008 section 7.3. `quantity` is the sum of its movements' deltas and
 * `version` their count. A missing row is version 0 with quantity 0.
 *
 * There is deliberately no non-negative invariant here: Build 2's rule that
 * manual decreases may not go below zero is a policy of the stock-change
 * decision, and a future sales policy may preserve negative stock.
 */
export interface StockBalance {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly quantity: Quantity;
  readonly version: number;
  readonly lastMovementId?: InventoryMovementId;
}

/** The balance of a stock item that has no movement yet, in the variant's stock unit. */
export function emptyStockBalance(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly stockUnit: UnitCode;
}): StockBalance {
  return Object.freeze({
    businessId: props.businessId,
    locationId: props.locationId,
    variantId: props.variantId,
    quantity: Quantity.zero(props.stockUnit),
    version: 0,
  });
}

/** Validates a balance read from storage: version 0 means no movement, so zero quantity and no last movement. */
export function restoreStockBalance(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly quantity: Quantity;
  readonly version: number;
  readonly lastMovementId?: InventoryMovementId | undefined;
}): StockBalance {
  if (!(props.quantity instanceof Quantity)) {
    throw new DomainError("INVALID_VALUE", "quantity must be a Quantity", "quantity");
  }
  const version = validNonNegativeVersion(props.version, "version");
  if ((version === 0) !== (props.lastMovementId === undefined)) {
    throw new DomainError("INVALID_VALUE", "only a balance with movements has a last movement", "lastMovementId");
  }
  if (version === 0 && !props.quantity.isZero()) {
    throw new DomainError("INVALID_VALUE", "a balance with no movement must be zero", "quantity");
  }
  return Object.freeze({
    businessId: props.businessId,
    locationId: props.locationId,
    variantId: props.variantId,
    quantity: props.quantity,
    version,
    ...(props.lastMovementId === undefined ? {} : { lastMovementId: props.lastMovementId }),
  });
}

/**
 * Applies one movement to the balance it was planned against: the quantity
 * changes by exactly the delta, the version increases by exactly one, and the
 * movement becomes the last movement. The movement must already carry that
 * resulting balance and version.
 */
export function applyMovementToBalance(balance: StockBalance, movement: InventoryMovement): StockBalance {
  if (
    movement.businessId !== balance.businessId ||
    movement.locationId !== balance.locationId ||
    movement.variantId !== balance.variantId
  ) {
    throw new DomainError("INVALID_VALUE", "the movement belongs to a different stock item", "movement");
  }
  const quantity = balance.quantity.add(movement.delta);
  const version = balance.version + 1;
  if (movement.balanceVersion !== version || !movement.balanceAfter.equals(quantity)) {
    throw new DomainError(
      "INVALID_VALUE",
      "the movement does not follow the current balance and version",
      "balanceVersion",
    );
  }
  return Object.freeze({
    businessId: balance.businessId,
    locationId: balance.locationId,
    variantId: balance.variantId,
    quantity,
    version,
    lastMovementId: movement.id,
  });
}
