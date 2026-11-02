import type {
  BusinessId,
  CurrencyCode,
  InventoryMovementId,
  InventoryRecording,
  JournalEntryId,
  LocationId,
  MembershipId,
  PlannedSaleStockEffect,
  PlannedSaleStockReversal,
  ProductVariantId,
  Sale,
  SaleId,
  SaleStockPosition,
} from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { Page, PageRequest } from "../../queries/pagination.js";

/**
 * Tenant-owned sale store. `insert` writes the header, lines and tenders of a
 * sale that already carries its pre-generated original journal id; the journal
 * row follows in the same transaction. `findByIdForUpdate` is the reversal
 * row lock, taken before the variant share locks of the reversal.
 */
export interface SaleRepository {
  insert(scope: TransactionScope, sale: Sale): Promise<void>;
  findById(scope: TransactionScope, businessId: BusinessId, saleId: SaleId): Promise<Sale | undefined>;
  findByIdForUpdate(scope: TransactionScope, businessId: BusinessId, saleId: SaleId): Promise<Sale | undefined>;
  /**
   * Replaces a POSTED sale with its REVERSED form. Only the status and
   * reversal fields change; a sale that is no longer POSTED is a conflict.
   */
  markReversed(scope: TransactionScope, sale: Sale): Promise<void>;
  list(
    scope: TransactionScope,
    businessId: BusinessId,
    query: {
      readonly locationId: LocationId;
      readonly recordedByMembershipId?: MembershipId;
      readonly page: PageRequest;
    },
  ): Promise<Page<Sale>>;
}

/**
 * Business-scoped online receipt numbers (`S-000001`). Issued inside the sale
 * transaction after validation. A rolled-back transaction rolls its counter
 * update back with it (ADR-011 section 8). The PostgreSQL adapter locks the
 * business's `sale_receipt_sequences` row FOR UPDATE, after the stock locks.
 */
export interface SaleReceiptNumberIssuer {
  issue(scope: TransactionScope, businessId: BusinessId): Promise<string>;
}

/** Everything the original SALE movements of one sale are written with. */
export interface SaleStockWrite {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly currency: CurrencyCode;
  readonly saleId: SaleId;
  /** The sale's original SALE_POSTED journal, already posted in this transaction. */
  readonly journalEntryId: JournalEntryId;
  /** The sale's recording envelope: recording membership, device, channel, correlation and server times. */
  readonly recording: InventoryRecording;
  readonly effects: readonly PlannedSaleStockEffect[];
}

/** One planned reversal movement with the id the application generated for it. */
export interface SaleStockReversalStep {
  readonly movementId: InventoryMovementId;
  /** Cost status of the original line: VALUED restores its snapshotted cost, UNVALUED restores none. */
  readonly originalCostStatus: PlannedSaleStockEffect["costStatus"];
  readonly plan: PlannedSaleStockReversal;
}

/** Everything the reversal SALE movements of one sale reversal are written with. */
export interface SaleStockReversalWrite {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly currency: CurrencyCode;
  readonly saleId: SaleId;
  /** The sale's REVERSAL journal, already posted in this transaction. */
  readonly journalEntryId: JournalEntryId;
  /** The reversing actor's envelope and the reversal server times. */
  readonly recording: InventoryRecording;
  readonly reason: string;
  readonly reversals: readonly SaleStockReversalStep[];
}

/**
 * Persistence-neutral stock boundary for sales. It locks and applies an
 * already-decided plan. It does not compute WAC, cost status, or the
 * negative-stock policy.
 *
 * Lock order (ADR-009 section 28): variants FOR SHARE, then balances FOR
 * UPDATE in ascending variant id, then inventory_valuations FOR UPDATE in
 * ascending variant id, then (sales only) the receipt counter FOR UPDATE.
 * `lockForSale` is only the balance and valuation pair; the use case locks
 * variants first and issues the receipt number last. No lock state is kept
 * between calls: the apply methods check the planned versions against the
 * rows they update, inside the same transaction.
 */
export interface SalesInventoryPort {
  lockForSale(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantIds: readonly ProductVariantId[],
  ): Promise<readonly SaleStockPosition[]>;
  applySalePlan(scope: TransactionScope, write: SaleStockWrite): Promise<void>;
  applyReversalPlan(scope: TransactionScope, write: SaleStockReversalWrite): Promise<void>;
}
