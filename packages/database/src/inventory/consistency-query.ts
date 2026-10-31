/*
 * The inventory consistency check (ADR-008 section 7.3; ADR-009 sections 19
 * and 30; plan section T). A read-only query that compares every stock item's
 * balance row with its movement ledger and valuation projection. It never
 * repairs anything. Shared by the test helper and the operator script
 * (`scripts/check-inventory-consistency.mjs`, run with Node's type stripping),
 * so this file has no imports and only erasable TypeScript syntax.
 *
 * A balance at version 0 with quantity 0 and no movements is consistent.
 *
 * Cutover A: movements with balance_version <= started_from_balance_version
 * are legacy and need no fact. Later movements require exactly one fact.
 * That check only runs when an inventory_valuations row exists. A writer that
 * skips creating the projection cannot be distinguished from an untouched
 * Build 2 item without a new marker, which this check does not invent.
 */

export const INVENTORY_CONSISTENCY_KINDS = [
  "BALANCE_QUANTITY_MISMATCH",
  "BALANCE_VERSION_MISMATCH",
  "VERSION_GAP",
  "LAST_MOVEMENT_MISMATCH",
  "RUNNING_BALANCE_MISMATCH",
  "MISSING_BALANCE",
  "MISSING_MOVEMENT_VALUATION",
  "VALUED_ZERO_QTY_NONZERO_VALUE",
  "VALUATION_PROJECTION_INVALID",
  "VALUATION_CURRENCY_MISMATCH",
  "INVENTORY_LEDGER_MISMATCH",
  "INVENTORY_VALUE_MISMATCH",
  "MOVEMENT_VALUE_CHAIN_BREAK",
  "NOT_VALUED_NONZERO_DELTA",
  "JOURNAL_LINK_INVALID",
  "RESIDUAL_TRIGGER_INVALID",
  "DUPLICATE_RESIDUAL",
  "UNNEEDED_RESIDUAL",
  "MISSING_RESIDUAL",
  "RESIDUAL_AMOUNT_MISMATCH",
  "RESIDUAL_JOURNAL_INVALID",
  "NEGATIVE_VALUE_AFTER_UNPAIRED",
] as const;

export type InventoryConsistencyKind = (typeof INVENTORY_CONSISTENCY_KINDS)[number];

/** One inconsistent stock item (or business, when location/variant are null). Identifiers and a kind, never quantities. */
export interface InventoryConsistencyIssue {
  readonly businessId: string;
  readonly locationId: string | null;
  readonly variantId: string | null;
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
 * - every stock item with movements has a balance row;
 * - post-cutover movements have exactly one valuation fact;
 * - recorded value equals movement deltas plus stock-valuation document diffs;
 * - consecutive movement facts form a value-after chain unless a stock
 *   valuation document sits between them;
 * - NOT_VALUED facts have delta 0;
 * - VALUED zero on-hand quantity has value 0;
 * - journal_entry_id, when present, is a same-business journal;
 * - per business, the INVENTORY ledger balance equals SUM(value_minor);
 * - a REVERSAL_OF_ORIGINAL fact that would leave a negative raw value or a
 *   VALUED zero-quantity leftover has exactly one matching REVERSAL_RESIDUAL
 *   that clears the projection to zero;
 * - a negative movement value_after is allowed only for that paired residual.
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
fact_sums AS (
  SELECT m.business_id, m.location_id, m.variant_id, SUM(f.value_delta_minor) AS delta_sum
  FROM public.inventory_movement_valuations f
  JOIN public.inventory_movements m ON m.business_id = f.business_id AND m.id = f.movement_id
  GROUP BY m.business_id, m.location_id, m.variant_id
),
valuation_doc_sums AS (
  SELECT business_id, location_id, variant_id, SUM(new_value_minor - previous_value_minor) AS delta_sum
  FROM public.stock_valuations
  GROUP BY business_id, location_id, variant_id
),
ordered_facts AS (
  SELECT m.business_id, m.location_id, m.variant_id, m.balance_version,
         f.value_delta_minor, f.value_after_minor,
         LAG(f.value_after_minor) OVER (
           PARTITION BY m.business_id, m.location_id, m.variant_id ORDER BY m.balance_version
         ) AS prev_after,
         LAG(m.balance_version) OVER (
           PARTITION BY m.business_id, m.location_id, m.variant_id ORDER BY m.balance_version
         ) AS prev_version
  FROM public.inventory_movement_valuations f
  JOIN public.inventory_movements m ON m.business_id = f.business_id AND m.id = f.movement_id
),
inventory_ledger AS (
  SELECT a.business_id,
         COALESCE(SUM(CASE WHEN l.direction = 'DEBIT' THEN l.amount_minor ELSE -l.amount_minor END), 0) AS balance
  FROM public.ledger_accounts a
  LEFT JOIN public.journal_lines l ON l.business_id = a.business_id AND l.account_id = a.id
  WHERE a.system_role = 'INVENTORY'
  GROUP BY a.business_id
),
inventory_projection AS (
  SELECT business_id, SUM(value_minor) AS value_sum
  FROM public.inventory_valuations
  GROUP BY business_id
),
needed_residual AS (
  SELECT m.business_id, m.location_id, m.variant_id, m.id AS trigger_id, f.value_after_minor
  FROM public.inventory_movement_valuations f
  JOIN public.inventory_movements m ON m.business_id = f.business_id AND m.id = f.movement_id
  WHERE f.cost_basis = 'REVERSAL_OF_ORIGINAL'
    AND m.reverses_movement_id IS NOT NULL
    AND (
      f.value_after_minor < 0
      OR (f.status_after = 'VALUED' AND m.balance_after_minor = 0 AND f.value_after_minor > 0)
    )
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
  UNION ALL
  SELECT m.business_id, m.location_id, m.variant_id, 'MISSING_MOVEMENT_VALUATION'
  FROM public.inventory_movements m
  JOIN public.inventory_valuations v
    ON v.business_id = m.business_id AND v.location_id = m.location_id AND v.variant_id = m.variant_id
  WHERE m.balance_version > v.started_from_balance_version
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_movement_valuations f
      WHERE f.business_id = m.business_id AND f.movement_id = m.id
    )
  UNION ALL
  SELECT v.business_id, v.location_id, v.variant_id, 'VALUED_ZERO_QTY_NONZERO_VALUE'
  FROM public.inventory_valuations v
  JOIN public.inventory_balances b
    ON b.business_id = v.business_id AND b.location_id = v.location_id AND b.variant_id = v.variant_id
  WHERE v.status = 'VALUED' AND b.quantity_minor = 0 AND v.value_minor <> 0
  UNION ALL
  SELECT v.business_id, v.location_id, v.variant_id, 'VALUATION_PROJECTION_INVALID'
  FROM public.inventory_valuations v
  WHERE v.status NOT IN ('VALUED', 'UNVALUED')
     OR v.version < 0
     OR v.value_minor < 0
     OR v.started_from_balance_version < 0
     OR NOT EXISTS (
       SELECT 1 FROM public.business_locations l
       WHERE l.business_id = v.business_id AND l.id = v.location_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.product_variants p
       WHERE p.business_id = v.business_id AND p.id = v.variant_id
     )
  UNION ALL
  SELECT v.business_id, v.location_id, v.variant_id, 'VALUATION_CURRENCY_MISMATCH'
  FROM public.inventory_valuations v
  JOIN public.businesses b ON b.id = v.business_id
  WHERE v.currency <> b.currency_code
  UNION ALL
  SELECT COALESCE(i.business_id, p.business_id), NULL::uuid, NULL::uuid, 'INVENTORY_LEDGER_MISMATCH'
  FROM inventory_ledger i
  FULL OUTER JOIN inventory_projection p ON p.business_id = i.business_id
  WHERE COALESCE(i.balance, 0) <> COALESCE(p.value_sum, 0)
  UNION ALL
  SELECT v.business_id, v.location_id, v.variant_id, 'INVENTORY_VALUE_MISMATCH'
  FROM public.inventory_valuations v
  LEFT JOIN fact_sums f USING (business_id, location_id, variant_id)
  LEFT JOIN valuation_doc_sums s USING (business_id, location_id, variant_id)
  WHERE v.value_minor <> COALESCE(f.delta_sum, 0) + COALESCE(s.delta_sum, 0)
  UNION ALL
  SELECT o.business_id, o.location_id, o.variant_id, 'MOVEMENT_VALUE_CHAIN_BREAK'
  FROM ordered_facts o
  WHERE o.prev_after IS NOT NULL
    AND o.prev_after + o.value_delta_minor <> o.value_after_minor
    AND NOT EXISTS (
      SELECT 1 FROM public.stock_valuations s
      WHERE s.business_id = o.business_id AND s.location_id = o.location_id AND s.variant_id = o.variant_id
        AND s.balance_version_at_valuation >= o.prev_version
        AND s.balance_version_at_valuation <= o.balance_version
        AND s.new_value_minor <> s.previous_value_minor
    )
  UNION ALL
  SELECT m.business_id, m.location_id, m.variant_id, 'NOT_VALUED_NONZERO_DELTA'
  FROM public.inventory_movement_valuations f
  JOIN public.inventory_movements m ON m.business_id = f.business_id AND m.id = f.movement_id
  WHERE f.cost_basis = 'NOT_VALUED' AND f.value_delta_minor <> 0
  UNION ALL
  SELECT m.business_id, m.location_id, m.variant_id, 'JOURNAL_LINK_INVALID'
  FROM public.inventory_movement_valuations f
  JOIN public.inventory_movements m ON m.business_id = f.business_id AND m.id = f.movement_id
  WHERE f.journal_entry_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = f.business_id AND e.id = f.journal_entry_id
    )
  UNION ALL
  SELECT s.business_id, s.location_id, s.variant_id, 'RESIDUAL_TRIGGER_INVALID'
  FROM public.stock_valuations s
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND (
      s.trigger_movement_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.inventory_movements m
        WHERE m.business_id = s.business_id AND m.id = s.trigger_movement_id
          AND m.location_id = s.location_id AND m.variant_id = s.variant_id
          AND m.reverses_movement_id IS NOT NULL
      )
    )
  UNION ALL
  SELECT s.business_id, s.location_id, s.variant_id, 'DUPLICATE_RESIDUAL'
  FROM public.stock_valuations s
  WHERE s.kind = 'REVERSAL_RESIDUAL' AND s.trigger_movement_id IS NOT NULL
  GROUP BY s.business_id, s.location_id, s.variant_id, s.trigger_movement_id
  HAVING COUNT(*) > 1
  UNION ALL
  SELECT s.business_id, s.location_id, s.variant_id, 'UNNEEDED_RESIDUAL'
  FROM public.stock_valuations s
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND NOT EXISTS (
      SELECT 1 FROM needed_residual n
      WHERE n.business_id = s.business_id AND n.trigger_id = s.trigger_movement_id
    )
  UNION ALL
  SELECT n.business_id, n.location_id, n.variant_id, 'MISSING_RESIDUAL'
  FROM needed_residual n
  WHERE NOT EXISTS (
    SELECT 1 FROM public.stock_valuations s
    WHERE s.business_id = n.business_id AND s.kind = 'REVERSAL_RESIDUAL'
      AND s.trigger_movement_id = n.trigger_id
  )
  UNION ALL
  SELECT s.business_id, s.location_id, s.variant_id, 'RESIDUAL_AMOUNT_MISMATCH'
  FROM public.stock_valuations s
  JOIN needed_residual n ON n.business_id = s.business_id AND n.trigger_id = s.trigger_movement_id
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND (s.previous_value_minor <> n.value_after_minor OR s.new_value_minor <> 0)
  UNION ALL
  SELECT s.business_id, s.location_id, s.variant_id, 'RESIDUAL_JOURNAL_INVALID'
  FROM public.stock_valuations s
  LEFT JOIN public.journal_entries e
    ON e.business_id = s.business_id AND e.id = s.journal_entry_id
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND (
      s.journal_entry_id IS NULL
      OR e.id IS NULL
      OR e.entry_kind <> 'ORIGINAL'
      OR e.valuation_id IS DISTINCT FROM s.id
      OR e.posting_rule <> 'INVENTORY_REVERSAL_RESIDUAL'
      OR e.posting_rule_version <> 1
    )
  UNION ALL
  SELECT s.business_id, s.location_id, s.variant_id, 'RESIDUAL_JOURNAL_INVALID'
  FROM public.stock_valuations s
  JOIN needed_residual n ON n.business_id = s.business_id AND n.trigger_id = s.trigger_movement_id
  JOIN public.journal_entries e ON e.business_id = s.business_id AND e.id = s.journal_entry_id
  JOIN public.journal_lines debit
    ON debit.business_id = e.business_id AND debit.entry_id = e.id AND debit.line_number = 1
  JOIN public.ledger_accounts debit_account
    ON debit_account.business_id = debit.business_id AND debit_account.id = debit.account_id
  JOIN public.journal_lines credit
    ON credit.business_id = e.business_id AND credit.entry_id = e.id AND credit.line_number = 2
  JOIN public.ledger_accounts credit_account
    ON credit_account.business_id = credit.business_id AND credit_account.id = credit.account_id
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND NOT (
      (
        n.value_after_minor < 0
        AND debit_account.system_role = 'INVENTORY' AND debit.direction = 'DEBIT'
        AND credit_account.system_role = 'INVENTORY_GAIN' AND credit.direction = 'CREDIT'
        AND debit.amount_minor = ABS(n.value_after_minor)
        AND credit.amount_minor = ABS(n.value_after_minor)
      )
      OR (
        n.value_after_minor > 0
        AND debit_account.system_role = 'INVENTORY_SHRINKAGE' AND debit.direction = 'DEBIT'
        AND credit_account.system_role = 'INVENTORY' AND credit.direction = 'CREDIT'
        AND debit.amount_minor = n.value_after_minor
        AND credit.amount_minor = n.value_after_minor
      )
    )
  UNION ALL
  SELECT m.business_id, m.location_id, m.variant_id, 'NEGATIVE_VALUE_AFTER_UNPAIRED'
  FROM public.inventory_movement_valuations f
  JOIN public.inventory_movements m ON m.business_id = f.business_id AND m.id = f.movement_id
  WHERE f.value_after_minor < 0
    AND (
      f.cost_basis <> 'REVERSAL_OF_ORIGINAL'
      OR NOT EXISTS (
        SELECT 1 FROM public.stock_valuations s
        WHERE s.business_id = m.business_id AND s.kind = 'REVERSAL_RESIDUAL'
          AND s.trigger_movement_id = m.id AND s.new_value_minor = 0
      )
    )
)
SELECT business_id::text AS "businessId", location_id::text AS "locationId", variant_id::text AS "variantId", kind
FROM issues
ORDER BY business_id, location_id NULLS FIRST, variant_id NULLS FIRST, kind
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
