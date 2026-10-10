import type {
  BusinessDate,
  InventoryNote,
  LocationId,
  ProductVariantId,
  Quantity,
  Stocktake,
  StocktakeId,
  StocktakeLine,
  StocktakeLineStatus,
  StocktakeStatus,
  UnitCode,
} from "@tali/domain";
import type { PermissionSet } from "../../authorization/permissions.js";
import { hasPermission } from "../../authorization/permissions.js";
import { inventoryPermissions } from "../identity/index.js";
import type { StocktakeLineCounts } from "./ports.js";

/**
 * FULL shows what the system expected and the variance; BLIND hides them so
 * a counter is not anchored by the expected quantity (ADR-008 section 12.3).
 */
export type StocktakeVisibility = "FULL" | "BLIND";

/**
 * The single rule for stocktake visibility: FULL with `inventory:count-post`,
 * otherwise BLIND. Every stocktake mutation and query passes its context's
 * permissions; visibility never depends on the membership role.
 */
export function stocktakeVisibilityFor(permissions: PermissionSet): StocktakeVisibility {
  return hasPermission(permissions, inventoryPermissions.permissions["inventory:count-post"]) ? "FULL" : "BLIND";
}

/** Posting totals; present only on a POSTED stocktake. */
export interface StocktakePostingSummary {
  readonly correctionMovementCount: number;
  readonly zeroVarianceCount: number;
}

/**
 * A stocktake header. Line counts are not hidden in BLIND: they reveal no
 * expected quantity or variance.
 */
export interface StocktakeView {
  readonly visibility: StocktakeVisibility;
  readonly stocktakeId: StocktakeId;
  readonly locationId: LocationId;
  readonly status: StocktakeStatus;
  readonly version: number;
  readonly note?: InventoryNote;
  readonly createdAt: Date;
  readonly postedAt?: Date;
  readonly businessDate?: BusinessDate;
  readonly cancelledAt?: Date;
  readonly countedLineCount: number;
  readonly posting?: StocktakePostingSummary;
}

interface StocktakeLineViewBase {
  readonly variantId: ProductVariantId;
  readonly status: StocktakeLineStatus;
  readonly countedQuantity: Quantity;
  readonly stockUnit: UnitCode;
  readonly version: number;
  readonly countedAt: Date;
}

/** A line without the expected quantity or variance: the keys do not exist. */
export interface BlindStocktakeLineView extends StocktakeLineViewBase {
  readonly visibility: "BLIND";
}

/** `variance` is present on COUNTED lines of a POSTED stocktake only. */
export interface FullStocktakeLineView extends StocktakeLineViewBase {
  readonly visibility: "FULL";
  readonly expectedAtCount: Quantity;
  readonly variance?: Quantity;
}

export type StocktakeLineView = BlindStocktakeLineView | FullStocktakeLineView;

/**
 * Builds a stocktake header view. Stored line counts that contradict the
 * stocktake's status are corruption and fail loudly: a POSTED stocktake has a
 * variance on every COUNTED line, any other has none.
 */
export function stocktakeView(
  stocktake: Stocktake,
  counts: StocktakeLineCounts,
  visibility: StocktakeVisibility,
): StocktakeView {
  const withVariance = counts.nonZeroVariance + counts.zeroVariance;
  if (stocktake.status === "POSTED" ? withVariance !== counts.counted : withVariance !== 0) {
    throw new Error("stored stocktake line variances do not match the stocktake status");
  }
  return Object.freeze({
    visibility,
    stocktakeId: stocktake.id,
    locationId: stocktake.locationId,
    status: stocktake.status,
    version: stocktake.version,
    ...(stocktake.note === undefined ? {} : { note: stocktake.note }),
    createdAt: stocktake.createdAt,
    ...(stocktake.postedAt === undefined ? {} : { postedAt: stocktake.postedAt }),
    ...(stocktake.businessDate === undefined ? {} : { businessDate: stocktake.businessDate }),
    ...(stocktake.cancelledAt === undefined ? {} : { cancelledAt: stocktake.cancelledAt }),
    countedLineCount: counts.counted,
    ...(stocktake.status === "POSTED"
      ? {
          posting: Object.freeze({
            correctionMovementCount: counts.nonZeroVariance,
            zeroVarianceCount: counts.zeroVariance,
          }),
        }
      : {}),
  });
}

/** Builds a line view; a variance that contradicts the stocktake's status is corruption and fails loudly. */
export function stocktakeLineView(
  stocktake: Stocktake,
  line: StocktakeLine,
  visibility: StocktakeVisibility,
): StocktakeLineView {
  if (line.businessId !== stocktake.businessId || line.stocktakeId !== stocktake.id) {
    throw new Error("a stocktake line view needs the line's own stocktake");
  }
  const varianceExpected = stocktake.status === "POSTED" && line.status === "COUNTED";
  if (varianceExpected !== (line.variance !== undefined)) {
    throw new Error("a stored stocktake line variance does not match the stocktake status");
  }
  const base = {
    variantId: line.variantId,
    status: line.status,
    countedQuantity: line.countedQuantity,
    stockUnit: line.stockUnitAtCount,
    version: line.version,
    countedAt: line.countedAt,
  };
  if (visibility === "BLIND") return Object.freeze({ visibility, ...base });
  return Object.freeze({
    visibility,
    ...base,
    expectedAtCount: line.expectedAtCount,
    ...(line.variance === undefined ? {} : { variance: line.variance }),
  });
}
