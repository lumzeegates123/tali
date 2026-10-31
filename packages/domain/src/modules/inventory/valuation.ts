import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";
import { divideAndRound, RoundingMode } from "../../kernel/rounding.js";
import type { BusinessId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import type { InventoryRecording } from "./common.js";
import type { InventoryMovementId, StockValuationId } from "./ids.js";
import { parseInventoryMovementId, parseStockValuationId } from "./ids.js";

export const VALUATION_STATUSES = ["VALUED", "UNVALUED"] as const;
export type ValuationStatus = (typeof VALUATION_STATUSES)[number];

export const MOVEMENT_COST_BASES = ["SUPPLIED_COST", "WEIGHTED_AVERAGE", "REVERSAL_OF_ORIGINAL", "NOT_VALUED"] as const;
export type MovementCostBasis = (typeof MOVEMENT_COST_BASES)[number];

export const STOCK_VALUATION_KINDS = ["INITIAL_OPENING", "OPERATIONAL", "REVERSAL_RESIDUAL"] as const;
export type StockValuationKind = (typeof STOCK_VALUATION_KINDS)[number];

export function parseValuationStatus(value: string): ValuationStatus {
  if (!(VALUATION_STATUSES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown valuation status", "status");
  }
  return value as ValuationStatus;
}

export function parseMovementCostBasis(value: string): MovementCostBasis {
  if (!(MOVEMENT_COST_BASES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown movement cost basis", "costBasis");
  }
  return value as MovementCostBasis;
}

export function parseStockValuationKind(value: string): StockValuationKind {
  if (!(STOCK_VALUATION_KINDS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown stock valuation kind", "kind");
  }
  return value as StockValuationKind;
}

/**
 * HALF_EVEN share of `valueMinor` for `takenQuantity` of `onHandQuantity`.
 * When the taken quantity is the whole on-hand quantity, the entire value is
 * returned so a remaining minor unit is never stranded (ADR-009 section 18).
 */
export function allocateProportionalMinor(valueMinor: bigint, takenQuantity: bigint, onHandQuantity: bigint): bigint {
  if (takenQuantity < 0n || onHandQuantity < 0n) {
    throw new DomainError("INVALID_VALUE", "quantities for WAC allocation must be non-negative", "quantity");
  }
  if (takenQuantity === 0n) return 0n;
  if (onHandQuantity === 0n) {
    throw new DomainError("INVALID_VALUE", "cannot allocate value from zero on-hand quantity", "quantity");
  }
  if (takenQuantity > onHandQuantity) {
    throw new DomainError("INVALID_VALUE", "allocated quantity cannot exceed on-hand quantity", "quantity");
  }
  if (takenQuantity === onHandQuantity) return valueMinor;
  return divideAndRound(valueMinor * takenQuantity, onHandQuantity, RoundingMode.HALF_EVEN);
}

/** Logical valuation of a stock item when no projection row exists: UNVALUED, value 0. */
export interface InventoryValuationState {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly status: ValuationStatus;
  readonly value: Money;
  readonly firstValuedAt: Date | undefined;
  readonly version: number;
  /** Balance version snapshot when the projection was first created; 0 if never persisted. */
  readonly startedFromBalanceVersion: number;
}

export function emptyInventoryValuation(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly currency: CurrencyCode;
}): InventoryValuationState {
  return Object.freeze({
    businessId: props.businessId,
    locationId: props.locationId,
    variantId: props.variantId,
    status: "UNVALUED",
    value: Money.zero(props.currency),
    firstValuedAt: undefined,
    version: 0,
    startedFromBalanceVersion: 0,
  });
}

export function hasEverBeenValued(state: InventoryValuationState): boolean {
  return state.firstValuedAt !== undefined || state.status === "VALUED";
}

export interface InventoryMovementValuation {
  readonly businessId: BusinessId;
  readonly movementId: InventoryMovementId;
  readonly costBasis: MovementCostBasis;
  readonly valueDeltaMinor: bigint;
  readonly valueAfter: Money;
  readonly statusAfter: ValuationStatus;
  readonly suppliedCostMinor: bigint | undefined;
  readonly journalEntryId: string | undefined;
}

export interface StockValuationDocument extends InventoryRecording {
  readonly id: StockValuationId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly variantId: ProductVariantId;
  readonly kind: StockValuationKind;
  /** Required for REVERSAL_RESIDUAL; forbidden for user-recorded kinds. */
  readonly triggerMovementId?: InventoryMovementId;
  readonly quantityAtValuationMinor: bigint;
  readonly balanceVersionAtValuation: number;
  readonly previousValue: Money;
  readonly newValue: Money;
  readonly reason: string;
  readonly journalEntryId: string | undefined;
}

export function restoreStockValuationId(value: string): StockValuationId {
  return parseStockValuationId(value);
}

export function restoreTriggerMovementId(value: string): InventoryMovementId {
  return parseInventoryMovementId(value);
}

/**
 * Fail-closed restore of a persisted stock valuation. REVERSAL_RESIDUAL is
 * domain-generated only: it requires a trigger movement and a zero new value.
 * User kinds never carry a trigger and never store a negative previous value.
 */
export function restoreStockValuation(document: StockValuationDocument): StockValuationDocument {
  const kind = parseStockValuationKind(document.kind);
  if (kind === "REVERSAL_RESIDUAL") {
    if (document.triggerMovementId === undefined) {
      throw new DomainError("INVALID_VALUE", "a reversal residual requires a trigger movement", "triggerMovementId");
    }
    if (!document.newValue.isZero()) {
      throw new DomainError("INVALID_VALUE", "a reversal residual must set new value to zero", "newValue");
    }
  } else if (document.triggerMovementId !== undefined) {
    throw new DomainError("INVALID_VALUE", "only a reversal residual may name a trigger movement", "triggerMovementId");
  }
  if (kind !== "REVERSAL_RESIDUAL" && document.previousValue.isNegative()) {
    throw new DomainError("INVALID_VALUE", "previous value cannot be negative", "previousValue");
  }
  if (document.newValue.isNegative()) {
    throw new DomainError("INVALID_VALUE", "new value cannot be negative", "newValue");
  }
  return Object.freeze({
    ...document,
    kind,
    ...(document.triggerMovementId === undefined ? {} : { triggerMovementId: document.triggerMovementId }),
  });
}

/** Next projection version after any valuation write (gap-free, starts at 1). */
export function nextValuationVersion(current: InventoryValuationState): number {
  return current.version + 1;
}
