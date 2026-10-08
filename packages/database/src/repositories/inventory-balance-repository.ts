import type { StockBalanceRepository } from "@tali/application";
import { ConcurrentModificationError, sealLockedBalances } from "@tali/application";
import type { BusinessId, LocationId, StockBalance } from "@tali/domain";
import {
  parseInventoryMovementId,
  parseProductVariantId,
  parseUnitCode,
  Quantity,
  restoreStockBalance,
} from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

interface BalanceRow {
  readonly variant_id: string;
  readonly quantity_minor: bigint;
  readonly version: number;
  readonly last_movement_id: string | null;
  readonly stock_unit_code: string;
}

function toBalance(businessId: BusinessId, locationId: LocationId, row: BalanceRow): StockBalance {
  return restoreStockBalance({
    businessId,
    locationId,
    variantId: parseProductVariantId(row.variant_id),
    quantity: Quantity.ofMinor(row.quantity_minor, parseUnitCode(row.stock_unit_code)),
    version: row.version,
    ...(row.last_movement_id === null ? {} : { lastMovementId: parseInventoryMovementId(row.last_movement_id) }),
  });
}

/**
 * The transactional balance projection (tenant-owned; ADR-008 section 7.3).
 * The quantity is stored in minor units of the variant's stock unit, read
 * from the variant row. Rows are created at version 0 and only ever moved
 * forward by `apply`, one version per movement; no row is deleted.
 */
export function createInventoryBalanceRepository(): StockBalanceRepository {
  return {
    async lockForUpdate(scope, businessId, locationId, variantIds) {
      const ids = [...variantIds].sort();
      if (ids.length === 0) return sealLockedBalances({ businessId, locationId, balances: [] });
      const client = transactionClient(scope);
      await client.$executeRaw`
        INSERT INTO inventory_balances
          (business_id, location_id, variant_id, quantity_minor, version, last_movement_id, updated_at)
        SELECT ${businessId}::uuid, ${locationId}::uuid, requested.variant_id, 0, 0, NULL, statement_timestamp()
        FROM unnest(${ids}::uuid[]) AS requested(variant_id)
        ORDER BY requested.variant_id
        ON CONFLICT (business_id, location_id, variant_id) DO NOTHING`;
      const rows = await client.$queryRaw<BalanceRow[]>`
        SELECT b.variant_id::text AS variant_id, b.quantity_minor, b.version,
               b.last_movement_id::text AS last_movement_id, v.stock_unit_code
        FROM inventory_balances b
        JOIN product_variants v ON v.business_id = b.business_id AND v.id = b.variant_id
        WHERE b.business_id = ${businessId}::uuid AND b.location_id = ${locationId}::uuid
          AND b.variant_id = ANY(${ids}::uuid[])
        ORDER BY b.variant_id
        FOR UPDATE OF b`;
      if (rows.length !== ids.length) throw new Error("every requested balance must exist after it is created");
      return sealLockedBalances({
        businessId,
        locationId,
        balances: rows.map((row) => toBalance(businessId, locationId, row)),
      });
    },

    async apply(scope, locked, next) {
      const client = transactionClient(scope);
      for (const balance of next) {
        const previous = locked.balances.find((candidate) => candidate.variantId === balance.variantId);
        if (
          previous === undefined ||
          balance.businessId !== locked.businessId ||
          balance.locationId !== locked.locationId ||
          balance.quantity.unit !== previous.quantity.unit
        ) {
          throw new Error("only a locked balance can be applied, in its stock unit");
        }
        const count = await client.$executeRaw`
          UPDATE inventory_balances
          SET quantity_minor = ${balance.quantity.amountMinor}::bigint, version = ${balance.version}::int,
              last_movement_id = ${balance.lastMovementId ?? null}::uuid, updated_at = statement_timestamp()
          WHERE business_id = ${locked.businessId}::uuid AND location_id = ${locked.locationId}::uuid
            AND variant_id = ${balance.variantId}::uuid AND version = ${previous.version}::int`;
        if (count !== 1) throw new ConcurrentModificationError();
      }
    },

    async find(scope, businessId, locationId, variantId) {
      const rows = await transactionClient(scope).$queryRaw<BalanceRow[]>`
        SELECT b.variant_id::text AS variant_id, b.quantity_minor, b.version,
               b.last_movement_id::text AS last_movement_id, v.stock_unit_code
        FROM inventory_balances b
        JOIN product_variants v ON v.business_id = b.business_id AND v.id = b.variant_id
        WHERE b.business_id = ${businessId}::uuid AND b.location_id = ${locationId}::uuid
          AND b.variant_id = ${variantId}::uuid`;
      const [row] = rows;
      return row === undefined ? undefined : toBalance(businessId, locationId, row);
    },
  };
}
