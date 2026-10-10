import type {
  Barcode,
  BusinessId,
  CatalogStatus,
  GoodsReceipt,
  GoodsReceiptId,
  InventoryAdjustment,
  InventoryAdjustmentId,
  InventoryMovement,
  InventoryMovementSource,
  LocationId,
  OpeningBatch,
  OpeningBatchId,
  ProductId,
  ProductName,
  ProductVariantId,
  Quantity,
  Sku,
  StockBalance,
  StockThreshold,
  Stocktake,
  StocktakeId,
  StocktakeLine,
  StocktakeStatus,
  UnitCode,
} from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { Page, PageRequest } from "../../queries/pagination.js";
import type { ProductSearch } from "../catalog/index.js";

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
  /**
   * Every movement of exactly one document, originals and reversals:
   * originals first, then reversals, each in ascending variant order.
   */
  listForSource(
    scope: TransactionScope,
    businessId: BusinessId,
    source: InventoryMovementSource,
  ): Promise<readonly InventoryMovement[]>;
  /**
   * One stock item's movement history, newest first (`balance_version`
   * descending, which is total per stock item). `page.after` is the ID of the
   * last movement of the previous page; the page continues below that
   * movement's `balance_version`. The cursor resolves only among the
   * movements of this exact business, location and variant: any other
   * cursor, whoever owns it, returns `undefined` and nothing else. A cursor
   * that resolves but has nothing after it is an empty page.
   */
  listForItem(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantId: ProductVariantId,
    page: PageRequest,
  ): Promise<Page<InventoryMovement> | undefined>;
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

/** A stocktake header with its line counts, read together so a list needs no query per stocktake. */
export interface StocktakeSummary {
  readonly stocktake: Stocktake;
  readonly lineCounts: StocktakeLineCounts;
}

/**
 * The line counts of one stocktake. `nonZeroVariance` and `zeroVariance`
 * count COUNTED lines whose posting variance is stored; only a POSTED
 * stocktake has any.
 */
export interface StocktakeLineCounts {
  readonly counted: number;
  readonly removed: number;
  readonly nonZeroVariance: number;
  readonly zeroVariance: number;
}

export const STOCKTAKE_IN_PROGRESS = "A stocktake is already in progress at this location";

/** Stocktake headers (ADR-008 section 12): at most one DRAFT per business and location. */
export interface StocktakeRepository {
  /**
   * Inserts a new DRAFT version-1 stocktake. Throws
   * `ConflictError(STOCKTAKE_IN_PROGRESS)` when the location already has a
   * DRAFT stocktake (the partial unique index in storage).
   */
  insert(scope: TransactionScope, stocktake: Stocktake): Promise<void>;
  findById(scope: TransactionScope, businessId: BusinessId, id: StocktakeId): Promise<Stocktake | undefined>;
  /** The stocktake of this business, locked FOR UPDATE until the transaction ends. */
  findByIdForUpdate(scope: TransactionScope, businessId: BusinessId, id: StocktakeId): Promise<Stocktake | undefined>;
  /** Stocktakes of one location with their line counts, ordered by stocktake ID ascending. */
  list(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    query: { readonly status?: StocktakeStatus },
    page: PageRequest,
  ): Promise<Page<StocktakeSummary>>;
  /** Throws ConcurrentModificationError when the stored version is no longer `previous.version`. */
  update(scope: TransactionScope, previous: Stocktake, next: Stocktake): Promise<void>;
}

/** The posting variance of one COUNTED line, stored without changing anything else on the line. */
export interface StocktakeLineVariance {
  readonly variantId: ProductVariantId;
  /** The line version the variance was computed from; it is kept, not incremented. */
  readonly lineVersion: number;
  readonly variance: Quantity;
}

/** Stocktake lines, one row per (business, stocktake, variant); REMOVED rows are kept. */
export interface StocktakeLineRepository {
  find(
    scope: TransactionScope,
    businessId: BusinessId,
    stocktakeId: StocktakeId,
    variantId: ProductVariantId,
  ): Promise<StocktakeLine | undefined>;
  /** Inserts a version-1 COUNTED line without a variance. */
  insert(scope: TransactionScope, line: StocktakeLine): Promise<void>;
  /** Throws ConcurrentModificationError when the stored version is no longer `previous.version`. */
  update(scope: TransactionScope, previous: StocktakeLine, next: StocktakeLine): Promise<void>;
  /** The COUNTED lines of a stocktake, ordered by variant ID ascending. */
  listCounted(
    scope: TransactionScope,
    businessId: BusinessId,
    stocktakeId: StocktakeId,
  ): Promise<readonly StocktakeLine[]>;
  /** COUNTED and REMOVED lines, ordered by variant ID ascending; `page.after` is a variant ID. */
  listPage(
    scope: TransactionScope,
    businessId: BusinessId,
    stocktakeId: StocktakeId,
    page: PageRequest,
  ): Promise<Page<StocktakeLine>>;
  /** Every distinct line row of the stocktake, REMOVED included (the 1,000-line bound, decision D9). */
  countForStocktake(scope: TransactionScope, businessId: BusinessId, stocktakeId: StocktakeId): Promise<number>;
  countByStatus(
    scope: TransactionScope,
    businessId: BusinessId,
    stocktakeId: StocktakeId,
  ): Promise<StocktakeLineCounts>;
  /**
   * Stores the posting variance of COUNTED lines. Only the variance column is
   * written: each line must be COUNTED, at `lineVersion` and without a
   * variance, and its version is kept. Any other stored state raises
   * ConcurrentModificationError.
   */
  applyPostingVariances(
    scope: TransactionScope,
    businessId: BusinessId,
    stocktakeId: StocktakeId,
    variances: readonly StocktakeLineVariance[],
  ): Promise<void>;
}

/**
 * One stock item at a location, as the inventory read model sees it: a
 * product's default variant with its balance and low-stock threshold. A
 * missing balance row reads as zero at version 0; a missing threshold row as
 * no threshold at version 0.
 */
export interface InventoryItemRow {
  readonly productId: ProductId;
  readonly variantId: ProductVariantId;
  readonly name: ProductName;
  readonly sku?: Sku;
  readonly barcode?: Barcode;
  readonly productStatus: CatalogStatus;
  readonly stockUnit: UnitCode;
  readonly trackInventory: boolean;
  readonly onHand: Quantity;
  readonly balanceVersion: number;
  readonly threshold?: Quantity;
  readonly thresholdVersion: number;
}

export interface InventoryItemQuery {
  readonly search?: ProductSearch;
  /** Only items whose stored state is low on stock: ACTIVE, tracked, with a threshold at or above on-hand. */
  readonly lowStockOnly?: boolean;
}

/**
 * Inventory list and detail reads across catalog, balances and thresholds,
 * one query each. Rows are scoped to the business, the location's balances
 * and thresholds, and the business's own products.
 */
export interface InventoryItemReader {
  /**
   * Visible stock items ordered by variant ID ascending (`page.after` is a
   * variant ID): tracked ACTIVE items, and tracked ARCHIVED items whose
   * on-hand is not zero. Untracked items are never listed.
   */
  listItems(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    query: InventoryItemQuery,
    page: PageRequest,
  ): Promise<Page<InventoryItemRow>>;
  /** The row of one visible variant of this business, by the listItems rule; undefined for any other variant. */
  getItem(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantId: ProductVariantId,
  ): Promise<InventoryItemRow | undefined>;
}

/** Precondition of StocktakeRepository.update, shared by every adapter. */
export function assertStocktakeTransition(previous: Stocktake, next: Stocktake): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    next.locationId !== previous.locationId ||
    next.createdAt.getTime() !== previous.createdAt.getTime() ||
    next.createdByMembershipId !== previous.createdByMembershipId ||
    next.note !== previous.note ||
    previous.status !== "DRAFT" ||
    next.version !== previous.version + 1
  ) {
    throw new Error("a stocktake update must keep its identity, start from DRAFT and advance its version by one");
  }
}

/** Precondition of StocktakeLineRepository.update, shared by every adapter. */
export function assertStocktakeLineTransition(previous: StocktakeLine, next: StocktakeLine): void {
  if (
    next.businessId !== previous.businessId ||
    next.stocktakeId !== previous.stocktakeId ||
    next.variantId !== previous.variantId ||
    next.version !== previous.version + 1 ||
    previous.variance !== undefined ||
    next.variance !== undefined
  ) {
    throw new Error("a stocktake line update must keep its identity, carry no variance and advance its version by one");
  }
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
