/*
 * The ledger consistency check (ADR-009 sections 29 and 30; Plan 005 S2/S3).
 * A read-only query that compares every business's ledger accounts with the
 * versioned chart template they were provisioned from, then checks journal
 * entries and lines. It never repairs anything. Shared by the test helper and
 * the operator script (`scripts/check-ledger-consistency.mjs`, run with Node's
 * type stripping), so this file has no imports and only erasable TypeScript
 * syntax.
 *
 * Chart kinds (S2): MISSING_CHART through CHART_INCOMPLETE. Journal kinds
 * (S3, ADR-009 section 30): empty/unbalanced entries, currency and tenant
 * agreement, typed-source shape, and reversal-mirror checks. Duplicate
 * ORIGINAL-per-source, reversal uniqueness, orphan lines and some tenant
 * mismatches are also enforced by UNIQUE/FK/CHECK; the query still reports
 * them when owner-role tests drop or defer those constraints.
 *
 * Every ACTIVE business must have a chart: one with no account at all is
 * MISSING_CHART. After the S2 migration, businesses that already existed
 * report it until the operator provisioning command runs for them. A
 * SUSPENDED business without a chart is not reported.
 */

export const LEDGER_CONSISTENCY_KINDS = [
  "MISSING_CHART",
  "ACCOUNT_WITHOUT_SYSTEM_ROLE",
  "UNKNOWN_TEMPLATE_VERSION",
  "TEMPLATE_MISMATCH",
  "MIXED_TEMPLATE_VERSIONS",
  "CHART_INCOMPLETE",
  "ENTRY_WITHOUT_LINES",
  "UNBALANCED_ENTRY",
  "ENTRY_CURRENCY_MISMATCH",
  "LINE_CURRENCY_MISMATCH",
  "LINE_ACCOUNT_TENANT_MISMATCH",
  "INVALID_SOURCE_SHAPE",
  "SOURCE_TENANT_MISMATCH",
  "DUPLICATE_ORIGINAL_SOURCE",
  "REVERSAL_TARGET_MISSING",
  "REVERSAL_TARGET_NOT_ORIGINAL",
  "DUPLICATE_REVERSAL",
  "REVERSAL_CURRENCY_MISMATCH",
  "REVERSAL_SOURCE_MISMATCH",
  "REVERSAL_LINE_COUNT_MISMATCH",
  "REVERSAL_ACCOUNT_MISMATCH",
  "REVERSAL_AMOUNT_MISMATCH",
  "REVERSAL_MEMO_MISMATCH",
  "REVERSAL_DIRECTION_MISMATCH",
  "ORPHAN_LINE",
  "RESIDUAL_JOURNAL_INVALID",
] as const;

export type LedgerConsistencyKind = (typeof LEDGER_CONSISTENCY_KINDS)[number];

/**
 * One inconsistency: identifiers and a kind, never names, codes or amounts.
 * `accountId` is the ledger account for chart issues, the journal entry id for
 * entry/reversal issues, and the referenced entry id for an orphan line.
 * It is null for a business-level issue (a missing or incomplete chart, or
 * mixed template versions).
 */
export interface LedgerConsistencyIssue {
  readonly businessId: string;
  readonly accountId: string | null;
  readonly kind: LedgerConsistencyKind;
}

/**
 * The chart templates the check knows, as literal rows. Must equal the domain
 * templates (`CHART_TEMPLATE_V1` in @tali/domain); a unit test compares them,
 * and a healthy provisioned chart reporting no issue proves it end to end.
 */
export const LEDGER_TEMPLATE_ROWS_SQL = `
  (1, 'CASH_ON_HAND', '1000', 'Cash on hand', 'ASSET', 'DEBIT'),
  (1, 'BANK_TRANSFER_PENDING', '1010', 'Bank transfers pending verification', 'ASSET', 'DEBIT'),
  (1, 'POS_CARD_CLEARING', '1020', 'POS/card clearing', 'ASSET', 'DEBIT'),
  (1, 'OTHER_TENDER_CLEARING', '1030', 'Other tender clearing', 'ASSET', 'DEBIT'),
  (1, 'INVENTORY', '1200', 'Inventory', 'ASSET', 'DEBIT'),
  (1, 'TAX_PAYABLE', '2100', 'Tax payable', 'LIABILITY', 'CREDIT'),
  (1, 'GOODS_RECEIVED_NOT_INVOICED', '2200', 'Goods received not invoiced', 'LIABILITY', 'CREDIT'),
  (1, 'OPENING_BALANCE_EQUITY', '3000', 'Opening balance equity', 'EQUITY', 'CREDIT'),
  (1, 'SALES_REVENUE', '4000', 'Sales revenue', 'REVENUE', 'CREDIT'),
  (1, 'SALES_DISCOUNTS', '4010', 'Sales discounts', 'CONTRA_REVENUE', 'DEBIT'),
  (1, 'INVENTORY_GAIN', '4100', 'Inventory gains', 'REVENUE', 'CREDIT'),
  (1, 'COST_OF_GOODS_SOLD', '5000', 'Cost of goods sold', 'EXPENSE', 'DEBIT'),
  (1, 'INVENTORY_SHRINKAGE', '5100', 'Inventory shrinkage', 'EXPENSE', 'DEBIT')`;

/**
 * Per ACTIVE business:
 * - it has at least one account (otherwise MISSING_CHART).
 * Per account:
 * - it has a system role (Build 3 has no user-defined accounts);
 * - its template version is a known template;
 * - its code, name, type, normal balance and status equal the template row
 *   for its role and version.
 * Per business with at least one account:
 * - every account carries the same template version;
 * - every role of that template has an account (no partial chart).
 * Duplicate roles and codes are prevented by unique indexes, so they are not
 * re-checked here.
 * Journal: empty and unbalanced entries; currency agreement; typed source
 * shape and tenant; one ORIGINAL per source; reversal target and uniqueness;
 * exact reversal line mirror (count, account, amount, memo, opposite
 * direction); orphan lines; REVERSAL_RESIDUAL ORIGINAL journals (entry kind,
 * source valuation_id, posting rule/version). Residual pairing of amounts and
 * accounts is reported by the inventory checker.
 */
export const LEDGER_CONSISTENCY_SQL = `
WITH template (template_version, system_role, code, name, type, normal_balance) AS (
  VALUES ${LEDGER_TEMPLATE_ROWS_SQL}
),
known_versions AS (
  SELECT DISTINCT template_version FROM template
),
business_versions AS (
  SELECT business_id, MIN(template_version) AS min_version, MAX(template_version) AS max_version
  FROM public.ledger_accounts
  GROUP BY business_id
),
source_count AS (
  SELECT e.business_id, e.id,
         (CASE WHEN e.opening_batch_id IS NOT NULL THEN 1 ELSE 0 END)
         + (CASE WHEN e.goods_receipt_id IS NOT NULL THEN 1 ELSE 0 END)
         + (CASE WHEN e.adjustment_id IS NOT NULL THEN 1 ELSE 0 END)
         + (CASE WHEN e.stocktake_id IS NOT NULL THEN 1 ELSE 0 END)
         + (CASE WHEN e.valuation_id IS NOT NULL THEN 1 ELSE 0 END) AS sources
  FROM public.journal_entries e
),
line_totals AS (
  SELECT business_id, entry_id,
         COUNT(*)::int AS line_count,
         SUM(CASE WHEN direction = 'DEBIT' THEN amount_minor ELSE 0 END) AS debit,
         SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE 0 END) AS credit
  FROM public.journal_lines
  GROUP BY business_id, entry_id
),
original_sources AS (
  SELECT business_id, id, 'opening_batch'::text AS source_kind, opening_batch_id AS source_id
  FROM public.journal_entries WHERE entry_kind = 'ORIGINAL' AND opening_batch_id IS NOT NULL
  UNION ALL
  SELECT business_id, id, 'goods_receipt', goods_receipt_id
  FROM public.journal_entries WHERE entry_kind = 'ORIGINAL' AND goods_receipt_id IS NOT NULL
  UNION ALL
  SELECT business_id, id, 'adjustment', adjustment_id
  FROM public.journal_entries WHERE entry_kind = 'ORIGINAL' AND adjustment_id IS NOT NULL
  UNION ALL
  SELECT business_id, id, 'stocktake', stocktake_id
  FROM public.journal_entries WHERE entry_kind = 'ORIGINAL' AND stocktake_id IS NOT NULL
  UNION ALL
  SELECT business_id, id, 'valuation', valuation_id
  FROM public.journal_entries WHERE entry_kind = 'ORIGINAL' AND valuation_id IS NOT NULL
),
duplicate_originals AS (
  SELECT business_id, source_kind, source_id
  FROM original_sources
  GROUP BY business_id, source_kind, source_id
  HAVING COUNT(*) > 1
),
duplicate_reversals AS (
  SELECT business_id, reverses_entry_id
  FROM public.journal_entries
  WHERE reverses_entry_id IS NOT NULL
  GROUP BY business_id, reverses_entry_id
  HAVING COUNT(*) > 1
),
issues AS (
  SELECT b.id AS business_id, NULL::uuid AS account_id, 'MISSING_CHART' AS kind
  FROM public.businesses b
  WHERE b.status = 'ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM public.ledger_accounts a WHERE a.business_id = b.id)
  UNION ALL
  SELECT a.business_id, a.id, 'ACCOUNT_WITHOUT_SYSTEM_ROLE'
  FROM public.ledger_accounts a
  WHERE a.system_role IS NULL
  UNION ALL
  SELECT a.business_id, a.id, 'UNKNOWN_TEMPLATE_VERSION'
  FROM public.ledger_accounts a
  WHERE NOT EXISTS (SELECT 1 FROM known_versions k WHERE k.template_version = a.template_version)
  UNION ALL
  SELECT a.business_id, a.id, 'TEMPLATE_MISMATCH'
  FROM public.ledger_accounts a
  JOIN known_versions k ON k.template_version = a.template_version
  WHERE a.system_role IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM template t
      WHERE t.template_version = a.template_version
        AND t.system_role = a.system_role
        AND t.code = a.code
        AND t.name = a.name
        AND t.type = a.type
        AND t.normal_balance = a.normal_balance
        AND a.status = 'ACTIVE'
    )
  UNION ALL
  SELECT v.business_id, NULL, 'MIXED_TEMPLATE_VERSIONS'
  FROM business_versions v
  WHERE v.min_version <> v.max_version
  UNION ALL
  SELECT v.business_id, NULL, 'CHART_INCOMPLETE'
  FROM business_versions v
  JOIN known_versions k ON k.template_version = v.max_version
  WHERE EXISTS (
    SELECT 1 FROM template t
    WHERE t.template_version = v.max_version
      AND NOT EXISTS (
        SELECT 1 FROM public.ledger_accounts a
        WHERE a.business_id = v.business_id AND a.system_role = t.system_role
      )
  )
  UNION ALL
  SELECT e.business_id, e.id, 'ENTRY_WITHOUT_LINES'
  FROM public.journal_entries e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.journal_lines l WHERE l.business_id = e.business_id AND l.entry_id = e.id
  )
  UNION ALL
  SELECT e.business_id, e.id, 'UNBALANCED_ENTRY'
  FROM public.journal_entries e
  JOIN line_totals t ON t.business_id = e.business_id AND t.entry_id = e.id
  WHERE t.debit <> t.credit
  UNION ALL
  SELECT e.business_id, e.id, 'ENTRY_CURRENCY_MISMATCH'
  FROM public.journal_entries e
  JOIN public.businesses b ON b.id = e.business_id
  WHERE e.currency <> b.currency_code
  UNION ALL
  SELECT l.business_id, l.entry_id, 'LINE_CURRENCY_MISMATCH'
  FROM public.journal_lines l
  JOIN public.journal_entries e ON e.business_id = l.business_id AND e.id = l.entry_id
  WHERE l.currency <> e.currency
  UNION ALL
  SELECT l.business_id, l.entry_id, 'LINE_ACCOUNT_TENANT_MISMATCH'
  FROM public.journal_lines l
  JOIN public.ledger_accounts a ON a.id = l.account_id
  WHERE a.business_id <> l.business_id
  UNION ALL
  SELECT s.business_id, s.id, 'INVALID_SOURCE_SHAPE'
  FROM source_count s
  WHERE s.sources <> 1
  UNION ALL
  SELECT e.business_id, e.id, 'SOURCE_TENANT_MISMATCH'
  FROM public.journal_entries e
  WHERE (e.opening_batch_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.inventory_opening_batches d
           WHERE d.business_id = e.business_id AND d.id = e.opening_batch_id))
     OR (e.goods_receipt_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.goods_receipts d
           WHERE d.business_id = e.business_id AND d.id = e.goods_receipt_id))
     OR (e.adjustment_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.inventory_adjustments d
           WHERE d.business_id = e.business_id AND d.id = e.adjustment_id))
     OR (e.stocktake_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.stocktakes d
           WHERE d.business_id = e.business_id AND d.id = e.stocktake_id))
     OR (e.valuation_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.stock_valuations d
           WHERE d.business_id = e.business_id AND d.id = e.valuation_id))
  UNION ALL
  SELECT o.business_id, o.id, 'DUPLICATE_ORIGINAL_SOURCE'
  FROM original_sources o
  JOIN duplicate_originals d
    ON d.business_id = o.business_id AND d.source_kind = o.source_kind AND d.source_id = o.source_id
  UNION ALL
  SELECT e.business_id, e.id, 'REVERSAL_TARGET_MISSING'
  FROM public.journal_entries e
  WHERE e.entry_kind = 'REVERSAL'
    AND (e.reverses_entry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.journal_entries o
      WHERE o.business_id = e.business_id AND o.id = e.reverses_entry_id
    ))
  UNION ALL
  SELECT e.business_id, e.id, 'REVERSAL_TARGET_NOT_ORIGINAL'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  WHERE e.entry_kind = 'REVERSAL' AND o.entry_kind <> 'ORIGINAL'
  UNION ALL
  SELECT e.business_id, e.id, 'DUPLICATE_REVERSAL'
  FROM public.journal_entries e
  JOIN duplicate_reversals d ON d.business_id = e.business_id AND d.reverses_entry_id = e.reverses_entry_id
  UNION ALL
  SELECT e.business_id, e.id, 'REVERSAL_CURRENCY_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  WHERE e.entry_kind = 'REVERSAL' AND e.currency <> o.currency
  UNION ALL
  SELECT e.business_id, e.id, 'REVERSAL_SOURCE_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  WHERE e.entry_kind = 'REVERSAL'
    AND (e.opening_batch_id IS DISTINCT FROM o.opening_batch_id
      OR e.goods_receipt_id IS DISTINCT FROM o.goods_receipt_id
      OR e.adjustment_id IS DISTINCT FROM o.adjustment_id
      OR e.stocktake_id IS DISTINCT FROM o.stocktake_id
      OR e.valuation_id IS DISTINCT FROM o.valuation_id)
  UNION ALL
  SELECT e.business_id, e.id, 'REVERSAL_LINE_COUNT_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  LEFT JOIN line_totals rt ON rt.business_id = e.business_id AND rt.entry_id = e.id
  LEFT JOIN line_totals ot ON ot.business_id = o.business_id AND ot.entry_id = o.id
  WHERE e.entry_kind = 'REVERSAL'
    AND COALESCE(rt.line_count, 0) <> COALESCE(ot.line_count, 0)
  UNION ALL
  SELECT DISTINCT e.business_id, e.id, 'REVERSAL_ACCOUNT_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  JOIN public.journal_lines ol ON ol.business_id = o.business_id AND ol.entry_id = o.id
  LEFT JOIN public.journal_lines rl
    ON rl.business_id = e.business_id AND rl.entry_id = e.id AND rl.line_number = ol.line_number
  WHERE e.entry_kind = 'REVERSAL' AND (rl.account_id IS DISTINCT FROM ol.account_id)
  UNION ALL
  SELECT DISTINCT e.business_id, e.id, 'REVERSAL_AMOUNT_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  JOIN public.journal_lines ol ON ol.business_id = o.business_id AND ol.entry_id = o.id
  LEFT JOIN public.journal_lines rl
    ON rl.business_id = e.business_id AND rl.entry_id = e.id AND rl.line_number = ol.line_number
  WHERE e.entry_kind = 'REVERSAL' AND (rl.amount_minor IS DISTINCT FROM ol.amount_minor)
  UNION ALL
  SELECT DISTINCT e.business_id, e.id, 'REVERSAL_MEMO_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  JOIN public.journal_lines ol ON ol.business_id = o.business_id AND ol.entry_id = o.id
  LEFT JOIN public.journal_lines rl
    ON rl.business_id = e.business_id AND rl.entry_id = e.id AND rl.line_number = ol.line_number
  WHERE e.entry_kind = 'REVERSAL' AND (rl.memo_kind IS DISTINCT FROM ol.memo_kind)
  UNION ALL
  SELECT DISTINCT e.business_id, e.id, 'REVERSAL_DIRECTION_MISMATCH'
  FROM public.journal_entries e
  JOIN public.journal_entries o ON o.business_id = e.business_id AND o.id = e.reverses_entry_id
  JOIN public.journal_lines ol ON ol.business_id = o.business_id AND ol.entry_id = o.id
  LEFT JOIN public.journal_lines rl
    ON rl.business_id = e.business_id AND rl.entry_id = e.id AND rl.line_number = ol.line_number
  WHERE e.entry_kind = 'REVERSAL'
    AND NOT (
      (ol.direction = 'DEBIT' AND rl.direction = 'CREDIT')
      OR (ol.direction = 'CREDIT' AND rl.direction = 'DEBIT')
    )
  UNION ALL
  SELECT l.business_id, l.entry_id, 'ORPHAN_LINE'
  FROM public.journal_lines l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.journal_entries e
    WHERE e.business_id = l.business_id AND e.id = l.entry_id
  )
  UNION ALL
  SELECT e.business_id, e.id, 'RESIDUAL_JOURNAL_INVALID'
  FROM public.journal_entries e
  JOIN public.stock_valuations s ON s.business_id = e.business_id AND s.id = e.valuation_id
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND (
      e.entry_kind <> 'ORIGINAL'
      OR e.posting_rule <> 'INVENTORY_REVERSAL_RESIDUAL'
      OR e.posting_rule_version <> 1
    )
  UNION ALL
  SELECT s.business_id, s.journal_entry_id, 'RESIDUAL_JOURNAL_INVALID'
  FROM public.stock_valuations s
  WHERE s.kind = 'REVERSAL_RESIDUAL'
    AND s.journal_entry_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entries e
      WHERE e.business_id = s.business_id AND e.id = s.journal_entry_id
        AND e.entry_kind = 'ORIGINAL' AND e.valuation_id = s.id
    )
)
SELECT business_id::text AS "businessId", account_id::text AS "accountId", kind
FROM issues
ORDER BY business_id, kind, account_id NULLS FIRST
`;

/** The minimal query surface the check needs: a pg client or pool inside a read-only transaction. */
export interface LedgerConsistencyQueryClient {
  query(sql: string): Promise<{ readonly rows: readonly unknown[] }>;
}

export async function findLedgerInconsistencies(
  client: LedgerConsistencyQueryClient,
): Promise<readonly LedgerConsistencyIssue[]> {
  const { rows } = await client.query(LEDGER_CONSISTENCY_SQL);
  return rows as readonly LedgerConsistencyIssue[];
}
