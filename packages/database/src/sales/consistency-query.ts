/*
 * The sales consistency check (ADR-011; Plan 005 S5). A read-only query that
 * compares every sale's header with its immutable line and tender snapshots,
 * its journals with the sale and its SALE_POSTED expectation, and its SALE
 * movements and valuation facts with its tracked lines. It never repairs
 * anything. Shared by the test helper and the operator script
 * (`scripts/check-sales-consistency.mjs`, run with Node's type stripping), so
 * this file has no imports and only erasable TypeScript syntax.
 *
 * Integer SQL arithmetic only; no amount is recomputed with HALF_EVEN: the
 * stored line amounts are the snapshot, and only their sums and the line
 * identities (net = gross - discount; total = net, plus tax when exclusive)
 * are checked. The exact line-by-line mirror of a reversal journal is the
 * ledger checker's; inventory quantity and value chains are the inventory
 * checker's.
 */

export const SALES_CONSISTENCY_KINDS = [
  "SALE_STATUS_INVALID",
  "SALE_TOTALS_MISMATCH",
  "SALE_COST_STATUS_MISMATCH",
  "SALE_COGS_TOTAL_MISMATCH",
  "SALE_LINE_NUMBER_GAP",
  "SALE_TENDER_NUMBER_GAP",
  "SALE_TENDER_TOTAL_MISMATCH",
  "SALE_ORIGINAL_JOURNAL_MISSING",
  "SALE_ORIGINAL_JOURNAL_MISMATCH",
  "SALE_REVERSAL_JOURNAL_MISSING",
  "SALE_REVERSAL_JOURNAL_MISMATCH",
  "SALE_POSTING_MISMATCH",
  "SALE_MOVEMENT_MISSING",
  "SALE_MOVEMENT_MISMATCH",
  "SALE_VALUATION_MISSING",
  "SALE_VALUATION_MISMATCH",
  "SALE_REVERSAL_MOVEMENT_UNEXPECTED",
  "SALE_REVERSAL_MOVEMENT_MISSING",
  "SALE_REVERSAL_MOVEMENT_MISMATCH",
  "SALE_REVERSAL_VALUATION_MISMATCH",
] as const;

export type SalesConsistencyKind = (typeof SALES_CONSISTENCY_KINDS)[number];

/** One inconsistency: identifiers and a kind, never names, prices or amounts. */
export interface SalesConsistencyIssue {
  readonly businessId: string;
  readonly saleId: string;
  readonly kind: SalesConsistencyKind;
}

export const SALES_CONSISTENCY_SQL = `
WITH line_totals AS (
  SELECT business_id, sale_id,
         COUNT(*)::int AS line_count,
         MIN(line_number) AS min_line,
         MAX(line_number) AS max_line,
         SUM(gross_minor) AS gross,
         SUM(discount_minor) AS discount,
         SUM(tax_minor) AS tax,
         SUM(total_minor) AS total,
         SUM(COALESCE(cost_minor, 0)) AS cogs,
         SUM(CASE WHEN tax_pricing_mode = 'INCLUSIVE' THEN gross_minor - tax_minor ELSE gross_minor END) AS revenue,
         COUNT(*) FILTER (WHERE tracked)::int AS tracked_count,
         COUNT(*) FILTER (WHERE tracked AND cost_status = 'VALUED')::int AS valued_count,
         BOOL_OR(
           net_minor <> gross_minor - discount_minor
           OR total_minor <> net_minor + (CASE WHEN tax_pricing_mode = 'EXCLUSIVE' THEN tax_minor ELSE 0 END)
         ) AS line_arithmetic_broken
  FROM public.sale_lines
  GROUP BY business_id, sale_id
),
tender_totals AS (
  SELECT business_id, sale_id,
         COUNT(*)::int AS tender_count,
         MIN(tender_number) AS min_tender,
         MAX(tender_number) AS max_tender,
         SUM(amount_minor) AS amount
  FROM public.sale_tenders
  GROUP BY business_id, sale_id
),
expected_posting AS (
  SELECT lt.business_id, lt.sale_id, x.role, x.direction, x.amount
  FROM line_totals lt
  CROSS JOIN LATERAL (VALUES
    ('SALES_DISCOUNTS', 'DEBIT', lt.discount),
    ('SALES_REVENUE', 'CREDIT', lt.revenue),
    ('TAX_PAYABLE', 'CREDIT', lt.tax),
    ('COST_OF_GOODS_SOLD', 'DEBIT', lt.cogs),
    ('INVENTORY', 'CREDIT', lt.cogs)
  ) AS x(role, direction, amount)
  WHERE x.amount > 0
  UNION ALL
  SELECT t.business_id, t.sale_id,
         CASE t.method
           WHEN 'CASH' THEN 'CASH_ON_HAND'
           WHEN 'BANK_TRANSFER' THEN 'BANK_TRANSFER_PENDING'
           WHEN 'POS_CARD' THEN 'POS_CARD_CLEARING'
           ELSE 'OTHER_TENDER_CLEARING'
         END,
         'DEBIT', SUM(t.amount_minor)
  FROM public.sale_tenders t
  GROUP BY t.business_id, t.sale_id, t.method
),
actual_posting AS (
  SELECT s.business_id, s.id AS sale_id, a.system_role AS role, l.direction,
         SUM(l.amount_minor) AS amount, COUNT(*)::int AS line_count
  FROM public.sales s
  JOIN public.journal_lines l ON l.business_id = s.business_id AND l.entry_id = s.journal_entry_id
  JOIN public.ledger_accounts a ON a.business_id = l.business_id AND a.id = l.account_id
  GROUP BY s.business_id, s.id, a.system_role, l.direction
),
posting_mismatch AS (
  SELECT DISTINCT COALESCE(e.business_id, a.business_id) AS business_id, COALESCE(e.sale_id, a.sale_id) AS sale_id
  FROM expected_posting e
  FULL OUTER JOIN actual_posting a
    ON a.business_id = e.business_id AND a.sale_id = e.sale_id AND a.role = e.role AND a.direction = e.direction
  WHERE e.amount IS DISTINCT FROM a.amount OR COALESCE(a.line_count, 1) <> 1
),
tracked_lines AS (
  SELECT l.business_id, l.sale_id, l.variant_id, l.quantity_minor, l.cost_status, l.cost_minor, l.movement_id,
         s.status, s.location_id, s.journal_entry_id, s.reversal_journal_entry_id
  FROM public.sale_lines l
  JOIN public.sales s ON s.business_id = l.business_id AND s.id = l.sale_id
  WHERE l.tracked
),
issues AS (
  SELECT s.business_id, s.id AS sale_id, 'SALE_STATUS_INVALID' AS kind
  FROM public.sales s
  WHERE NOT COALESCE(
    (s.status = 'POSTED'
      AND s.reversed_at IS NULL AND s.reversed_by_membership_id IS NULL AND s.reversal_reason IS NULL
      AND s.reversal_journal_entry_id IS NULL AND s.reversal_tender_unwound_confirmed IS NULL)
    OR (s.status = 'REVERSED'
      AND s.reversed_at IS NOT NULL AND s.reversed_by_membership_id IS NOT NULL AND s.reversal_reason IS NOT NULL
      AND s.reversal_journal_entry_id IS NOT NULL AND s.reversal_tender_unwound_confirmed IS TRUE),
    false)
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_TOTALS_MISMATCH'
  FROM public.sales s
  LEFT JOIN line_totals lt ON lt.business_id = s.business_id AND lt.sale_id = s.id
  WHERE lt.sale_id IS NULL
     OR lt.gross <> s.gross_total_minor
     OR lt.discount <> s.discount_total_minor
     OR lt.tax <> s.tax_total_minor
     OR lt.total <> s.total_minor
     OR lt.line_arithmetic_broken
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_COST_STATUS_MISMATCH'
  FROM public.sales s
  JOIN line_totals lt ON lt.business_id = s.business_id AND lt.sale_id = s.id
  WHERE s.cost_status <> CASE
    WHEN lt.tracked_count = 0 THEN 'NOT_APPLICABLE'
    WHEN lt.valued_count = lt.tracked_count THEN 'VALUED'
    WHEN lt.valued_count = 0 THEN 'UNVALUED'
    ELSE 'PARTIAL'
  END
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_COGS_TOTAL_MISMATCH'
  FROM public.sales s
  JOIN line_totals lt ON lt.business_id = s.business_id AND lt.sale_id = s.id
  WHERE lt.cogs <> s.cogs_total_minor
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_LINE_NUMBER_GAP'
  FROM public.sales s
  LEFT JOIN line_totals lt ON lt.business_id = s.business_id AND lt.sale_id = s.id
  WHERE lt.sale_id IS NULL OR lt.min_line <> 1 OR lt.max_line <> lt.line_count
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_TENDER_NUMBER_GAP'
  FROM public.sales s
  LEFT JOIN tender_totals tt ON tt.business_id = s.business_id AND tt.sale_id = s.id
  WHERE tt.sale_id IS NULL OR tt.min_tender <> 1 OR tt.max_tender <> tt.tender_count
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_TENDER_TOTAL_MISMATCH'
  FROM public.sales s
  LEFT JOIN tender_totals tt ON tt.business_id = s.business_id AND tt.sale_id = s.id
  WHERE tt.sale_id IS NULL OR tt.amount <> s.total_minor
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_ORIGINAL_JOURNAL_MISSING'
  FROM public.sales s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.journal_entries e WHERE e.business_id = s.business_id AND e.id = s.journal_entry_id
  )
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_ORIGINAL_JOURNAL_MISMATCH'
  FROM public.sales s
  WHERE EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.id = s.journal_entry_id
        AND NOT COALESCE(
          e.entry_kind = 'ORIGINAL' AND e.sale_id = s.id AND e.posting_rule = 'SALE_POSTED'
          AND e.posting_rule_version = 1 AND e.location_id = s.location_id AND e.currency = s.currency,
          false)
    )
    OR EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.sale_id = s.id AND e.entry_kind = 'ORIGINAL'
        AND e.id <> s.journal_entry_id
    )
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_REVERSAL_JOURNAL_MISSING'
  FROM public.sales s
  WHERE s.status = 'REVERSED'
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.id = s.reversal_journal_entry_id
    )
  UNION ALL
  SELECT s.business_id, s.id, 'SALE_REVERSAL_JOURNAL_MISMATCH'
  FROM public.sales s
  WHERE (s.status <> 'REVERSED' AND EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.sale_id = s.id AND e.entry_kind = 'REVERSAL'
    ))
    OR (s.status = 'REVERSED' AND EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.sale_id = s.id AND e.entry_kind = 'REVERSAL'
        AND e.id IS DISTINCT FROM s.reversal_journal_entry_id
    ))
    OR (s.status = 'REVERSED' AND EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.id = s.reversal_journal_entry_id
        AND NOT COALESCE(
          e.entry_kind = 'REVERSAL' AND e.sale_id = s.id AND e.reverses_entry_id = s.journal_entry_id
          AND e.posting_rule = 'SALE_POSTED' AND e.posting_rule_version = 1
          AND e.location_id = s.location_id AND e.currency = s.currency,
          false)
    ))
  UNION ALL
  SELECT p.business_id, p.sale_id, 'SALE_POSTING_MISMATCH'
  FROM posting_mismatch p
  JOIN public.sales s ON s.business_id = p.business_id AND s.id = p.sale_id
  WHERE EXISTS (
    SELECT 1 FROM public.journal_entries e WHERE e.business_id = s.business_id AND e.id = s.journal_entry_id
  )
  UNION ALL
  SELECT t.business_id, t.sale_id, 'SALE_MOVEMENT_MISSING'
  FROM tracked_lines t
  WHERE t.movement_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.inventory_movements m WHERE m.business_id = t.business_id AND m.id = t.movement_id
     )
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_MOVEMENT_MISMATCH'
  FROM tracked_lines t
  JOIN public.inventory_movements m ON m.business_id = t.business_id AND m.id = t.movement_id
  WHERE NOT COALESCE(
    m.type = 'SALE' AND m.sale_id = t.sale_id AND m.location_id = t.location_id AND m.variant_id = t.variant_id
    AND m.quantity_delta_minor = -t.quantity_minor AND m.reverses_movement_id IS NULL
    AND m.pack_id IS NULL AND m.reason_code IS NULL AND m.reason_note IS NULL,
    false)
  UNION ALL
  SELECT DISTINCT l.business_id, l.sale_id, 'SALE_MOVEMENT_MISMATCH'
  FROM public.sale_lines l
  WHERE NOT l.tracked AND l.movement_id IS NOT NULL
  UNION ALL
  SELECT DISTINCT m.business_id, m.sale_id, 'SALE_MOVEMENT_MISMATCH'
  FROM public.inventory_movements m
  WHERE m.sale_id IS NOT NULL AND m.reverses_movement_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.sale_lines l
      WHERE l.business_id = m.business_id AND l.sale_id = m.sale_id AND l.movement_id = m.id AND l.tracked
    )
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_VALUATION_MISSING'
  FROM tracked_lines t
  JOIN public.inventory_movements m ON m.business_id = t.business_id AND m.id = t.movement_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.inventory_movement_valuations f
    WHERE f.business_id = m.business_id AND f.movement_id = m.id
  )
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_VALUATION_MISMATCH'
  FROM tracked_lines t
  JOIN public.inventory_movement_valuations f ON f.business_id = t.business_id AND f.movement_id = t.movement_id
  WHERE NOT COALESCE(
    CASE t.cost_status
      WHEN 'VALUED' THEN f.cost_basis = 'WEIGHTED_AVERAGE' AND f.value_delta_minor = -t.cost_minor
        AND f.journal_entry_id = t.journal_entry_id AND f.supplied_cost_minor IS NULL
      WHEN 'UNVALUED' THEN f.cost_basis = 'NOT_VALUED' AND f.value_delta_minor = 0
        AND f.journal_entry_id IS NULL AND f.supplied_cost_minor IS NULL
      ELSE false
    END,
    false)
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_REVERSAL_MOVEMENT_UNEXPECTED'
  FROM tracked_lines t
  JOIN public.inventory_movements r ON r.business_id = t.business_id AND r.reverses_movement_id = t.movement_id
  WHERE t.status <> 'REVERSED'
  UNION ALL
  SELECT DISTINCT r.business_id, r.sale_id, 'SALE_REVERSAL_MOVEMENT_UNEXPECTED'
  FROM public.inventory_movements r
  JOIN public.sales s ON s.business_id = r.business_id AND s.id = r.sale_id
  WHERE r.reverses_movement_id IS NOT NULL AND s.status <> 'REVERSED'
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_REVERSAL_MOVEMENT_MISSING'
  FROM tracked_lines t
  WHERE t.status = 'REVERSED'
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_movements r
      WHERE r.business_id = t.business_id AND r.reverses_movement_id = t.movement_id
    )
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_REVERSAL_MOVEMENT_MISMATCH'
  FROM tracked_lines t
  JOIN public.inventory_movements r ON r.business_id = t.business_id AND r.reverses_movement_id = t.movement_id
  WHERE t.status = 'REVERSED'
    AND NOT COALESCE(
      r.type = 'SALE' AND r.sale_id = t.sale_id AND r.location_id = t.location_id AND r.variant_id = t.variant_id
      AND r.quantity_delta_minor = t.quantity_minor AND r.reason_code IS NULL AND r.reason_note IS NOT NULL
      AND r.pack_id IS NULL,
      false)
  UNION ALL
  SELECT DISTINCT t.business_id, t.sale_id, 'SALE_REVERSAL_VALUATION_MISMATCH'
  FROM tracked_lines t
  JOIN public.inventory_movements r ON r.business_id = t.business_id AND r.reverses_movement_id = t.movement_id
  LEFT JOIN public.inventory_movement_valuations f ON f.business_id = r.business_id AND f.movement_id = r.id
  WHERE t.status = 'REVERSED'
    AND NOT COALESCE(
      CASE t.cost_status
        WHEN 'VALUED' THEN f.cost_basis = 'REVERSAL_OF_ORIGINAL' AND f.value_delta_minor = t.cost_minor
          AND f.journal_entry_id = t.reversal_journal_entry_id AND f.supplied_cost_minor IS NULL
        WHEN 'UNVALUED' THEN f.cost_basis = 'NOT_VALUED' AND f.value_delta_minor = 0
          AND f.journal_entry_id IS NULL AND f.supplied_cost_minor IS NULL
        ELSE false
      END,
      false)
)
SELECT DISTINCT business_id::text AS "businessId", sale_id::text AS "saleId", kind
FROM issues
ORDER BY "businessId", kind, "saleId"
`;

/** The minimal query surface the check needs: a pg client or pool inside a read-only transaction. */
export interface SalesConsistencyQueryClient {
  query(sql: string): Promise<{ readonly rows: readonly unknown[] }>;
}

export async function findSalesInconsistencies(
  client: SalesConsistencyQueryClient,
): Promise<readonly SalesConsistencyIssue[]> {
  const { rows } = await client.query(SALES_CONSISTENCY_SQL);
  return rows as readonly SalesConsistencyIssue[];
}
