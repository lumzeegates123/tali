import { DomainError } from "../../errors.js";
import type { UnitCode } from "../../kernel/index.js";
import { KernelError, Quantity } from "../../kernel/index.js";
import type { CatalogStatus } from "../catalog/index.js";

function inStockUnit(value: Quantity, stockUnit: UnitCode, field: string): Quantity {
  if (!(value instanceof Quantity)) {
    throw new DomainError("INVALID_VALUE", `${field} must be a Quantity`, field);
  }
  if (value.unit !== stockUnit) {
    throw new KernelError("UNIT_MISMATCH", `${field} is in ${value.unit}, not the stock unit ${stockUnit}`);
  }
  return value;
}

/**
 * Derived on read, never stored (ADR-008 section 7.4): LOW_STOCK holds only for
 * an ACTIVE, tracked variant with a configured threshold whose on-hand stock is
 * at or below it. A missing balance is zero in the variant's stock unit, so a
 * threshold of 0 flags an out-of-stock item. Quantities in another unit are a
 * unit mismatch, never converted.
 */
export function deriveLowStock(props: {
  readonly variantStatus: CatalogStatus;
  readonly trackInventory: boolean;
  readonly stockUnit: UnitCode;
  readonly threshold?: Quantity | undefined;
  readonly onHand?: Quantity | undefined;
}): boolean {
  const threshold =
    props.threshold === undefined ? undefined : inStockUnit(props.threshold, props.stockUnit, "threshold");
  if (threshold?.isNegative() === true) {
    throw new DomainError("INVALID_VALUE", "threshold cannot be negative", "threshold");
  }
  const onHand =
    props.onHand === undefined ? Quantity.zero(props.stockUnit) : inStockUnit(props.onHand, props.stockUnit, "onHand");
  if (props.variantStatus !== "ACTIVE" || !props.trackInventory || threshold === undefined) {
    return false;
  }
  return onHand.compare(threshold) <= 0;
}
