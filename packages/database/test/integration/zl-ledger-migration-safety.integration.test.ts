import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { fixtureTargetUrl } from "../support/fixtures.js";
import { prisma, type CliResult } from "../support/prisma-cli.js";

const LEDGER_MIGRATION = "20261016120000_build3_ledger_accounts";
const migrationsDir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("../../prisma/schema", import.meta.url));
const realMigration = readFileSync(join(migrationsDir, LEDGER_MIGRATION, "migration.sql"), "utf8");
/** The migration's SQL with comments removed, so prose cannot satisfy or trip a check. */
const migrationCode = realMigration
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/** The failure is injected after the table, keys and CHECKs exist and before the grant. */
const INJECTION_POINT = `GRANT SELECT, INSERT ON "ledger_accounts" TO tali_app;\n`;

/** Everything a partial migration could leave behind in the public schema (as in ZB). */
const FINGERPRINT_QUERIES = {
  relations: `SELECT c.relname || ':' || c.relkind::text AS item FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace`,
  columns: `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS item
    FROM information_schema.columns WHERE table_schema = 'public'`,
  constraints: `SELECT conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) AS item
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
  indexes: `SELECT indexname || ':' || indexdef AS item FROM pg_indexes WHERE schemaname = 'public'`,
  tableGrants: `SELECT grantee || ':' || table_name || ':' || privilege_type AS item FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee IN ('tali_app', 'PUBLIC')`,
  columnGrants: `SELECT grantee || ':' || table_name || '.' || column_name || ':' || privilege_type AS item
    FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND grantee IN ('tali_app', 'PUBLIC')
      AND (grantee, table_name, privilege_type) NOT IN (
        SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public')`,
} as const;

type Fingerprint = Record<keyof typeof FINGERPRINT_QUERIES, string[]>;

const OWNER_USER = "00000000-0000-7000-8000-00000000a001";
const BUSINESS_A = "00000000-0000-7000-8000-00000000b001";
const BUSINESS_B = "00000000-0000-7000-8000-00000000b002";

/**
 * ZL. Ledger accounts migration safety (Plan 005 S2), on the disposable Prisma
 * shadow database (never the test database), with Build 2 data already in
 * place: the migration is one explicit transaction and additive only; a copy
 * that fails part-way leaves the Build 2 schema and data exactly as they were;
 * the real migration then applies, changes no existing row, object or grant,
 * writes no ledger account (charts are provisioned by the application, never
 * backfilled), and adds only SELECT and INSERT for the application role.
 */
describe("ZL. ledger accounts migration safety (shadow database, Build 2 data present)", () => {
  let shadowUrl: string;
  let workDir: string;
  let configPath: string;
  let shadow: pg.Client;
  let build2: Fingerprint;
  let build2Data: Record<string, string>;
  let failedDeploy: CliResult;

  const deploy = (...args: string[]): CliResult => prisma([...args, "--config", configPath], shadowUrl);
  const items = async (sql: string): Promise<string[]> =>
    (await shadow.query<{ item: string }>(`SELECT item FROM (${sql}) AS q ORDER BY item COLLATE "C"`)).rows.map(
      (row) => row.item,
    );
  const fingerprint = async (): Promise<Fingerprint> => {
    const result: Partial<Fingerprint> = {};
    for (const [key, sql] of Object.entries(FINGERPRINT_QUERIES)) {
      result[key as keyof Fingerprint] = await items(sql);
    }
    return result as Fingerprint;
  };
  /** A content hash of every row of every public table except Prisma's own, keyed by table. */
  const dataHashes = async (): Promise<Record<string, string>> => {
    const tables = await shadow.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' AND tablename <> 'ledger_accounts'
       ORDER BY tablename COLLATE "C"`,
    );
    const hashes: Record<string, string> = {};
    for (const { name } of tables.rows) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const { rows } = await shadow.query<{ hash: string; n: number }>(
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash, count(*)::int AS n
         FROM public.${quoted} t`,
      );
      hashes[name] = `${rows[0]?.n}:${rows[0]?.hash}`;
    }
    return hashes;
  };
  const writeLedgerMigration = (sql: string): void => {
    writeFileSync(join(workDir, "migrations", LEDGER_MIGRATION, "migration.sql"), sql, "utf8");
  };
  const resetShadow = async (): Promise<void> => {
    await shadow.query(`SET client_min_messages = warning`);
    await shadow.query(`DROP SCHEMA public CASCADE`);
    await shadow.query(`CREATE SCHEMA public`);
    await shadow.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await shadow.query(`GRANT USAGE ON SCHEMA public TO tali_app`);
  };
  /**
   * Build 1 and Build 2 rows as they exist in an environment before S2, for
   * two businesses with no chart: identity and tenancy, a categorized product
   * with a priced default variant and its price history, opening stock (batch,
   * movement and balance), a draft stocktake with a counted line, a business
   * audit record and a keyed user idempotency record.
   */
  const seedBuild2Data = async (): Promise<void> => {
    const at = "2026-10-10T08:00:00.000Z";
    await shadow.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Ada', 'ACTIVE', $2, $2)`,
      [OWNER_USER, at],
    );
    for (const [index, businessId] of [BUSINESS_A, BUSINESS_B].entries()) {
      const n = index + 1;
      const location = `00000000-0000-7000-8000-00000000c00${n}`;
      const membership = `00000000-0000-7000-8000-00000000d00${n}`;
      const category = `00000000-0000-7000-8000-00000000e00${n}`;
      const product = `00000000-0000-7000-8000-00000000f00${n}`;
      const variant = `00000000-0000-7000-8000-00000000f10${n}`;
      const batch = `00000000-0000-7000-8000-00000000f20${n}`;
      const movement = `00000000-0000-7000-8000-00000000f30${n}`;
      const stocktake = `00000000-0000-7000-8000-00000000f40${n}`;
      await shadow.query(
        `INSERT INTO businesses (id, name, currency_code, time_zone, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, 'NGN', 'Africa/Lagos', 'ACTIVE', $3, $4, $4)`,
        [businessId, `Shop ${index}`, OWNER_USER, at],
      );
      await shadow.query(
        `INSERT INTO business_locations (business_id, id, name, is_default, status, created_at, updated_at)
         VALUES ($1, $2, 'Main', true, 'ACTIVE', $3, $3)`,
        [businessId, location, at],
      );
      await shadow.query(
        `INSERT INTO business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 1, $4, $4)`,
        [businessId, membership, OWNER_USER, at],
      );
      await shadow.query(
        `INSERT INTO product_categories (business_id, id, name, normalized_name, status, version, created_at, updated_at)
         VALUES ($1, $2, 'Drinks', 'drinks', 'ACTIVE', 1, $3, $3)`,
        [businessId, category, at],
      );
      await shadow.query(
        `INSERT INTO products (business_id, id, name, category_id, status, version, created_by_membership_id,
           created_at, updated_at)
         VALUES ($1, $2, 'Malt drink 33cl', $3, 'ACTIVE', 1, $4, $5, $5)`,
        [businessId, product, category, membership, at],
      );
      await shadow.query(
        `INSERT INTO product_variants (business_id, id, product_id, is_default, status, stock_unit_code, track_inventory,
           current_price_minor, current_price_currency, price_version, version, created_at, updated_at)
         VALUES ($1, $2, $3, true, 'ACTIVE', 'PIECE', true, 50000, 'NGN', 1, 1, $4, $4)`,
        [businessId, variant, product, at],
      );
      await shadow.query(
        `INSERT INTO product_variant_prices (business_id, id, variant_id, amount_minor, currency, price_version,
           effective_at, set_by_membership_id, reason)
         VALUES ($1, $2, $3, 50000, 'NGN', 1, $4, $5, NULL)`,
        [businessId, `00000000-0000-7000-8000-00000000f50${n}`, variant, at, membership],
      );
      await shadow.query(
        `INSERT INTO inventory_opening_batches (business_id, id, location_id, actor_membership_id, source_channel,
           correlation_id, occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, $4, 'api', 'seed', $5, '2026-10-10', $5)`,
        [businessId, batch, location, membership, at],
      );
      await shadow.query(
        `INSERT INTO inventory_movements (business_id, id, location_id, variant_id, type, quantity_delta_minor,
           balance_after_minor, balance_version, opening_batch_id, actor_membership_id, source_channel, correlation_id,
           occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, $4, 'OPENING', 24, 24, 1, $5, $6, 'api', 'seed', $7, '2026-10-10', $7)`,
        [businessId, movement, location, variant, batch, membership, at],
      );
      await shadow.query(
        `INSERT INTO inventory_balances (business_id, location_id, variant_id, quantity_minor, version, last_movement_id,
           updated_at)
         VALUES ($1, $2, $3, 24, 1, $4, $5)`,
        [businessId, location, variant, movement, at],
      );
      await shadow.query(
        `INSERT INTO stocktakes (business_id, id, location_id, status, version, created_by_membership_id, created_at)
         VALUES ($1, $2, $3, 'DRAFT', 1, $4, $5)`,
        [businessId, stocktake, location, membership, at],
      );
      await shadow.query(
        `INSERT INTO stocktake_lines (business_id, stocktake_id, variant_id, status, counted_quantity_minor,
           stock_unit_code, expected_at_count_minor, balance_version_at_count, version, counted_by_membership_id,
           counted_at)
         VALUES ($1, $2, $3, 'COUNTED', 23, 'PIECE', 24, 1, 1, $4, $5)`,
        [businessId, stocktake, variant, membership, at],
      );
      await shadow.query(
        `INSERT INTO business_audit_records (business_id, id, occurred_at, action, entity_type, entity_id, actor_type,
           actor_user_id, actor_membership_id, source_channel, correlation_id, payload, payload_schema_version)
         VALUES ($1, $2, $3, 'business.created', 'business', $1, 'user', $4, $5, 'api', 'seed',
           '{"currencyCode":"NGN","timeZone":"Africa/Lagos","status":"ACTIVE"}'::json, 1)`,
        [businessId, `00000000-0000-7000-8000-00000000f60${n}`, at, OWNER_USER, membership],
      );
      await shadow.query(
        `INSERT INTO user_idempotency_records (user_id, id, actor_type, actor_id, operation, idempotency_key,
           fingerprint, fingerprint_version, result, resource_type, resource_id, created_at, expires_at)
         VALUES ($1, $2, 'user', $7, 'business.create.v1', $3, $4, 1, '{}'::json, 'business', $5, $6,
           '2026-11-10T08:00:00.000Z')`,
        [
          OWNER_USER,
          `00000000-0000-7000-8000-00000000f70${n}`,
          `00000000-0000-4000-8000-00000000f80${n}`,
          Buffer.alloc(32, n),
          businessId,
          at,
          OWNER_USER,
        ],
      );
    }
  };

  /** The Build 2 tables the seed must populate (row counts are part of every data hash). */
  const SEEDED_TABLES = [
    "users",
    "businesses",
    "business_locations",
    "business_memberships",
    "product_categories",
    "products",
    "product_variants",
    "product_variant_prices",
    "inventory_opening_batches",
    "inventory_movements",
    "inventory_balances",
    "stocktakes",
    "stocktake_lines",
    "business_audit_records",
    "user_idempotency_records",
  ];

  beforeAll(async () => {
    fixtureTargetUrl();
    const url = new URL(testDatabaseUrls().owner);
    url.pathname = `${url.pathname}_shadow`;
    shadowUrl = url.toString();
    expect(url.pathname).toMatch(/_test_shadow$/);

    workDir = mkdtempSync(join(tmpdir(), "tali-ledger-migration-"));
    mkdirSync(join(workDir, "migrations"));
    cpSync(join(migrationsDir, "migration_lock.toml"), join(workDir, "migrations", "migration_lock.toml"));
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name < LEDGER_MIGRATION) {
        cpSync(join(migrationsDir, entry.name), join(workDir, "migrations", entry.name), { recursive: true });
      }
    }
    configPath = join(workDir, "prisma.config.mjs");
    const posix = (path: string): string => JSON.stringify(path.replaceAll("\\", "/"));
    writeFileSync(
      configPath,
      `export default { schema: ${posix(schemaDir)}, migrations: { path: ${posix(join(workDir, "migrations"))} }, ` +
        `datasource: { url: process.env.MIGRATION_DATABASE_URL } };\n`,
      "utf8",
    );

    shadow = new pg.Client({ connectionString: shadowUrl });
    await shadow.connect();
    await resetShadow();

    const build2Deploy = deploy("migrate", "deploy");
    expect(build2Deploy.output).toMatch(/All migrations have been successfully applied/);
    expect(build2Deploy.status).toBe(0);
    await seedBuild2Data();
    build2 = await fingerprint();
    build2Data = await dataHashes();

    expect(realMigration.split(INJECTION_POINT)).toHaveLength(2);
    cpSync(join(migrationsDir, LEDGER_MIGRATION), join(workDir, "migrations", LEDGER_MIGRATION), { recursive: true });
    writeLedgerMigration(realMigration.replace(INJECTION_POINT, `SELECT 1 / 0;\n${INJECTION_POINT}`));
    failedDeploy = deploy("migrate", "deploy");
  }, 180_000);

  afterAll(async () => {
    await resetShadow();
    await shadow.end();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("representative Build 2 data exists before the S2 migration", () => {
    for (const table of SEEDED_TABLES) {
      const count = Number(build2Data[table]?.split(":")[0]);
      expect({ table, populated: count > 0 }).toEqual({ table, populated: true });
    }
  });

  it("the real migration is one explicit transaction: BEGIN first, COMMIT last, nothing outside", () => {
    const statements = realMigration
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
    expect(statements[0]).toBe("BEGIN;");
    expect(statements.at(-1)).toBe("COMMIT;");
    expect(statements.filter((line) => /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/i.test(line))).toEqual([
      "BEGIN;",
      "COMMIT;",
    ]);
  });

  it("the migration is additive only: it touches no existing table and writes, changes or deletes no row", () => {
    const statements = migrationCode
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement !== "");
    expect(statements.filter((statement) => !/^(BEGIN|COMMIT|CREATE|ALTER TABLE|GRANT)\b/i.test(statement))).toEqual(
      [],
    );
    expect(migrationCode).not.toMatch(/\b(TRUNCATE|DROP|RENAME|COPY)\b/i);
    expect(migrationCode).not.toMatch(/\b(CASCADE|TRIGGER|FUNCTION|PROCEDURE|POLICY|ROW LEVEL SECURITY)\b/i);
    const altered = [...migrationCode.matchAll(/ALTER TABLE\s+"([^"]+)"/gi)].map((match) => match[1]);
    expect(new Set(altered)).toEqual(new Set(["ledger_accounts"]));
    const created = [...migrationCode.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX)\s+"[^"]+"(?:\s+ON\s+"([^"]+)")?/gi)];
    expect(created.every((match) => match[1] === undefined || match[1] === "ledger_accounts")).toBe(true);
    expect([...migrationCode.matchAll(/\bGRANT\b[^;]*;/gi)].map((match) => match[0])).toEqual([
      `GRANT SELECT, INSERT ON "ledger_accounts" TO tali_app;`,
    ]);
    expect(migrationCode).not.toMatch(/journal/i);
  });

  it("the failure-injected migration fails the deploy and is not recorded as applied", async () => {
    expect(failedDeploy.status).not.toBe(0);
    expect(failedDeploy.output).toContain(LEDGER_MIGRATION);
    const { rows } = await shadow.query<{ migration_name: string; finished: boolean }>(
      `SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(rows.at(-1)).toEqual({ migration_name: LEDGER_MIGRATION, finished: false });
    expect(rows.slice(0, -1).every((row) => row.finished)).toBe(true);
  });

  it("after the failure, the schema, grants and Build 2 data are exactly as before: nothing partial remains", async () => {
    const { rows } = await shadow.query(`SELECT to_regclass('public.ledger_accounts')::text AS accounts`);
    expect(rows[0]).toEqual({ accounts: null });
    expect(await fingerprint()).toEqual(build2);
    expect(await dataHashes()).toEqual(build2Data);
  });

  it("the real migration then applies: Build 2 data unchanged, no ledger account written, only additive objects", async () => {
    writeLedgerMigration(realMigration);
    const resolved = deploy("migrate", "resolve", "--rolled-back", LEDGER_MIGRATION);
    expect(resolved.status).toBe(0);
    const applied = deploy("migrate", "deploy");
    expect(applied.output).toMatch(/All migrations have been successfully applied/);
    expect(applied.status).toBe(0);

    expect(await dataHashes()).toEqual(build2Data);
    const accounts = await shadow.query(`SELECT count(*)::int AS n FROM ledger_accounts`);
    expect(accounts.rows[0]).toEqual({ n: 0 });

    const after = await fingerprint();
    for (const key of Object.keys(FINGERPRINT_QUERIES) as (keyof Fingerprint)[]) {
      expect(after[key]).toEqual(expect.arrayContaining(build2[key]));
    }
    const added = (key: keyof Fingerprint) => after[key].filter((item) => !build2[key].includes(item));
    expect(added("relations")).toEqual([
      "ledger_accounts:r",
      "ledger_accounts_business_id_code_key:i",
      "ledger_accounts_business_id_id_key:i",
      "ledger_accounts_business_id_system_role_key:i",
      "ledger_accounts_pkey:i",
    ]);
    expect(added("constraints").every((item) => item.startsWith("ledger_accounts."))).toBe(true);
    // Primary key, tenant foreign key and the nine CHECKs (the unique keys are indexes), plus the
    // NOT NULL constraints PostgreSQL 18 records for the nine required columns.
    const notNull = added("constraints").filter((item) => item.includes(":NOT NULL "));
    expect(notNull).toHaveLength(9);
    expect(added("constraints").filter((item) => !notNull.includes(item))).toHaveLength(11);
    expect(added("tableGrants")).toEqual(["tali_app:ledger_accounts:INSERT", "tali_app:ledger_accounts:SELECT"]);
    expect(added("columnGrants")).toEqual([]);
  });
});
