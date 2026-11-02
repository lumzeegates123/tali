import { DomainError } from "../../errors.js";
import type { ProductVariantId } from "../catalog/index.js";
import { allocateProportionalMinor, type InventoryMovementId, type ValuationStatus } from "../inventory/index.js";

/**
 * Build 3 online negative-stock policy (ADR-011 section 17, M15). Every
 * business and product. No merchant override. Kept as a resolver so a later
 * offline rule can differ without rewriting the sale use case.
 */
export const ONLINE_NEGATIVE_STOCK_POLICY = "BLOCK" as const;
export type OnlineNegativeStockPolicy = typeof ONLINE_NEGATIVE_STOCK_POLICY;

export function onlineNegativeStockPolicy(): OnlineNegativeStockPolicy {
  return ONLINE_NEGATIVE_STOCK_POLICY;
}

export const SALE_LINE_COST_STATUSES = ["VALUED", "UNVALUED", "NOT_APPLICABLE"] as const;
export type SaleLineCostStatus = (typeof SALE_LINE_COST_STATUSES)[number];

export const SALE_COST_STATUSES = ["VALUED", "PARTIAL", "UNVALUED", "NOT_APPLICABLE"] as const;
export type SaleCostStatus = (typeof SALE_COST_STATUSES)[number];

/** Locked stock and valuation for one variant. The port does not compute WAC. */
export interface SaleStockPosition {
  readonly variantId: ProductVariantId;
  readonly quantityMinor: bigint;
  readonly balanceVersion: number;
  readonly valuationStatus: ValuationStatus;
  readonly valueMinor: bigint;
  readonly valuationVersion: number;
}

/**
 * One future SALE movement (S5 persists it). One effect per tracked line, in
 * request order, including a second line for the same variant. WAC uses the
 * running on-hand quantity and value after earlier lines.
 */
export interface PlannedSaleStockEffect {
  readonly lineNumber: number;
  readonly movementId: InventoryMovementId;
  readonly variantId: ProductVariantId;
  readonly quantityDeltaMinor: bigint;
  readonly quantityAfterMinor: bigint;
  readonly balanceVersionRead: number;
  readonly nextBalanceVersion: number;
  readonly costStatus: "VALUED" | "UNVALUED";
  /** Positive COGS removed. Absent when UNVALUED. */
  readonly costMinor?: bigint;
  readonly valuationVersionRead: number;
  readonly valueDeltaMinor: bigint;
  readonly nextValueMinor: bigint;
  readonly nextValuationStatus: ValuationStatus;
  readonly nextValuationVersion: number;
}

export interface SaleStockShortage {
  readonly variantId: ProductVariantId;
  readonly availableQuantityMinor: bigint;
}

export type SaleStockPlan =
  | { readonly ok: true; readonly effects: readonly PlannedSaleStockEffect[] }
  | { readonly ok: false; readonly shortages: readonly SaleStockShortage[] };

export interface TrackedSaleLineRequest {
  readonly lineNumber: number;
  readonly variantId: ProductVariantId;
  readonly quantityMinor: bigint;
  readonly movementId: InventoryMovementId;
}

interface RunningPosition {
  quantityMinor: bigint;
  balanceVersion: number;
  valuationStatus: ValuationStatus;
  valueMinor: bigint;
  valuationVersion: number;
  /** On-hand quantity before this sale, used in the shortage detail. */
  availableQuantityMinor: bigint;
}

/**
 * Plans stock and value removal. Does not write. BLOCK rejects the whole sale
 * when any tracked line would make quantity negative. Duplicate variants are
 * applied in line order against the running position (ADR-011 section 14).
 */
export function planSaleStock(
  lines: readonly TrackedSaleLineRequest[],
  positions: ReadonlyMap<ProductVariantId, SaleStockPosition>,
): SaleStockPlan {
  const policy: string = onlineNegativeStockPolicy();
  if (policy !== "BLOCK") {
    throw new DomainError("INVALID_VALUE", "Build 3 online sales only support the BLOCK stock policy", "policy");
  }
  const running = new Map<ProductVariantId, RunningPosition>();
  const shortages = new Map<ProductVariantId, bigint>();
  const effects: PlannedSaleStockEffect[] = [];

  for (const line of lines) {
    if (line.quantityMinor <= 0n) {
      throw new DomainError("INVALID_VALUE", "tracked sale quantity must be positive", "quantity");
    }
    let position = running.get(line.variantId);
    if (position === undefined) {
      const locked = positions.get(line.variantId);
      const quantityMinor = locked?.quantityMinor ?? 0n;
      const valueMinor = locked?.valueMinor ?? 0n;
      if (quantityMinor < 0n || valueMinor < 0n) {
        throw new DomainError("INVALID_VALUE", "sale stock position is outside Build 3 invariants", "quantity");
      }
      position = {
        quantityMinor,
        balanceVersion: locked?.balanceVersion ?? 0,
        valuationStatus: locked?.valuationStatus ?? "UNVALUED",
        valueMinor,
        valuationVersion: locked?.valuationVersion ?? 0,
        availableQuantityMinor: quantityMinor,
      };
      running.set(line.variantId, position);
    }
    if (position.quantityMinor < line.quantityMinor) {
      shortages.set(line.variantId, position.availableQuantityMinor);
      continue;
    }
    const quantityAfterMinor = position.quantityMinor - line.quantityMinor;
    const balanceVersionRead = position.balanceVersion;
    const valuationVersionRead = position.valuationVersion;
    let costMinor: bigint | undefined;
    let valueDeltaMinor = 0n;
    let nextValueMinor = position.valueMinor;
    const nextStatus = position.valuationStatus;
    if (position.valuationStatus === "VALUED") {
      const removed = allocateProportionalMinor(position.valueMinor, line.quantityMinor, position.quantityMinor);
      costMinor = removed;
      valueDeltaMinor = -removed;
      nextValueMinor = position.valueMinor - removed;
    }
    effects.push(
      Object.freeze({
        lineNumber: line.lineNumber,
        movementId: line.movementId,
        variantId: line.variantId,
        quantityDeltaMinor: -line.quantityMinor,
        quantityAfterMinor,
        balanceVersionRead,
        nextBalanceVersion: balanceVersionRead + 1,
        costStatus: position.valuationStatus === "VALUED" ? "VALUED" : "UNVALUED",
        ...(costMinor === undefined ? {} : { costMinor }),
        valuationVersionRead,
        valueDeltaMinor,
        nextValueMinor,
        nextValuationStatus: nextStatus,
        nextValuationVersion: valuationVersionRead + 1,
      }),
    );
    position.quantityMinor = quantityAfterMinor;
    position.balanceVersion += 1;
    position.valueMinor = nextValueMinor;
    position.valuationVersion += 1;
  }

  if (shortages.size > 0) {
    const listed = [...shortages.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([variantId, availableQuantityMinor]) => Object.freeze({ variantId, availableQuantityMinor }));
    return Object.freeze({ ok: false, shortages: Object.freeze(listed) });
  }
  return Object.freeze({ ok: true, effects: Object.freeze(effects) });
}

export type ReversalResidualCase = "NONE" | "B" | "C";

/**
 * ADR-009 section 26.1. A sale reversal adds quantity and a non-negative
 * snapshotted cost, so from a non-negative position it cannot reach case B
 * or C. This classifier exists so a future caller can see that; S4 does not
 * invent a second residual policy.
 */
export function reversalResidualCase(
  quantityAfter: bigint,
  valueAfterMinor: bigint,
  status: ValuationStatus,
): ReversalResidualCase {
  if (valueAfterMinor < 0n) return "B";
  if (status === "VALUED" && quantityAfter === 0n && valueAfterMinor > 0n) return "C";
  return "NONE";
}

export interface PlannedSaleStockReversal {
  readonly lineNumber: number;
  readonly originalMovementId: InventoryMovementId;
  readonly variantId: ProductVariantId;
  readonly quantityDeltaMinor: bigint;
  readonly quantityAfterMinor: bigint;
  readonly valueDeltaMinor: bigint;
  readonly nextValueMinor: bigint;
  readonly nextValuationStatus: ValuationStatus;
  readonly balanceVersionRead: number;
  readonly nextBalanceVersion: number;
  readonly valuationVersionRead: number;
  readonly nextValuationVersion: number;
}

/**
 * Restores each original effect in line order. Value added back is the
 * snapshotted COGS, never the current average. An UNVALUED current projection
 * stays UNVALUED. A negative on-hand or a residual case fails closed.
 */
export function planSaleStockReversal(
  effects: readonly PlannedSaleStockEffect[],
  positions: ReadonlyMap<ProductVariantId, SaleStockPosition>,
): readonly PlannedSaleStockReversal[] {
  const running = new Map<ProductVariantId, RunningPosition>();
  const reversals: PlannedSaleStockReversal[] = [];
  for (const effect of effects) {
    let position = running.get(effect.variantId);
    if (position === undefined) {
      const locked = positions.get(effect.variantId);
      const quantityMinor = locked?.quantityMinor ?? 0n;
      const valueMinor = locked?.valueMinor ?? 0n;
      if (quantityMinor < 0n || valueMinor < 0n) {
        throw new DomainError(
          "INVALID_VALUE",
          "sale reversal stock position is outside Build 3 invariants",
          "quantity",
        );
      }
      position = {
        quantityMinor,
        balanceVersion: locked?.balanceVersion ?? 0,
        valuationStatus: locked?.valuationStatus ?? "UNVALUED",
        valueMinor,
        valuationVersion: locked?.valuationVersion ?? 0,
        availableQuantityMinor: quantityMinor,
      };
      running.set(effect.variantId, position);
    }
    const sold = -effect.quantityDeltaMinor;
    if (sold <= 0n) {
      throw new DomainError("INVALID_VALUE", "a sale stock effect must remove quantity", "quantity");
    }
    const added = effect.costStatus === "VALUED" ? (effect.costMinor ?? 0n) : 0n;
    if (added < 0n) {
      throw new DomainError("INVALID_VALUE", "snapshotted sale cost cannot be negative", "cost");
    }
    const quantityAfterMinor = position.quantityMinor + sold;
    const nextValueMinor = position.valueMinor + added;
    const nextStatus = position.valuationStatus;
    const residual = reversalResidualCase(quantityAfterMinor, nextValueMinor, nextStatus);
    if (residual !== "NONE") {
      throw new DomainError(
        "INVALID_VALUE",
        "a sale reversal reached a residual case outside Build 3 sale invariants",
        "value",
      );
    }
    reversals.push(
      Object.freeze({
        lineNumber: effect.lineNumber,
        originalMovementId: effect.movementId,
        variantId: effect.variantId,
        quantityDeltaMinor: sold,
        quantityAfterMinor,
        valueDeltaMinor: added,
        nextValueMinor,
        nextValuationStatus: nextStatus,
        balanceVersionRead: position.balanceVersion,
        nextBalanceVersion: position.balanceVersion + 1,
        valuationVersionRead: position.valuationVersion,
        nextValuationVersion: position.valuationVersion + 1,
      }),
    );
    position.quantityMinor = quantityAfterMinor;
    position.balanceVersion += 1;
    position.valueMinor = nextValueMinor;
    position.valuationVersion += 1;
  }
  return Object.freeze(reversals);
}

export function aggregateCostStatus(
  lines: readonly { readonly tracked: boolean; readonly costStatus: SaleLineCostStatus }[],
): SaleCostStatus {
  const tracked = lines.filter((line) => line.tracked);
  if (tracked.length === 0) return "NOT_APPLICABLE";
  const valued = tracked.filter((line) => line.costStatus === "VALUED").length;
  if (valued === tracked.length) return "VALUED";
  if (valued === 0) return "UNVALUED";
  return "PARTIAL";
}
