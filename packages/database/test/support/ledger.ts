import type pg from "pg";

/**
 * Ledger test setup. Statements run as the owner role in the disposable test
 * database only (the application role cannot UPDATE or DELETE ledger
 * accounts, by design).
 */

export interface ChartAuditRow {
  actor_type: string;
  actor_user_id: string | null;
  actor_name: string | null;
  source_channel: string;
  correlation_id: string;
  idempotency_key: string | null;
  entity_type: string;
  entity_id: string;
  payload: unknown;
}

/** The audit rows the chart provisioning wrote for one business, oldest first. */
export async function chartAudits(owner: pg.Pool, businessId: string): Promise<ChartAuditRow[]> {
  const { rows } = await owner.query<ChartAuditRow>(
    `SELECT actor_type, actor_user_id::text, actor_name, source_channel, correlation_id,
            idempotency_key::text, entity_type, entity_id::text, payload
     FROM business_audit_records
     WHERE business_id = $1 AND action = 'ledger.chart_provisioned' ORDER BY id`,
    [businessId],
  );
  return rows;
}

export async function accountCount(owner: pg.Pool, businessId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM ledger_accounts WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]?.n);
}

/**
 * Returns a business created through the application to the state of a
 * business created before Build 3 S2: no ledger accounts and no chart audit.
 */
export async function asBusinessCreatedBeforeLedger(owner: pg.Pool, businessId: string): Promise<void> {
  await owner.query(`DELETE FROM ledger_accounts WHERE business_id = $1`, [businessId]);
  await owner.query(
    `DELETE FROM business_audit_records WHERE business_id = $1 AND action = 'ledger.chart_provisioned'`,
    [businessId],
  );
}

/** A complete, valid template v1 account row, for constraint probes. */
export function accountRow(businessId: string, id: string, overrides: Record<string, unknown> = {}) {
  return {
    business_id: businessId,
    id,
    code: "1000",
    name: "Cash on hand",
    type: "ASSET",
    normal_balance: "DEBIT",
    system_role: "CASH_ON_HAND",
    template_version: 1,
    status: "ACTIVE",
    created_at: "2026-10-16T08:00:00.000Z",
    ...overrides,
  };
}

/** Inserts one ledger account row as the given pool's role; columns from `accountRow`. */
export function insertAccount(pool: pg.Pool, row: Record<string, unknown>): Promise<pg.QueryResult> {
  const columns = Object.keys(row);
  return pool.query(
    `INSERT INTO ledger_accounts (${columns.join(", ")})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row),
  );
}
