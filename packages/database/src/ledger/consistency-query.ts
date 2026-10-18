/*
 * The ledger consistency check (ADR-009 section 29; Plan 005 S2). A read-only
 * query that compares every business's ledger accounts with the versioned
 * chart template they were provisioned from. It never repairs anything.
 * Shared by the test helper and the operator script
 * (`scripts/check-ledger-consistency.mjs`, run with Node's type stripping), so
 * this file has no imports and only erasable TypeScript syntax.
 *
 * Build 3 S2 persists ledger accounts only; journal entries and lines arrive
 * with their typed source columns in S3, which extends this check with the
 * journal invariants (balance per entry, reversal links, tenant agreement).
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
] as const;

export type LedgerConsistencyKind = (typeof LEDGER_CONSISTENCY_KINDS)[number];

/**
 * One inconsistency: identifiers and a kind, never names, codes or amounts.
 * `accountId` is null for a business-level issue (a missing or incomplete
 * chart, or mixed template versions).
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
