import type {
  BusinessId,
  CurrencyCode,
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
 * Tenant-owned sale store. S4 is in memory. S5 supplies PostgreSQL.
 * `findByIdForUpdate` is the reversal row lock. S5 takes it FOR UPDATE
 * after variant share locks and before stock locks are released, inside the
 * same transaction as the rest of the reversal.
 */
export interface SaleRepository {
  insert(scope: TransactionScope, sale: Sale): Promise<void>;
  findById(scope: TransactionScope, businessId: BusinessId, saleId: SaleId): Promise<Sale | undefined>;
  findByIdForUpdate(scope: TransactionScope, businessId: BusinessId, saleId: SaleId): Promise<Sale | undefined>;
  /** Sets the original journal once. The sale must still be POSTED. */
  attachOriginalJournal(scope: TransactionScope, sale: Sale): Promise<void>;
  /** Replaces a POSTED sale with its REVERSED form. */
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
 * transaction after validation. A rolled-back transaction restores the counter
 * in the in-memory adapter; PostgreSQL gaps from a rolled-back sequence update
 * are acceptable (ADR-011 section 8). S5 maps this to `sale_receipt_sequences`
 * locked FOR UPDATE after stock locks.
 */
export interface SaleReceiptNumberIssuer {
  issue(scope: TransactionScope, businessId: BusinessId): Promise<string>;
}

/**
 * Persistence-neutral stock boundary for sales. It locks and applies an
 * already-decided plan. It does not compute WAC, cost status, or the
 * negative-stock policy.
 *
 * S5 lock order this shape preserves (ADR-009 section 28):
 * variants FOR SHARE, then balances FOR UPDATE in ascending variant id,
 * then inventory_valuations FOR UPDATE in ascending variant id, then the
 * receipt counter FOR UPDATE. `lockForSale` is only the balance and valuation
 * pair; the use case locks variants first and issues the receipt number last.
 */
export interface SalesInventoryPort {
  lockForSale(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    variantIds: readonly ProductVariantId[],
  ): Promise<readonly SaleStockPosition[]>;
  applySalePlan(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    currency: CurrencyCode,
    effects: readonly PlannedSaleStockEffect[],
  ): Promise<void>;
  applyReversalPlan(
    scope: TransactionScope,
    businessId: BusinessId,
    locationId: LocationId,
    currency: CurrencyCode,
    reversals: readonly PlannedSaleStockReversal[],
  ): Promise<void>;
}
