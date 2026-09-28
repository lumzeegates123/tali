import type pg from "pg";

/**
 * Test-only fixture tables for the database foundation regression tests
 * (transactions, row locking, SKIP LOCKED, BIGINT, constraints, role
 * protection). They are NOT domain schema and NOT part of the migration chain:
 * the integration global setup creates them in the disposable `*_test`
 * database after `prisma migrate deploy`, and the teardown drops them.
 *
 * They replace the Wave B foundation_spike tables, which were removed by
 * migration 20260928025500_remove_foundation_spike. The DDL deliberately
 * mirrors that spike (including custom constraints and grant-based
 * append-only protection) so the ADR-002 criteria stay under regression test.
 */
export const FIXTURE_SCHEMA = "test_fixtures";

export const FIXTURE_TABLES = [
  "transaction_probe",
  "job_claim",
  "bigint_probe",
  "constraint_probe",
  "protected_entry",
] as const;

const CREATE_FIXTURES = `
DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE;
CREATE SCHEMA ${FIXTURE_SCHEMA};
REVOKE ALL ON SCHEMA ${FIXTURE_SCHEMA} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${FIXTURE_SCHEMA} TO tali_app;

CREATE TABLE ${FIXTURE_SCHEMA}.transaction_probe (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  counter integer NOT NULL DEFAULT 0
);
CREATE TABLE ${FIXTURE_SCHEMA}.job_claim (
  id uuid PRIMARY KEY,
  sequence integer NOT NULL UNIQUE,
  claimed_by text,
  claimed_at timestamptz(3)
);
CREATE TABLE ${FIXTURE_SCHEMA}.bigint_probe (
  id uuid PRIMARY KEY,
  amount_minor bigint NOT NULL
);
CREATE TABLE ${FIXTURE_SCHEMA}.constraint_probe (
  id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  amount_minor bigint NOT NULL,
  CONSTRAINT constraint_probe_amount_minor_non_negative CHECK (amount_minor >= 0)
);
CREATE UNIQUE INDEX constraint_probe_one_default_per_scope
  ON ${FIXTURE_SCHEMA}.constraint_probe (scope_key) WHERE is_default;
CREATE TABLE ${FIXTURE_SCHEMA}.protected_entry (
  id uuid PRIMARY KEY,
  note text NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz(3) NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  ${FIXTURE_SCHEMA}.transaction_probe,
  ${FIXTURE_SCHEMA}.job_claim,
  ${FIXTURE_SCHEMA}.bigint_probe,
  ${FIXTURE_SCHEMA}.constraint_probe
  TO tali_app;
GRANT SELECT, INSERT ON ${FIXTURE_SCHEMA}.protected_entry TO tali_app;
REVOKE UPDATE, DELETE, TRUNCATE ON ${FIXTURE_SCHEMA}.protected_entry FROM tali_app;
`;

/** Runs as the owner role against the disposable test database only. */
export async function createFixtures(owner: pg.Client | pg.Pool): Promise<void> {
  await owner.query(CREATE_FIXTURES);
}

export async function dropFixtures(owner: pg.Client | pg.Pool): Promise<void> {
  await owner.query(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
}

export async function truncateFixtures(owner: pg.Pool): Promise<void> {
  await owner.query(`TRUNCATE ${FIXTURE_TABLES.map((table) => `${FIXTURE_SCHEMA}.${table}`).join(", ")}`);
}
