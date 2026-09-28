/**
 * Repository-style test adapters over the test-only fixture tables
 * (./fixtures.ts). They follow the intended adapter shape: take the opaque
 * TransactionScope, resolve the Prisma transaction client internally, use only
 * parameterized tagged-template SQL, and return plain or domain types.
 */
import type { TransactionScope } from "@tali/application";
import { type CurrencyCode, Money } from "@tali/domain";
import { transactionClient } from "../../src/unit-of-work/transaction-scope.js";

export interface ProbeRow {
  readonly id: string;
  readonly label: string;
  readonly counter: number;
}

export async function insertProbe(scope: TransactionScope, id: string, label: string): Promise<void> {
  await transactionClient(scope).$executeRaw`
    INSERT INTO test_fixtures.transaction_probe (id, label) VALUES (${id}::uuid, ${label})`;
}

export async function findProbe(scope: TransactionScope, id: string): Promise<ProbeRow | null> {
  const rows = await transactionClient(scope).$queryRaw<ProbeRow[]>`
    SELECT id::text AS id, label, counter FROM test_fixtures.transaction_probe WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

export async function currentIsolationLevel(scope: TransactionScope): Promise<string> {
  const rows = await transactionClient(scope).$queryRaw<{ level: string }[]>`
    SELECT current_setting('transaction_isolation') AS level`;
  return rows[0]?.level ?? "unknown";
}

/** SELECT ... FOR UPDATE: blocks until any other transaction holding the row lock finishes. */
export async function lockProbe(scope: TransactionScope, id: string): Promise<ProbeRow | null> {
  const rows = await transactionClient(scope).$queryRaw<ProbeRow[]>`
    SELECT id::text AS id, label, counter
    FROM test_fixtures.transaction_probe
    WHERE id = ${id}::uuid
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** SELECT ... FOR UPDATE NOWAIT: fails immediately (SQLSTATE 55P03) if the row is locked. */
export async function lockProbeNoWait(scope: TransactionScope, id: string): Promise<ProbeRow | null> {
  const rows = await transactionClient(scope).$queryRaw<ProbeRow[]>`
    SELECT id::text AS id, label, counter
    FROM test_fixtures.transaction_probe
    WHERE id = ${id}::uuid
    FOR UPDATE NOWAIT`;
  return rows[0] ?? null;
}

export async function setProbeCounter(scope: TransactionScope, id: string, counter: number): Promise<void> {
  await transactionClient(scope).$executeRaw`
    UPDATE test_fixtures.transaction_probe SET counter = ${counter} WHERE id = ${id}::uuid`;
}

export interface ClaimedJob {
  readonly id: string;
  readonly sequence: number;
}

/**
 * Claims up to `batchSize` unclaimed jobs. Rows locked by another in-flight
 * claim are skipped rather than waited on, so concurrent workers never block
 * each other and never receive the same row.
 */
export async function claimJobs(scope: TransactionScope, workerId: string, batchSize: number): Promise<ClaimedJob[]> {
  return transactionClient(scope).$queryRaw<ClaimedJob[]>`
    UPDATE test_fixtures.job_claim AS job
    SET claimed_by = ${workerId}, claimed_at = now()
    WHERE job.id IN (
      SELECT id FROM test_fixtures.job_claim
      WHERE claimed_by IS NULL
      ORDER BY sequence
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING job.id::text AS id, job.sequence`;
}

export async function saveAmount(scope: TransactionScope, id: string, amount: Money): Promise<void> {
  await transactionClient(scope).$executeRaw`
    INSERT INTO test_fixtures.bigint_probe (id, amount_minor) VALUES (${id}::uuid, ${amount.amountMinor})`;
}

/** Maps the BIGINT column straight into the domain Money type (bigint minor units). */
export async function loadAmount(scope: TransactionScope, id: string, currency: CurrencyCode): Promise<Money | null> {
  const rows = await transactionClient(scope).$queryRaw<{ amount_minor: bigint }[]>`
    SELECT amount_minor FROM test_fixtures.bigint_probe WHERE id = ${id}::uuid`;
  const row = rows[0];
  return row === undefined ? null : Money.ofMinor(row.amount_minor, currency);
}

export async function loadAmountRaw(scope: TransactionScope, id: string): Promise<unknown> {
  const rows = await transactionClient(scope).$queryRaw<{ amount_minor: unknown }[]>`
    SELECT amount_minor FROM test_fixtures.bigint_probe WHERE id = ${id}::uuid`;
  return rows[0]?.amount_minor;
}

export async function sumAmountsRaw(scope: TransactionScope): Promise<unknown> {
  const rows = await transactionClient(scope).$queryRaw<{ total: unknown }[]>`
    SELECT sum(amount_minor)::bigint AS total FROM test_fixtures.bigint_probe`;
  return rows[0]?.total;
}

export async function insertConstraintProbe(
  scope: TransactionScope,
  row: { readonly id: string; readonly scopeKey: string; readonly isDefault: boolean; readonly amountMinor: bigint },
): Promise<void> {
  await transactionClient(scope).$executeRaw`
    INSERT INTO test_fixtures.constraint_probe (id, scope_key, is_default, amount_minor)
    VALUES (${row.id}::uuid, ${row.scopeKey}, ${row.isDefault}, ${row.amountMinor})`;
}
