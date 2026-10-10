import { DomainError } from "../../errors.js";
import type { UnitCode } from "../../kernel/index.js";
import { BusinessDate, KernelError, Quantity } from "../../kernel/index.js";
import type { BusinessId, MembershipId } from "../business/index.js";
import type { ProductVariantId } from "../catalog/index.js";
import type { LocationId } from "../location/index.js";
import type { InventoryNote } from "./common.js";
import {
  MAX_STOCKTAKE_LINES,
  parseInventoryNote,
  validInstant,
  validNonNegativeVersion,
  validPositiveVersion,
} from "./common.js";
import type { StocktakeId } from "./ids.js";

export const STOCKTAKE_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;
export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];

export const STOCKTAKE_LINE_STATUSES = ["COUNTED", "REMOVED"] as const;
export type StocktakeLineStatus = (typeof STOCKTAKE_LINE_STATUSES)[number];

export function parseStocktakeStatus(value: string): StocktakeStatus {
  if (!(STOCKTAKE_STATUSES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown stocktake status", "status");
  }
  return value as StocktakeStatus;
}

export function parseStocktakeLineStatus(value: string): StocktakeLineStatus {
  if (!(STOCKTAKE_LINE_STATUSES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown stocktake line status", "status");
  }
  return value as StocktakeLineStatus;
}

/**
 * A location-scoped stocktake header (ADR-008 section 12). Lines are a
 * separate entity keyed by (businessId, stocktakeId, variantId).
 */
export interface Stocktake {
  readonly businessId: BusinessId;
  readonly id: StocktakeId;
  readonly locationId: LocationId;
  readonly status: StocktakeStatus;
  readonly version: number;
  readonly note?: InventoryNote;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
  readonly postedByMembershipId?: MembershipId;
  readonly postedAt?: Date;
  readonly businessDate?: BusinessDate;
  readonly cancelledByMembershipId?: MembershipId;
  readonly cancelledAt?: Date;
}

export interface StocktakeLine {
  readonly businessId: BusinessId;
  readonly stocktakeId: StocktakeId;
  readonly variantId: ProductVariantId;
  readonly status: StocktakeLineStatus;
  readonly countedQuantity: Quantity;
  readonly stockUnitAtCount: UnitCode;
  readonly expectedAtCount: Quantity;
  readonly balanceVersionAtCount: number;
  readonly version: number;
  readonly countedByMembershipId: MembershipId;
  readonly countedAt: Date;
  readonly variance?: Quantity;
}

export interface StocktakeLineDecision {
  readonly stocktake: Stocktake;
  readonly line: StocktakeLine;
  readonly changed: boolean;
}

export interface StocktakeHeaderDecision {
  readonly stocktake: Stocktake;
  readonly changed: boolean;
}

function requireQuantity(value: unknown, field: string): Quantity {
  if (!(value instanceof Quantity)) {
    throw new DomainError("INVALID_VALUE", `${field} must be a Quantity`, field);
  }
  return value;
}

function requireSameUnit(quantity: Quantity, unit: UnitCode, field: string): void {
  if (quantity.unit !== unit) {
    throw new KernelError("UNIT_MISMATCH", `${field} must be in the stock unit ${unit}, not ${quantity.unit}`);
  }
}

function requireDraft(stocktake: Stocktake, action: string): void {
  if (stocktake.status !== "DRAFT") {
    throw new DomainError("INVALID_TRANSITION", `only a DRAFT stocktake can be ${action}`, "status");
  }
}

function requireStocktakeExpectedVersion(stocktake: Stocktake, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) {
    throw new DomainError("INVALID_VALUE", "expectedVersion is required", "expectedVersion");
  }
  const expected = validPositiveVersion(expectedVersion, "expectedVersion");
  if (stocktake.version !== expected) {
    throw new DomainError("VERSION_CONFLICT", "the stocktake has changed since it was read", "expectedVersion");
  }
}

function requireLineExpectedVersion(line: StocktakeLine, expectedVersion: number | undefined): void {
  if (expectedVersion === undefined) {
    throw new DomainError("INVALID_VALUE", "expectedVersion is required", "expectedVersion");
  }
  const expected = validPositiveVersion(expectedVersion, "expectedVersion");
  if (line.version !== expected) {
    throw new DomainError("VERSION_CONFLICT", "the stocktake line has changed since it was read", "expectedVersion");
  }
}

function requireLineBelongsTo(stocktake: Stocktake, line: StocktakeLine, variantId?: ProductVariantId): void {
  if (line.businessId !== stocktake.businessId || line.stocktakeId !== stocktake.id) {
    throw new DomainError("INVALID_VALUE", "the line belongs to a different stocktake", "line");
  }
  if (variantId !== undefined && line.variantId !== variantId) {
    throw new DomainError("INVALID_VALUE", "the line belongs to a different product", "variantId");
  }
}

function draftIdentity(stocktake: Stocktake) {
  return {
    businessId: stocktake.businessId,
    id: stocktake.id,
    locationId: stocktake.locationId,
    ...(stocktake.note === undefined ? {} : { note: stocktake.note }),
    createdByMembershipId: stocktake.createdByMembershipId,
    createdAt: stocktake.createdAt,
  };
}

function bumpDraft(stocktake: Stocktake): Stocktake {
  return restoreStocktake({
    ...draftIdentity(stocktake),
    status: "DRAFT",
    version: stocktake.version + 1,
  });
}

export function restoreStocktake(props: {
  readonly businessId: BusinessId;
  readonly id: StocktakeId;
  readonly locationId: LocationId;
  readonly status: string;
  readonly version: number;
  readonly note?: string | undefined;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
  readonly postedByMembershipId?: MembershipId | undefined;
  readonly postedAt?: Date | undefined;
  readonly businessDate?: BusinessDate | undefined;
  readonly cancelledByMembershipId?: MembershipId | undefined;
  readonly cancelledAt?: Date | undefined;
}): Stocktake {
  const status = parseStocktakeStatus(props.status);
  const version = validPositiveVersion(props.version, "version");
  const createdAt = validInstant(props.createdAt, "createdAt");
  const postedSet = [props.postedByMembershipId, props.postedAt, props.businessDate].filter(
    (value) => value !== undefined,
  ).length;
  const cancelledSet = [props.cancelledByMembershipId, props.cancelledAt].filter((value) => value !== undefined).length;
  const shapeHolds =
    (status === "DRAFT" && postedSet === 0 && cancelledSet === 0) ||
    (status === "POSTED" && postedSet === 3 && cancelledSet === 0) ||
    (status === "CANCELLED" && postedSet === 0 && cancelledSet === 2);
  if (!shapeHolds) {
    throw new DomainError("INVALID_VALUE", "stocktake lifecycle columns do not match its status", "status");
  }
  if (status === "POSTED") {
    if (!(props.businessDate instanceof BusinessDate)) {
      throw new DomainError("INVALID_VALUE", "businessDate must be a BusinessDate", "businessDate");
    }
    const postedAt = validInstant(props.postedAt as Date, "postedAt");
    if (postedAt.getTime() < createdAt.getTime()) {
      throw new DomainError("INVALID_VALUE", "postedAt cannot precede createdAt", "postedAt");
    }
    return Object.freeze({
      businessId: props.businessId,
      id: props.id,
      locationId: props.locationId,
      status,
      version,
      ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
      createdByMembershipId: props.createdByMembershipId,
      createdAt,
      postedByMembershipId: props.postedByMembershipId as MembershipId,
      postedAt,
      businessDate: props.businessDate,
    });
  }
  if (status === "CANCELLED") {
    const cancelledAt = validInstant(props.cancelledAt as Date, "cancelledAt");
    if (cancelledAt.getTime() < createdAt.getTime()) {
      throw new DomainError("INVALID_VALUE", "cancelledAt cannot precede createdAt", "cancelledAt");
    }
    return Object.freeze({
      businessId: props.businessId,
      id: props.id,
      locationId: props.locationId,
      status,
      version,
      ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
      createdByMembershipId: props.createdByMembershipId,
      createdAt,
      cancelledByMembershipId: props.cancelledByMembershipId as MembershipId,
      cancelledAt,
    });
  }
  return Object.freeze({
    businessId: props.businessId,
    id: props.id,
    locationId: props.locationId,
    status,
    version,
    ...(props.note === undefined ? {} : { note: parseInventoryNote(props.note) }),
    createdByMembershipId: props.createdByMembershipId,
    createdAt,
  });
}

export function startStocktake(props: {
  readonly id: StocktakeId;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly note?: string | undefined;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
}): Stocktake {
  return restoreStocktake({
    businessId: props.businessId,
    id: props.id,
    locationId: props.locationId,
    status: "DRAFT",
    version: 1,
    ...(props.note === undefined ? {} : { note: props.note }),
    createdByMembershipId: props.createdByMembershipId,
    createdAt: props.createdAt,
  });
}

export function restoreStocktakeLine(props: {
  readonly businessId: BusinessId;
  readonly stocktakeId: StocktakeId;
  readonly variantId: ProductVariantId;
  readonly status: string;
  readonly countedQuantity: Quantity;
  readonly stockUnitAtCount: UnitCode;
  readonly expectedAtCount: Quantity;
  readonly balanceVersionAtCount: number;
  readonly version: number;
  readonly countedByMembershipId: MembershipId;
  readonly countedAt: Date;
  readonly variance?: Quantity | undefined;
}): StocktakeLine {
  const status = parseStocktakeLineStatus(props.status);
  const countedQuantity = requireQuantity(props.countedQuantity, "countedQuantity");
  const expectedAtCount = requireQuantity(props.expectedAtCount, "expectedAtCount");
  if (countedQuantity.isNegative()) {
    throw new DomainError("INVALID_VALUE", "counted quantity cannot be negative", "countedQuantity");
  }
  requireSameUnit(countedQuantity, props.stockUnitAtCount, "countedQuantity");
  requireSameUnit(expectedAtCount, props.stockUnitAtCount, "expectedAtCount");
  let variance: Quantity | undefined;
  if (props.variance !== undefined) {
    if (status !== "COUNTED") {
      throw new DomainError("INVALID_VALUE", "only a COUNTED line may carry a variance", "variance");
    }
    variance = requireQuantity(props.variance, "variance");
    requireSameUnit(variance, props.stockUnitAtCount, "variance");
  }
  return Object.freeze({
    businessId: props.businessId,
    stocktakeId: props.stocktakeId,
    variantId: props.variantId,
    status,
    countedQuantity,
    stockUnitAtCount: props.stockUnitAtCount,
    expectedAtCount,
    balanceVersionAtCount: validNonNegativeVersion(props.balanceVersionAtCount, "balanceVersionAtCount"),
    version: validPositiveVersion(props.version, "version"),
    countedByMembershipId: props.countedByMembershipId,
    countedAt: validInstant(props.countedAt, "countedAt"),
    ...(variance === undefined ? {} : { variance }),
  });
}

/**
 * Records or recaptures one counted quantity on a DRAFT stocktake.
 * expectedVersion is the line version the caller read: 0 (or absent) for no
 * line, so any mismatch with the stored line, including a line created
 * concurrently, is VERSION_CONFLICT. A new distinct line is version 1; an
 * existing line (COUNTED or REMOVED), when the captured state changes,
 * increments both versions. Recounting REMOVED reuses the same row.
 */
export function decideRecordStocktakeCount(props: {
  readonly stocktake: Stocktake;
  readonly current: StocktakeLine | undefined;
  readonly currentDistinctLineCount: number;
  readonly variantId: ProductVariantId;
  readonly counted: Quantity;
  readonly stockUnit: UnitCode;
  readonly expectedOnHand: Quantity;
  readonly balanceVersion: number;
  readonly actorMembershipId: MembershipId;
  readonly now: Date;
  readonly expectedVersion?: number | undefined;
}): StocktakeLineDecision {
  requireDraft(props.stocktake, "counted");
  const counted = requireQuantity(props.counted, "countedQuantity");
  const expectedOnHand = requireQuantity(props.expectedOnHand, "expectedAtCount");
  if (counted.isNegative()) {
    throw new DomainError("INVALID_VALUE", "counted quantity cannot be negative", "countedQuantity");
  }
  requireSameUnit(counted, props.stockUnit, "countedQuantity");
  requireSameUnit(expectedOnHand, props.stockUnit, "expectedAtCount");
  const balanceVersion = validNonNegativeVersion(props.balanceVersion, "balanceVersionAtCount");
  const now = validInstant(props.now, "countedAt");
  const distinct = validNonNegativeVersion(props.currentDistinctLineCount, "currentDistinctLineCount");
  const expected =
    props.expectedVersion === undefined ? 0 : validNonNegativeVersion(props.expectedVersion, "expectedVersion");
  if (props.current !== undefined) requireLineBelongsTo(props.stocktake, props.current, props.variantId);
  if (expected !== (props.current?.version ?? 0)) {
    throw new DomainError("VERSION_CONFLICT", "the stocktake line has changed since it was read", "expectedVersion");
  }

  if (props.current === undefined) {
    if (distinct >= MAX_STOCKTAKE_LINES) {
      throw new DomainError("INVALID_VALUE", `a stocktake has at most ${MAX_STOCKTAKE_LINES} lines`, "lines");
    }
    return {
      stocktake: bumpDraft(props.stocktake),
      line: restoreStocktakeLine({
        businessId: props.stocktake.businessId,
        stocktakeId: props.stocktake.id,
        variantId: props.variantId,
        status: "COUNTED",
        countedQuantity: counted,
        stockUnitAtCount: props.stockUnit,
        expectedAtCount: expectedOnHand,
        balanceVersionAtCount: balanceVersion,
        version: 1,
        countedByMembershipId: props.actorMembershipId,
        countedAt: now,
      }),
      changed: true,
    };
  }

  if (
    props.current.status === "COUNTED" &&
    props.current.countedQuantity.equals(counted) &&
    props.current.expectedAtCount.equals(expectedOnHand) &&
    props.current.balanceVersionAtCount === balanceVersion &&
    props.current.stockUnitAtCount === props.stockUnit
  ) {
    return { stocktake: props.stocktake, line: props.current, changed: false };
  }
  return {
    stocktake: bumpDraft(props.stocktake),
    line: restoreStocktakeLine({
      businessId: props.current.businessId,
      stocktakeId: props.current.stocktakeId,
      variantId: props.current.variantId,
      status: "COUNTED",
      countedQuantity: counted,
      stockUnitAtCount: props.stockUnit,
      expectedAtCount: expectedOnHand,
      balanceVersionAtCount: balanceVersion,
      version: props.current.version + 1,
      countedByMembershipId: props.actorMembershipId,
      countedAt: now,
    }),
    changed: true,
  };
}

/**
 * Marks a mistaken COUNTED line REMOVED. An already REMOVED line is a
 * successful no-op before any version check. Historical count fields are kept.
 */
export function decideRemoveStocktakeLine(props: {
  readonly stocktake: Stocktake;
  readonly line: StocktakeLine;
  readonly expectedVersion?: number | undefined;
}): StocktakeLineDecision {
  requireDraft(props.stocktake, "edited");
  requireLineBelongsTo(props.stocktake, props.line);
  if (props.line.status === "REMOVED") {
    return { stocktake: props.stocktake, line: props.line, changed: false };
  }
  requireLineExpectedVersion(props.line, props.expectedVersion);
  return {
    stocktake: bumpDraft(props.stocktake),
    line: restoreStocktakeLine({
      businessId: props.line.businessId,
      stocktakeId: props.line.stocktakeId,
      variantId: props.line.variantId,
      status: "REMOVED",
      countedQuantity: props.line.countedQuantity,
      stockUnitAtCount: props.line.stockUnitAtCount,
      expectedAtCount: props.line.expectedAtCount,
      balanceVersionAtCount: props.line.balanceVersionAtCount,
      version: props.line.version + 1,
      countedByMembershipId: props.line.countedByMembershipId,
      countedAt: props.line.countedAt,
    }),
    changed: true,
  };
}

/**
 * Header-only post decision (ADR-008 section 12.4). POSTED is a no-op that
 * ignores expectedVersion. Staleness and variance application are not decided
 * here: they belong to the application and planCountCorrections.
 */
export function decidePostStocktake(props: {
  readonly stocktake: Stocktake;
  readonly countedLineCount: number;
  readonly postedByMembershipId: MembershipId;
  readonly postedAt: Date;
  readonly businessDate: BusinessDate;
  readonly expectedVersion?: number | undefined;
}): StocktakeHeaderDecision {
  if (props.stocktake.status === "POSTED") {
    return { stocktake: props.stocktake, changed: false };
  }
  if (props.stocktake.status === "CANCELLED") {
    throw new DomainError("INVALID_TRANSITION", "a cancelled stocktake cannot be posted", "status");
  }
  requireStocktakeExpectedVersion(props.stocktake, props.expectedVersion);
  const countedLineCount = validNonNegativeVersion(props.countedLineCount, "countedLineCount");
  if (countedLineCount < 1) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "a stocktake with no counted lines cannot be posted",
      "countedLineCount",
    );
  }
  return {
    stocktake: restoreStocktake({
      ...draftIdentity(props.stocktake),
      status: "POSTED",
      version: props.stocktake.version + 1,
      postedByMembershipId: props.postedByMembershipId,
      postedAt: props.postedAt,
      businessDate: props.businessDate,
    }),
    changed: true,
  };
}

/** Header-only cancel decision. CANCELLED is a no-op that ignores expectedVersion. */
export function decideCancelStocktake(props: {
  readonly stocktake: Stocktake;
  readonly cancelledByMembershipId: MembershipId;
  readonly cancelledAt: Date;
  readonly expectedVersion?: number | undefined;
}): StocktakeHeaderDecision {
  if (props.stocktake.status === "CANCELLED") {
    return { stocktake: props.stocktake, changed: false };
  }
  if (props.stocktake.status === "POSTED") {
    throw new DomainError("INVALID_TRANSITION", "a posted stocktake cannot be cancelled", "status");
  }
  requireStocktakeExpectedVersion(props.stocktake, props.expectedVersion);
  return {
    stocktake: restoreStocktake({
      ...draftIdentity(props.stocktake),
      status: "CANCELLED",
      version: props.stocktake.version + 1,
      cancelledByMembershipId: props.cancelledByMembershipId,
      cancelledAt: props.cancelledAt,
    }),
    changed: true,
  };
}
