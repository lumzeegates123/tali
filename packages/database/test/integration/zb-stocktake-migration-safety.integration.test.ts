import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { fixtureTargetUrl } from "../support/fixtures.js";
import { sqlState } from "../support/pg.js";
import { prisma, type CliResult } from "../support/prisma-cli.js";

const STOCKTAKE_MIGRATION = "20261008120000_build2_stocktake";
const migrationsDir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("../../prisma/schema", import.meta.url));
const realMigration = readFileSync(join(migrationsDir, STOCKTAKE_MIGRATION, "migration.sql"), "utf8");

/** The failure is injected after the four replaced movement CHECKs are dropped and before they are re-added. */
const INJECTION_POINT = `    DROP CONSTRAINT "inventory_movements_reason_shape";\n`;
const REPLACED_CHECKS = [
  "inventory_movements_direction",
  "inventory_movements_one_source",
  "inventory_movements_reason_shape",
  "inventory_movements_type_valid",
];

/**
 * Everything a partial migration could leave behind in the public schema:
 * relations, columns, constraints with their definitions, indexes, and the
 * table and column privileges of the application role and PUBLIC.
 */
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

/**
 * Migration atomicity (plan 005, W3). Prisma 7.10 `migrate deploy` does not
 * wrap a migration file in a transaction, so the stocktake migration carries
 * its own BEGIN/COMMIT. This proves it on the disposable Prisma shadow
 * database (owned by tali_owner and reset by every drift check; never the
 * test database): the seven earlier migrations are applied, then a copy of
 * the stocktake migration that fails part-way, after the Slice 5 movement
 * CHECKs are dropped. The schema must be exactly the Slice 5 schema, the
 * migration not applied, and the real migration must then apply cleanly.
 */
describe("ZB. stocktake migration atomicity (failure injection on the shadow database)", () => {
  let shadowUrl: string;
  let workDir: string;
  let configPath: string;
  let shadow: pg.Client;
  let slice5: Fingerprint;
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
  const writeStocktakeMigration = (sql: string): void => {
    writeFileSync(join(workDir, "migrations", STOCKTAKE_MIGRATION, "migration.sql"), sql, "utf8");
  };
  const resetShadow = async (): Promise<void> => {
    await shadow.query(`SET client_min_messages = warning`);
    await shadow.query(`DROP SCHEMA public CASCADE`);
    await shadow.query(`CREATE SCHEMA public`);
    await shadow.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await shadow.query(`GRANT USAGE ON SCHEMA public TO tali_app`);
  };

  beforeAll(async () => {
    fixtureTargetUrl();
    const url = new URL(testDatabaseUrls().owner);
    url.pathname = `${url.pathname}_shadow`;
    shadowUrl = url.toString();
    expect(url.pathname).toMatch(/_test_shadow$/);

    workDir = mkdtempSync(join(tmpdir(), "tali-stocktake-atomicity-"));
    mkdirSync(join(workDir, "migrations"));
    cpSync(join(migrationsDir, "migration_lock.toml"), join(workDir, "migrations", "migration_lock.toml"));
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name < STOCKTAKE_MIGRATION) {
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

    const slice5Deploy = deploy("migrate", "deploy");
    expect(slice5Deploy.output).toMatch(/All migrations have been successfully applied/);
    expect(slice5Deploy.status).toBe(0);
    slice5 = await fingerprint();

    expect(realMigration.split(INJECTION_POINT)).toHaveLength(2);
    cpSync(join(migrationsDir, STOCKTAKE_MIGRATION), join(workDir, "migrations", STOCKTAKE_MIGRATION), {
      recursive: true,
    });
    writeStocktakeMigration(realMigration.replace(INJECTION_POINT, `${INJECTION_POINT}\nSELECT 1 / 0;\n`));
    failedDeploy = deploy("migrate", "deploy");
  }, 180_000);

  afterAll(async () => {
    await resetShadow();
    await shadow.end();
    rmSync(workDir, { recursive: true, force: true });
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

  it("the failure-injected migration fails the deploy", () => {
    expect(failedDeploy.status).not.toBe(0);
    expect(failedDeploy.output).toContain(STOCKTAKE_MIGRATION);
  });

  it("the failed migration is not recorded as applied; the earlier seven are", async () => {
    const { rows } = await shadow.query<{ migration_name: string; finished: boolean; rolled_back: boolean }>(
      `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(rows).toHaveLength(8);
    expect(rows.slice(0, 7).every((row) => row.finished && !row.rolled_back)).toBe(true);
    expect(rows[7]).toEqual({ migration_name: STOCKTAKE_MIGRATION, finished: false, rolled_back: false });
  });

  it("no stocktake table, line table or movement stocktake_id column exists", async () => {
    const { rows } = await shadow.query<{ stocktakes: string | null; lines: string | null }>(
      `SELECT to_regclass('public.stocktakes')::text AS stocktakes, to_regclass('public.stocktake_lines')::text AS lines`,
    );
    expect(rows[0]).toEqual({ stocktakes: null, lines: null });
    const column = await shadow.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'inventory_movements' AND column_name = 'stocktake_id'`,
    );
    expect(column.rows).toEqual([]);
  });

  it("the four Slice 5 movement CHECKs exist with their original definitions", async () => {
    const constraints = await items(FINGERPRINT_QUERIES.constraints);
    for (const name of REPLACED_CHECKS) {
      const original = slice5.constraints.filter((item) => item.startsWith(`inventory_movements.${name}:`));
      expect(original).toHaveLength(1);
      expect(constraints).toContain(original[0]);
    }
    expect(
      constraints.find((item) => item.startsWith("inventory_movements.inventory_movements_type_valid:")),
    ).not.toMatch(/COUNT_CORRECTION/);
  });

  it("the schema, indexes and grants are exactly the Slice 5 ones: nothing partial remains", async () => {
    expect(await fingerprint()).toEqual(slice5);
  });

  it("a COUNT_CORRECTION movement is still rejected by a CHECK", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const state = await sqlState(
      shadow.query(
        `INSERT INTO inventory_movements (business_id, id, location_id, variant_id, type, quantity_delta_minor,
           balance_after_minor, balance_version, opening_batch_id, actor_membership_id, source_channel,
           correlation_id, occurred_at, business_date, recorded_at)
         VALUES ($1, $1, $1, $1, 'COUNT_CORRECTION', 1, 1, 1, $1, $1, 'system', 'probe', now(), current_date, now())`,
        [id],
      ),
    );
    expect(state).toBe("23514");
  });

  it("after resolving the failure, the real migration applies and builds the full Slice 6 state", async () => {
    writeStocktakeMigration(realMigration);
    const resolved = deploy("migrate", "resolve", "--rolled-back", STOCKTAKE_MIGRATION);
    expect(resolved.status).toBe(0);
    const applied = deploy("migrate", "deploy");
    expect(applied.output).toMatch(/All migrations have been successfully applied/);
    expect(applied.status).toBe(0);

    const { rows } = await shadow.query<{ finished: boolean; rolled_back: boolean }>(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
      [STOCKTAKE_MIGRATION],
    );
    expect(rows).toEqual([
      { finished: false, rolled_back: true },
      { finished: true, rolled_back: false },
    ]);

    const slice6 = await fingerprint();
    expect(slice6.relations).toEqual(
      expect.arrayContaining([
        "stocktakes:r",
        "stocktake_lines:r",
        "stocktakes_one_draft:i",
        "stocktakes_business_id_id_location_id_key:i",
        "inventory_movements_count_correction_unique:i",
      ]),
    );
    expect(slice6.columns).toContain("inventory_movements.stocktake_id:uuid:YES");
    for (const name of [
      "inventory_movements_count_correction_source",
      "inventory_movements_count_correction_not_reversible",
      "inventory_movements_count_correction_no_pack",
      "inventory_movements_business_id_stocktake_id_variant_id_fkey",
      "inventory_movements_business_id_stocktake_id_location_id_fkey",
    ]) {
      expect(slice6.constraints.filter((item) => item.startsWith(`inventory_movements.${name}:`))).toHaveLength(1);
    }
    for (const name of REPLACED_CHECKS) {
      const after = slice6.constraints.find((item) => item.startsWith(`inventory_movements.${name}:`));
      expect(after).toMatch(/COUNT_CORRECTION|stocktake_id/);
    }

    // Every other Slice 5 object is unchanged: nothing was dropped or weakened.
    const replaced = new Set(REPLACED_CHECKS.map((name) => `inventory_movements.${name}:`));
    const keep = (item: string): boolean => ![...replaced].some((prefix) => item.startsWith(prefix));
    expect(slice6.constraints).toEqual(expect.arrayContaining(slice5.constraints.filter(keep)));
    for (const key of ["relations", "columns", "indexes", "tableGrants", "columnGrants"] as const) {
      expect(slice6[key]).toEqual(expect.arrayContaining(slice5[key]));
    }

    const newGrants = (list: string[]): string[] =>
      list.filter((item) => !slice5.tableGrants.includes(item) && !slice5.columnGrants.includes(item));
    expect(newGrants(slice6.tableGrants)).toEqual([
      "tali_app:stocktake_lines:INSERT",
      "tali_app:stocktake_lines:SELECT",
      "tali_app:stocktakes:INSERT",
      "tali_app:stocktakes:SELECT",
    ]);
    expect(newGrants(slice6.columnGrants).every((item) => item.endsWith(":UPDATE"))).toBe(true);
    expect(newGrants(slice6.columnGrants)).toHaveLength(16);
  });
});
