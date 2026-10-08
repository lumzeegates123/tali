import type { VariantInventoryStateReader } from "@tali/application";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

/**
 * The inventory facts the catalog guards depend on (ADR-008 section 3.2), for
 * the whole business across every location, in one statement. UpdateProduct
 * reads them while it holds the variant FOR UPDATE, and every stock or
 * threshold writer holds the variant FOR SHARE until it commits, so at read
 * committed every committed movement, balance and threshold is visible here.
 * A cleared threshold (NULL value) is not configured.
 */
export function createVariantInventoryStateReader(): VariantInventoryStateReader {
  return {
    async stateOf(scope, businessId, variantId) {
      const rows = await transactionClient(scope).$queryRaw<
        { has_movements: boolean; has_non_zero_balance: boolean; has_configured_threshold: boolean }[]
      >`
        SELECT
          EXISTS (SELECT 1 FROM inventory_movements
                  WHERE business_id = ${businessId}::uuid AND variant_id = ${variantId}::uuid) AS has_movements,
          EXISTS (SELECT 1 FROM inventory_balances
                  WHERE business_id = ${businessId}::uuid AND variant_id = ${variantId}::uuid
                    AND quantity_minor <> 0) AS has_non_zero_balance,
          EXISTS (SELECT 1 FROM inventory_stock_thresholds
                  WHERE business_id = ${businessId}::uuid AND variant_id = ${variantId}::uuid
                    AND low_stock_threshold_minor IS NOT NULL) AS has_configured_threshold`;
      const [row] = rows;
      if (row === undefined) throw new Error("the inventory state query returns exactly one row");
      return Object.freeze({
        hasMovements: row.has_movements,
        hasNonZeroBalance: row.has_non_zero_balance,
        hasConfiguredThreshold: row.has_configured_threshold,
      });
    },
  };
}
