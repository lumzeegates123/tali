/*
 * The inventory consistency check (ADR-008 section 7.3; plan section T). A
 * read-only query that compares every stock item's balance row with its
 * movement ledger. It never repairs anything. Shared by the test helper and
 * the operator script (`scripts/check-inventory-consistency.mjs`, run with
 * Node's type stripping), so this file has no imports and only erasable
 * TypeScript syntax.
 *
 * A balance at version 0 with quantity 0 and no movements is consistent.
 */

export const INVENTORY_CONSISTENCY_KINDS = [
  "BALANCE_QUANTITY_MISMATCH",
  "BALANCE_VERSION_MISMATCH",
  "VERSION_GAP",
  "LAST_MOVEMENT_MISMATCH",
  "RUNNING_BALANCE_MISMATCH",
  "MISSING_BALANCE",
] as const;

export type InventoryConsistencyKind = (typeof INVENTORY_CONSISTENCY_KINDS)[number];

/** One inconsistent stock item and what is wrong with it: identifiers and a kind, never quantities. */
export interface InventoryConsistencyIssue {
  readonly businessId: string;
  readonly locationId: string;
  readonly variantId: string;
  readonly kind: InventoryConsistencyKind;
}

/**
 * Per stock item:
 * - the balance quantity is the sum of its movements' deltas;
 * - the balance version is its movement count;
 * - the highest movement version is the movement count (no gap; versions are
 *   unique and at least 1 by constraint, so they are exactly 1..n);
 * - the last movement is the highest-version movement;
 * - every movement's balance_after is the running sum of deltas up to it;
 * - every stock item with movements has a balance row.
 */
export const INVENTORY_CONSISTENCY_SQL = `
WITH movement_totals AS (
  SELECT business_id, location_id, variant_id,
         SUM(quantity_delta_minor) AS delta_sum,
         COUNT(*) AS movement_count,
         MAX(balance_version) AS max_version
  FROM public.inventory_movements
  GROUP BY business_id, location_id, variant_id
),
latest AS (
  SELECT DISTINCT ON (business_id, location_id, variant_id) business_id, location_id, variant_id, id
  FROM public.inventory_movements
  ORDER BY business_id, location_id, variant_id, balance_version DESC
),
running AS (
  SELECT business_id, location_id, variant_id, balance_after_minor,
         SUM(quantity_delta_minor) OVER (
           PARTITION BY business_id, location_id, variant_id
           ORDER BY balance_version
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS running_sum
  FROM public.inventory_movements
),
issues AS (
  SELECT b.business_id, b.location_id, b.variant_id, 'BALANCE_QUANTITY_MISMATCH' AS kind
  FROM public.inventory_balances b
  LEFT JOIN movement_totals t USING (business_id, location_id, variant_id)
  WHERE b.quantity_minor <> COALESCE(t.delta_sum, 0)
  UNION ALL
  SELECT b.business_id, b.location_id, b.variant_id, 'BALANCE_VERSION_MISMATCH'
  FROM public.inventory_balances b
  LEFT JOIN movement_totals t USING (business_id, location_id, variant_id)
  WHERE b.version <> COALESCE(t.movement_count, 0)
  UNION ALL
  SELECT business_id, location_id, variant_id, 'VERSION_GAP'
  FROM movement_totals
  WHERE max_version <> movement_count
  UNION ALL
  SELECT b.business_id, b.location_id, b.variant_id, 'LAST_MOVEMENT_MISMATCH'
  FROM public.inventory_balances b
  LEFT JOIN latest l USING (business_id, location_id, variant_id)
  WHERE b.last_movement_id IS DISTINCT FROM l.id
  UNION ALL
  SELECT DISTINCT business_id, location_id, variant_id, 'RUNNING_BALANCE_MISMATCH'
  FROM running
  WHERE balance_after_minor <> running_sum
  UNION ALL
  SELECT t.business_id, t.location_id, t.variant_id, 'MISSING_BALANCE'
  FROM movement_totals t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventory_balances b
    WHERE b.business_id = t.business_id AND b.location_id = t.location_id AND b.variant_id = t.variant_id
  )
)
SELECT business_id::text AS "businessId", location_id::text AS "locationId", variant_id::text AS "variantId", kind
FROM issues
ORDER BY business_id, location_id, variant_id, kind
`;

/** The minimal query surface the check needs: a pg client or pool inside a read-only transaction. */
export interface ConsistencyQueryClient {
  query(sql: string): Promise<{ readonly rows: readonly unknown[] }>;
}

export async function findInventoryInconsistencies(
  client: ConsistencyQueryClient,
): Promise<readonly InventoryConsistencyIssue[]> {
  const { rows } = await client.query(INVENTORY_CONSISTENCY_SQL);
  return rows as readonly InventoryConsistencyIssue[];
}
