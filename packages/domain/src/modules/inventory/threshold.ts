import { DomainError } from "../../errors.js";
import type { UnitCode } from "../../kernel/index.js";
import { KernelError, Quantity } from "../../kernel/index.js";
import type { BusinessId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import { validNonNegativeVersion, validPositiveVersion } from "./common.js";
import type { StockThresholdId } from "./ids.js";

/**
 * Low-stock configuration for one stock item (ADR-008 section 7.4). It is not
 * a movement and never changes a balance. An absent threshold means "not
 * configured"; clearing keeps the row. Persisted versions start at 1, and the
 * absence of a row is configuration version 0.
 */
export interface StockThreshold {
  readonly id: StockThresholdId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly threshold?: Quantity;
  readonly version: number;
}

/** The stock item a threshold decision targets, with the variant's current stock unit. */
export interface StockThresholdTarget {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly stockUnit: UnitCode;
}

export type StockThresholdDecision =
  | { readonly outcome: "unchanged"; readonly record: StockThreshold | undefined }
  | { readonly outcome: "created"; readonly record: StockThreshold }
  | { readonly outcome: "changed"; readonly record: StockThreshold; readonly previous: StockThreshold };

/** A threshold is an exact quantity of 0 or more in the variant's stock unit; there is no pack form. */
function validThresholdQuantity(value: Quantity, stockUnit: UnitCode | undefined): Quantity {
  if (!(value instanceof Quantity)) {
    throw new DomainError("INVALID_VALUE", "threshold must be a Quantity", "threshold");
  }
  if (stockUnit !== undefined && value.unit !== stockUnit) {
    throw new KernelError("UNIT_MISMATCH", `a threshold must be in the stock unit ${stockUnit}, not ${value.unit}`);
  }
  if (value.isNegative()) {
    throw new DomainError("INVALID_VALUE", "threshold cannot be negative", "threshold");
  }
  return value;
}

/** Threshold decisions accept expectedVersion 0, which means "I expect no row". */
export function parseThresholdExpectedVersion(value: number): number {
  return validNonNegativeVersion(value, "expectedVersion");
}

export function restoreStockThreshold(props: {
  readonly id: StockThresholdId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly threshold?: Quantity | undefined;
  readonly version: number;
}): StockThreshold {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    locationId: props.locationId,
    variantId: props.variantId,
    ...(props.threshold === undefined ? {} : { threshold: validThresholdQuantity(props.threshold, undefined) }),
    version: validPositiveVersion(props.version, "version"),
  });
}

function requireTarget(current: StockThreshold | undefined, target: Omit<StockThresholdTarget, "stockUnit">): void {
  if (
    current !== undefined &&
    (current.businessId !== target.businessId ||
      current.locationId !== target.locationId ||
      current.variantId !== target.variantId)
  ) {
    throw new DomainError("INVALID_VALUE", "the threshold belongs to a different stock item", "threshold");
  }
}

/** Optimistic concurrency, checked before the no-op decision: a stale version is a conflict even if the value holds. */
function requireVersion(current: StockThreshold | undefined, expectedVersion: number): void {
  if ((current?.version ?? 0) !== expectedVersion) {
    throw new DomainError("VERSION_CONFLICT", "the threshold has changed since it was read", "expectedVersion");
  }
}

/**
 * SetLowStockThreshold. No row with expectedVersion 0 creates version 1; a row
 * (even a cleared one) requires its current version; the same value is a
 * no-op; a different value bumps the version.
 */
export function decideSetThreshold(props: {
  readonly current: StockThreshold | undefined;
  readonly expectedVersion: number;
  readonly target: StockThresholdTarget;
  readonly value: Quantity;
  readonly newId: StockThresholdId;
}): StockThresholdDecision {
  const expectedVersion = parseThresholdExpectedVersion(props.expectedVersion);
  const value = validThresholdQuantity(props.value, props.target.stockUnit);
  const { current, target } = props;
  requireTarget(current, target);
  requireVersion(current, expectedVersion);
  if (current === undefined) {
    return {
      outcome: "created",
      record: Object.freeze({
        id: props.newId,
        businessId: target.businessId,
        locationId: target.locationId,
        variantId: target.variantId,
        threshold: value,
        version: 1,
      }),
    };
  }
  if (current.threshold !== undefined && current.threshold.equals(value)) {
    return { outcome: "unchanged", record: current };
  }
  return {
    outcome: "changed",
    previous: current,
    record: Object.freeze({ ...current, threshold: value, version: current.version + 1 }),
  };
}

/**
 * ClearLowStockThreshold. No row with expectedVersion 0, or a row already
 * cleared at the expected version, is a no-op; a configured threshold becomes
 * absent and the version increases. The row is kept.
 */
export function decideClearThreshold(props: {
  readonly current: StockThreshold | undefined;
  readonly expectedVersion: number;
  readonly target: Omit<StockThresholdTarget, "stockUnit">;
}): StockThresholdDecision {
  const expectedVersion = parseThresholdExpectedVersion(props.expectedVersion);
  const { current } = props;
  requireTarget(current, props.target);
  requireVersion(current, expectedVersion);
  if (current?.threshold === undefined) {
    return { outcome: "unchanged", record: current };
  }
  return {
    outcome: "changed",
    previous: current,
    record: Object.freeze({
      id: current.id,
      businessId: current.businessId,
      locationId: current.locationId,
      variantId: current.variantId,
      version: current.version + 1,
    }),
  };
}
