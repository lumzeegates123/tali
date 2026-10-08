import type {
  BusinessId,
  GoodsReceipt,
  GoodsReceiptId,
  InventoryAdjustment,
  InventoryAdjustmentId,
  InventoryMovement,
  InventoryMovementSource,
  LocationId,
  OpeningBatch,
  OpeningBatchId,
  ProductVariantId,
  StockBalance,
  StockThreshold,
} from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";

/**
 * The append-only movement ledger (ADR-008 section 7.1). There is no update
 * or delete. Every method takes the business; another business's movements are
 * never returned.
 */
export interface InventoryMovementRepository {
  /** Appends the movements of one document, in the given (ascending variant) order. */
  insertMany(scope: TransactionScope, movements: readonly InventoryMovement[]): Promise<void>;
  /**
   * The original movements of exactly one document: `reverses_movement_id IS
   * NULL`, ordered by variant ID ascending. A document has one original line
   * per variant, so the order is total. Reversal movements are never included.
   */
  listOriginals(
    scope: TransactionScope,
    businessId: BusinessId,
    source: InventoryMovementSource,
  ): Promise<readonly InventoryMovement[]>;
}

declare const lockedBalancesBrand: unique symbol;

/**
 * Balances locked FOR UPDATE by `StockBalanceRepository.lockForUpdate`, one
 * per requested variant, in ascending variant order (a missing row is created
 * at version 0 first). Only that method produces this type, so a caller cannot
 * update a balance it did not lock, nor lock balances out of order.
 */
export interface LockedBalances {
  readonly [lockedBalancesBrand]: true;
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly balances: readonly StockBalance[];
}

/**
 * Seals locked balances. Called only by `StockBalanceRepository` adapters
 * after they have taken the row locks; use cases never call it.
 */
export function sealLockedBalances(props: {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly balances: readonly StockBalance[];
}): LockedBalances {
  const balances = [...props.balances].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
  return Object.freeze({
    businessId: props.businessId,
    locationId: props.locationId,
    balances: Object.freeze(balances),
  }) as LockedBalances;
}

/** The transactional balance projection (ADR-008 section 7.3), one row per stock item. */
export interface StockBalanceRepository {
  /**
   * Locks the balances of `variantIds` at this business and location FOR
   * UPDATE until the transaction ends, in ascending variant order, creating
   * any missing row at version 0 with quantity 0 in the variant's stock unit.
   * The variants must already be locked FOR SHARE by the caller.
   */
  lockForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantIds: ReadonlySet<ProductVariantId>,
  ): Promise<LockedBalances>;
  /**
   * Writes the next balances of locked stock items. Each row is updated only
   * where its version is still the locked version; any other count raises
   * ConcurrentModificationError (a defensive check: the lock already holds).
   */
  apply(scope: TransactionScope, locked: LockedBalances, next: readonly StockBalance[]): Promise<void>;
  /** The balance of one stock item, without locking; undefined when no row exists. */
  find(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantId: ProductVariantId,
  ): Promise<StockBalance | undefined>;
}

/** Opening-stock headers. Never reversed, so never updated. */
export interface OpeningBatchRepository {
  insert(scope: TransactionScope, batch: OpeningBatch): Promise<void>;
  findById(scope: TransactionScope, businessId: BusinessId, id: OpeningBatchId): Promise<OpeningBatch | undefined>;
}

/** Goods-receipt headers. The only change is POSTED to REVERSED. */
export interface GoodsReceiptRepository {
  insert(scope: TransactionScope, receipt: GoodsReceipt): Promise<void>;
  findById(scope: TransactionScope, businessId: BusinessId, id: GoodsReceiptId): Promise<GoodsReceipt | undefined>;
  /** The receipt of this business, locked FOR UPDATE until the transaction ends. */
  findByIdForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    id: GoodsReceiptId,
  ): Promise<GoodsReceipt | undefined>;
  /**
   * Persists POSTED to REVERSED (the reversal columns only). Throws
   * ConcurrentModificationError when the stored receipt is no longer POSTED.
   */
  markReversed(scope: TransactionScope, previous: GoodsReceipt, next: GoodsReceipt): Promise<void>;
}

/** Adjustment and write-off headers. The only change is POSTED to REVERSED. */
export interface InventoryAdjustmentRepository {
  insert(scope: TransactionScope, adjustment: InventoryAdjustment): Promise<void>;
  findById(
    scope: TransactionScope,
    businessId: BusinessId,
    id: InventoryAdjustmentId,
  ): Promise<InventoryAdjustment | undefined>;
  /** The adjustment of this business, locked FOR UPDATE until the transaction ends. */
  findByIdForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    id: InventoryAdjustmentId,
  ): Promise<InventoryAdjustment | undefined>;
  /**
   * Persists POSTED to REVERSED (the reversal columns only). Throws
   * ConcurrentModificationError when the stored adjustment is no longer POSTED.
   */
  markReversed(scope: TransactionScope, previous: InventoryAdjustment, next: InventoryAdjustment): Promise<void>;
}

/** Low-stock thresholds (ADR-008 section 7.4), one row per stock item, never deleted. */
export interface StockThresholdRepository {
  /** The stock item's threshold row, locked FOR UPDATE until the transaction ends. */
  findForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantId: ProductVariantId,
  ): Promise<StockThreshold | undefined>;
  /**
   * Inserts a version-1 row unless the stock item already has one, without
   * raising: "exists" means a concurrent creator committed first.
   */
  insertIfAbsent(scope: TransactionScope, threshold: StockThreshold): Promise<"inserted" | "exists">;
  /** Throws ConcurrentModificationError when the stored version is no longer `previous.version`. */
  update(scope: TransactionScope, previous: StockThreshold, next: StockThreshold): Promise<void>;
  /** The stock item's threshold row, without locking. */
  find(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantId: ProductVariantId,
  ): Promise<StockThreshold | undefined>;
}

/** Precondition of the markReversed methods, shared by every adapter. */
export function assertDocumentReversal(
  previous: GoodsReceipt | InventoryAdjustment,
  next: GoodsReceipt | InventoryAdjustment,
): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    next.locationId !== previous.locationId ||
    previous.status !== "POSTED" ||
    next.status !== "REVERSED" ||
    next.reversedAt === undefined ||
    next.reversedByMembershipId === undefined ||
    next.reversalReason === undefined
  ) {
    throw new Error("a document reversal must keep its identity and go from POSTED to REVERSED");
  }
}

/** Precondition of StockThresholdRepository.update, shared by every adapter. */
export function assertThresholdTransition(previous: StockThreshold, next: StockThreshold): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    next.locationId !== previous.locationId ||
    next.variantId !== previous.variantId ||
    next.version !== previous.version + 1
  ) {
    throw new Error("a threshold update must keep its identity and advance its version by one");
  }
}
