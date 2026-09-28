import pg from "pg";
import { testDatabaseUrls } from "../../src/testing/index.js";

/**
 * Test-only fixture tables for the database foundation regression tests
 * (transactions, row locking, SKIP LOCKED, BIGINT, constraints, role
 * protection). They are NOT domain schema and NEVER part of the Prisma
 * migration chain (scripts/verify-schema.mjs fails if a migration mentions
 * test_fixtures, or if the schema exists in a verified database). The
 * integration global setup creates them after `prisma migrate deploy` and the
 * teardown drops them.
 *
 * The DDL is destructive (DROP SCHEMA ... CASCADE, TRUNCATE), so every entry
 * point fails closed unless all of these hold, checked before any statement:
 *
 * 1. the process is explicitly the test environment: TALI_ENV=test;
 * 2. the target is the configured integration-test database
 *    (TEST_MIGRATION_DATABASE_URL, default docker-compose `postgres-test`):
 *    a loopback host and a database named *_test;
 * 3. the live session confirms it: current_database() and current_user are
 *    exactly that database and role.
 *
 * The schema name is never treated as evidence of a safe target.
 */
export const FIXTURE_SCHEMA = "test_fixtures";

export const FIXTURE_TABLES = [
  "transaction_probe",
  "job_claim",
  "bigint_probe",
  "constraint_probe",
  "protected_entry",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

export class FixtureSafetyError extends Error {
  constructor(message: string) {
    super(`Refusing to run test-fixture DDL: ${message}`);
    this.name = "FixtureSafetyError";
  }
}

/** Checks 1 and 2. Returns the only connection string fixture DDL may use. */
export function fixtureTargetUrl(env: Env = process.env): string {
  if (env["TALI_ENV"] !== "test") {
    throw new FixtureSafetyError(`TALI_ENV must be "test" (found ${JSON.stringify(env["TALI_ENV"] ?? null)})`);
  }
  try {
    return testDatabaseUrls(env).owner;
  } catch (error) {
    throw new FixtureSafetyError(error instanceof Error ? error.message : String(error));
  }
}

interface SessionIdentity {
  database: string;
  user: string;
}

interface Queryable {
  query(sql: string): Promise<{ rows: Partial<SessionIdentity>[] }>;
}

/** Check 3: the server, not the URL, confirms which database and role this session is. */
export async function assertFixtureSession(session: Queryable, targetUrl: string): Promise<void> {
  const url = new URL(targetUrl);
  const expectedDatabase = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const expectedUser = decodeURIComponent(url.username);
  const { rows } = await session.query("SELECT current_database() AS database, current_user AS user");
  const actual = rows[0];
  if (actual?.database !== expectedDatabase || !expectedDatabase.endsWith("_test") || actual.user !== expectedUser) {
    throw new FixtureSafetyError(
      `connected session is ${actual?.user ?? "?"}@${actual?.database ?? "?"}, expected ${expectedUser}@${expectedDatabase}`,
    );
  }
}

async function withFixtureSession(env: Env, work: (client: pg.Client) => Promise<void>): Promise<void> {
  const target = fixtureTargetUrl(env);
  const client = new pg.Client({ connectionString: target, application_name: "tali-test-fixtures" });
  await client.connect();
  try {
    await assertFixtureSession(client, target);
    await work(client);
  } finally {
    await client.end();
  }
}

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

export async function createFixtures(env: Env = process.env): Promise<void> {
  await withFixtureSession(env, async (client) => {
    await client.query(CREATE_FIXTURES);
  });
}

export async function dropFixtures(env: Env = process.env): Promise<void> {
  await withFixtureSession(env, async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS ${FIXTURE_SCHEMA} CASCADE`);
  });
}

export async function truncateFixtures(env: Env = process.env): Promise<void> {
  await withFixtureSession(env, async (client) => {
    await client.query(`TRUNCATE ${FIXTURE_TABLES.map((table) => `${FIXTURE_SCHEMA}.${table}`).join(", ")}`);
  });
}
