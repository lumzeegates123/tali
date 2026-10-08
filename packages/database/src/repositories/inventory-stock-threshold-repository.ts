import type { StockThresholdRepository } from "@tali/application";
import { assertThresholdTransition, ConcurrentModificationError } from "@tali/application";
import type { BusinessId, LocationId, ProductVariantId, StockThreshold } from "@tali/domain";
import { parseStockThresholdId, parseUnitCode, Quantity, restoreStockThreshold } from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

interface ThresholdRow {
  readonly id: string;
  readonly low_stock_threshold_minor: bigint | null;
  readonly version: number;
  readonly stock_unit_code: string;
}

function toThreshold(
  businessId: BusinessId,
  locationId: LocationId,
  variantId: ProductVariantId,
  row: ThresholdRow,
): StockThreshold {
  return restoreStockThreshold({
    id: parseStockThresholdId(row.id),
    businessId,
    locationId,
    variantId,
    ...(row.low_stock_threshold_minor === null
      ? {}
      : { threshold: Quantity.ofMinor(row.low_stock_threshold_minor, parseUnitCode(row.stock_unit_code)) }),
    version: row.version,
  });
}

/**
 * Low-stock thresholds (tenant-owned; ADR-008 section 7.4), one row per stock
 * item. The value is stored in minor units of the variant's stock unit, read
 * from the variant row; the unit cannot change while a threshold is
 * configured. Clearing keeps the row with a NULL value; no row is deleted.
 * The domain carries no timestamps, so created_at and updated_at are the
 * database statement time, with updated_at never before created_at.
 */
export function createInventoryStockThresholdRepository(): StockThresholdRepository {
  return {
    async findForUpdate(scope, businessId, locationId, variantId) {
      const rows = await transactionClient(scope).$queryRaw<ThresholdRow[]>`
        SELECT t.id::text AS id, t.low_stock_threshold_minor, t.version, v.stock_unit_code
        FROM inventory_stock_thresholds t
        JOIN product_variants v ON v.business_id = t.business_id AND v.id = t.variant_id
        WHERE t.business_id = ${businessId}::uuid AND t.location_id = ${locationId}::uuid
          AND t.variant_id = ${variantId}::uuid
        FOR UPDATE OF t`;
      const [row] = rows;
      return row === undefined ? undefined : toThreshold(businessId, locationId, variantId, row);
    },

    async insertIfAbsent(scope, threshold) {
      if (threshold.version !== 1) throw new Error("a new threshold row starts at version 1");
      const rows = await transactionClient(scope).$queryRaw<{ id: string }[]>`
        INSERT INTO inventory_stock_thresholds
          (business_id, id, location_id, variant_id, low_stock_threshold_minor, version, created_at, updated_at)
        VALUES (${threshold.businessId}::uuid, ${threshold.id}::uuid, ${threshold.locationId}::uuid,
                ${threshold.variantId}::uuid, ${threshold.threshold?.amountMinor ?? null}::bigint, 1,
                statement_timestamp(), statement_timestamp())
        ON CONFLICT (business_id, location_id, variant_id) DO NOTHING
        RETURNING id::text AS id`;
      return rows.length === 1 ? "inserted" : "exists";
    },

    async update(scope, previous, next) {
      assertThresholdTransition(previous, next);
      const count = await transactionClient(scope).$executeRaw`
        UPDATE inventory_stock_thresholds
        SET low_stock_threshold_minor = ${next.threshold?.amountMinor ?? null}::bigint, version = ${next.version}::int,
            updated_at = GREATEST(created_at, statement_timestamp())
        WHERE business_id = ${previous.businessId}::uuid AND id = ${previous.id}::uuid
          AND version = ${previous.version}::int`;
      if (count !== 1) throw new ConcurrentModificationError();
    },

    async find(scope, businessId, locationId, variantId) {
      const rows = await transactionClient(scope).$queryRaw<ThresholdRow[]>`
        SELECT t.id::text AS id, t.low_stock_threshold_minor, t.version, v.stock_unit_code
        FROM inventory_stock_thresholds t
        JOIN product_variants v ON v.business_id = t.business_id AND v.id = t.variant_id
        WHERE t.business_id = ${businessId}::uuid AND t.location_id = ${locationId}::uuid
          AND t.variant_id = ${variantId}::uuid`;
      const [row] = rows;
      return row === undefined ? undefined : toThreshold(businessId, locationId, variantId, row);
    },
  };
}
