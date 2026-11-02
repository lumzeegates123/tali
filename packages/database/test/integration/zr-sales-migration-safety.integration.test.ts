import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { fixtureTargetUrl } from "../support/fixtures.js";
import { prisma, type CliResult } from "../support/prisma-cli.js";

const SALES_MIGRATION = "20261101120000_build3_sales_persistence";
const migrationsDir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("../../prisma/schema", import.meta.url));
const realMigration = readFileSync(join(migrationsDir, SALES_MIGRATION, "migration.sql"), "utf8");
const migrationCode = realMigration
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

/** After the movement CHECKs are dropped and re-added, before the journal source CHECK is replaced. */
const INJECTION_POINT = "-- F. The journal source CHECK gains the sale as a sixth typed source.";

const SALES_TABLES = ["sale_lines", "sale_receipt_sequences", "sale_tenders", "sales"];

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
const AT = "2026-10-20T08:00:00.000Z";

const CHART: readonly [string, string, string, string, string][] = [
  ["CASH_ON_HAND", "1000", "Cash on hand", "ASSET", "DEBIT"],
  ["BANK_TRANSFER_PENDING", "1010", "Bank transfers pending verification", "ASSET", "DEBIT"],
  ["POS_CARD_CLEARING", "1020", "POS/card clearing", "ASSET", "DEBIT"],
  ["OTHER_TENDER_CLEARING", "1030", "Other tender clearing", "ASSET", "DEBIT"],
  ["INVENTORY", "1200", "Inventory", "ASSET", "DEBIT"],
  ["TAX_PAYABLE", "2100", "Tax payable", "LIABILITY", "CREDIT"],
  ["GOODS_RECEIVED_NOT_INVOICED", "2200", "Goods received not invoiced", "LIABILITY", "CREDIT"],
  ["OPENING_BALANCE_EQUITY", "3000", "Opening balance equity", "EQUITY", "CREDIT"],
  ["SALES_REVENUE", "4000", "Sales revenue", "REVENUE", "CREDIT"],
  ["SALES_DISCOUNTS", "4010", "Sales discounts", "CONTRA_REVENUE", "DEBIT"],
  ["INVENTORY_GAIN", "4100", "Inventory gains", "REVENUE", "CREDIT"],
  ["COST_OF_GOODS_SOLD", "5000", "Cost of goods sold", "EXPENSE", "DEBIT"],
  ["INVENTORY_SHRINKAGE", "5100", "Inventory shrinkage", "EXPENSE", "DEBIT"],
];
const accountId = (n: number, role: string) =>
  `00000000-0000-7000-8000-${n}${String(CHART.findIndex(([r]) => r === role)).padStart(11, "0")}`;

/**
 * ZR. The Build 3 S5 sales migration on a shadow database at the S4 schema
 * with representative pre-sales data: a failure injected after the movement
 * CHECKs are replaced aborts the whole file, leaving schema, grants and data
 * exactly as before; the real migration then applies without touching any
 * existing row (every movement and journal keeps a NULL sale source) and
 * creates empty sales tables.
 */
describe("ZR. sales migration safety (shadow database, S4 applied)", () => {
  let shadowUrl: string;
  let workDir: string;
  let configPath: string;
  let shadow: pg.Client;
  let before: Fingerprint;
  let beforeData: Record<string, string>;
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
  /** Row hashes per table; the new sale_id column is projected away, so a row unchanged by the migration hashes equal. */
  const dataHashes = async (): Promise<Record<string, string>> => {
    const tables = await shadow.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
       ORDER BY tablename COLLATE "C"`,
    );
    const hashes: Record<string, string> = {};
    for (const { name } of tables.rows) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const { rows } = await shadow.query<{ hash: string; n: number }>(
        `SELECT md5(coalesce(string_agg(r, '|' ORDER BY r), '')) AS hash, count(*)::int AS n
         FROM (SELECT (to_jsonb(t) - 'sale_id')::text AS r FROM public.${quoted} t) AS q`,
      );
      hashes[name] = `${rows[0]?.n}:${rows[0]?.hash}`;
    }
    return hashes;
  };
  const writeMigration = (sql: string): void => {
    writeFileSync(join(workDir, "migrations", SALES_MIGRATION, "migration.sql"), sql, "utf8");
  };
  const resetShadow = async (): Promise<void> => {
    await shadow.query(`SET client_min_messages = warning`);
    await shadow.query(`DROP SCHEMA public CASCADE`);
    await shadow.query(`CREATE SCHEMA public`);
    await shadow.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await shadow.query(`GRANT USAGE ON SCHEMA public TO tali_app`);
  };
  const columnExists = async (table: string, column: string): Promise<boolean> => {
    const { rows } = await shadow.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows[0]?.n === 1;
  };

  const seedS4Data = async (): Promise<void> => {
    await shadow.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Ada', 'ACTIVE', $2, $2)`,
      [OWNER_USER, AT],
    );
    for (const [index, businessId] of [BUSINESS_A, BUSINESS_B].entries()) {
      const n = index + 1;
      const location = `00000000-0000-7000-8000-00000000c00${n}`;
      const membership = `00000000-0000-7000-8000-00000000d00${n}`;
      const product = `00000000-0000-7000-8000-00000000f00${n}`;
      const variant = `00000000-0000-7000-8000-00000000f10${n}`;
      const batch = `00000000-0000-7000-8000-00000000f20${n}`;
      const movement = `00000000-0000-7000-8000-00000000f30${n}`;
      const entry = `00000000-0000-7000-8000-00000000f40${n}`;
      await shadow.query(
        `INSERT INTO businesses (id, name, currency_code, time_zone, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, 'NGN', 'Africa/Lagos', 'ACTIVE', $3, $4, $4)`,
        [businessId, `Shop ${index}`, OWNER_USER, AT],
      );
      await shadow.query(
        `INSERT INTO business_locations (business_id, id, name, is_default, status, created_at, updated_at)
         VALUES ($1, $2, 'Main', true, 'ACTIVE', $3, $3)`,
        [businessId, location, AT],
      );
      await shadow.query(
        `INSERT INTO business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 1, $4, $4)`,
        [businessId, membership, OWNER_USER, AT],
      );
      for (const [systemRole, code, name, type, normal] of CHART) {
        await shadow.query(
          `INSERT INTO ledger_accounts (business_id, id, code, name, type, normal_balance, system_role, template_version,
             status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
          [businessId, accountId(n, systemRole), code, name, type, normal, systemRole, AT],
        );
      }
      await shadow.query(
        `INSERT INTO products (business_id, id, name, status, version, created_by_membership_id, created_at, updated_at)
         VALUES ($1, $2, 'Malt drink 33cl', 'ACTIVE', 1, $3, $4, $4)`,
        [businessId, product, membership, AT],
      );
      await shadow.query(
        `INSERT INTO product_variants (business_id, id, product_id, is_default, status, stock_unit_code, track_inventory,
           current_price_minor, current_price_currency, price_version, version, created_at, updated_at)
         VALUES ($1, $2, $3, true, 'ACTIVE', 'PIECE', true, 50000, 'NGN', 1, 1, $4, $4)`,
        [businessId, variant, product, AT],
      );
      await shadow.query(
        `INSERT INTO inventory_opening_batches (business_id, id, location_id, actor_membership_id, source_channel,
           correlation_id, occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, $4, 'api', 'seed', $5, '2026-10-20', $5)`,
        [businessId, batch, location, membership, AT],
      );
      await shadow.query(
        `INSERT INTO inventory_movements (business_id, id, location_id, variant_id, type, quantity_delta_minor,
           balance_after_minor, balance_version, opening_batch_id, actor_membership_id, source_channel, correlation_id,
           occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, $4, 'OPENING', 24, 24, 1, $5, $6, 'api', 'seed', $7, '2026-10-20', $7)`,
        [businessId, movement, location, variant, batch, membership, AT],
      );
      await shadow.query(
        `INSERT INTO inventory_balances (business_id, location_id, variant_id, quantity_minor, version, last_movement_id,
           updated_at)
         VALUES ($1, $2, $3, 24, 1, $4, $5)`,
        [businessId, location, variant, movement, AT],
      );
      await shadow.query(
        `INSERT INTO journal_entries (business_id, id, currency, occurred_at, business_date, recorded_at, entry_kind,
           opening_batch_id, posting_rule, posting_rule_version, description, actor_membership_id, location_id,
           source_channel, correlation_id)
         VALUES ($1, $2, 'NGN', $3, '2026-10-20', $3, 'ORIGINAL', $4, 'OPENING_STOCK_VALUED', 1, 'Opening stock', $5,
           $6, 'api', 'seed')`,
        [businessId, entry, AT, batch, membership, location],
      );
      for (const [lineNumber, role, direction] of [
        [1, "INVENTORY", "DEBIT"],
        [2, "OPENING_BALANCE_EQUITY", "CREDIT"],
      ] as const) {
        await shadow.query(
          `INSERT INTO journal_lines (business_id, entry_id, line_number, account_id, direction, amount_minor, currency)
           VALUES ($1, $2, $3, $4, $5, 120000, 'NGN')`,
          [businessId, entry, lineNumber, accountId(n, role), direction],
        );
      }
    }
  };

  const SEEDED_TABLES = [
    "users",
    "businesses",
    "business_locations",
    "business_memberships",
    "ledger_accounts",
    "products",
    "product_variants",
    "inventory_opening_batches",
    "inventory_movements",
    "inventory_balances",
    "journal_entries",
    "journal_lines",
  ];

  beforeAll(async () => {
    fixtureTargetUrl();
    const url = new URL(testDatabaseUrls().owner);
    url.pathname = `${url.pathname}_shadow`;
    shadowUrl = url.toString();
    expect(url.pathname).toMatch(/_test_shadow$/);

    workDir = mkdtempSync(join(tmpdir(), "tali-sales-migration-"));
    mkdirSync(join(workDir, "migrations"));
    cpSync(join(migrationsDir, "migration_lock.toml"), join(workDir, "migrations", "migration_lock.toml"));
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name < SALES_MIGRATION) {
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

    const s4Deploy = deploy("migrate", "deploy");
    expect(s4Deploy.output).toMatch(/All migrations have been successfully applied/);
    expect(s4Deploy.status).toBe(0);
    await seedS4Data();
    before = await fingerprint();
    beforeData = await dataHashes();

    expect(realMigration.split(INJECTION_POINT)).toHaveLength(2);
    cpSync(join(migrationsDir, SALES_MIGRATION), join(workDir, "migrations", SALES_MIGRATION), { recursive: true });
    writeMigration(realMigration.replace(INJECTION_POINT, `SELECT 1 / 0;\n${INJECTION_POINT}`));
    failedDeploy = deploy("migrate", "deploy");
  }, 180_000);

  afterAll(async () => {
    await resetShadow();
    await shadow.end();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("representative S4 data exists and there is no sales table or sale column before the migration", async () => {
    for (const table of SEEDED_TABLES) {
      const count = Number(beforeData[table]?.split(":")[0]);
      expect({ table, populated: count > 0 }).toEqual({ table, populated: true });
    }
    for (const table of SALES_TABLES) expect(beforeData[table]).toBeUndefined();
    expect(before.columns.filter((column) => column.includes(".sale_id:"))).toEqual([]);
  });

  it("the real migration is one explicit transaction, additive, with no cascade, trigger, function, delete grant or PUBLIC grant", () => {
    const statements = realMigration
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
    expect(statements[0]).toBe("BEGIN;");
    expect(statements.at(-1)).toBe("COMMIT;");
    expect(migrationCode).not.toMatch(/\b(TRUNCATE|DROP TABLE|DROP COLUMN|DROP INDEX|RENAME|COPY)\b/i);
    expect(migrationCode).not.toMatch(/\b(INSERT INTO|UPDATE\s+"|DELETE\s+FROM)\b/i);
    expect(migrationCode).not.toMatch(/\bCASCADE\b/i);
    expect(migrationCode).not.toMatch(/\b(TRIGGER|FUNCTION|PROCEDURE|ROW LEVEL SECURITY|CREATE\s+POLICY)\b/i);
    expect(migrationCode).not.toMatch(/\bGRANT\b[^;]*\b(DELETE|TRUNCATE|ALL)\b/i);
    expect(migrationCode).not.toMatch(/\bTO\s+PUBLIC\b/i);
  });

  it("every constraint the migration drops it re-adds under the same name", () => {
    const dropped = [...migrationCode.matchAll(/DROP\s+CONSTRAINT\s+"([a-z_]+)"/gi)].map((m) => m[1]);
    const added = new Set([...migrationCode.matchAll(/ADD\s+CONSTRAINT\s+"([a-z_]+)"/gi)].map((m) => m[1]));
    expect(dropped.sort()).toEqual([
      "inventory_movements_direction",
      "inventory_movements_one_source",
      "inventory_movements_reason_shape",
      "inventory_movements_type_valid",
      "journal_entries_one_source",
    ]);
    for (const name of dropped) expect(added).toContain(name);
  });

  it("only the two forward-pointing sale FKs are deferrable", () => {
    const deferrable = [...migrationCode.matchAll(/ADD CONSTRAINT "([a-z_]+)"[^;]*\bDEFERRABLE\b/g)].map((m) => m[1]);
    expect(deferrable.sort()).toEqual(["sale_lines_movement_fkey", "sales_original_journal_fkey"]);
    expect(migrationCode).not.toMatch(/NOT DEFERRABLE|INITIALLY IMMEDIATE/);
  });

  it("the failure-injected migration fails the deploy and is not recorded as applied", async () => {
    expect(failedDeploy.status).not.toBe(0);
    expect(failedDeploy.output).toContain(SALES_MIGRATION);
    const { rows } = await shadow.query<{ migration_name: string; finished: boolean }>(
      `SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(rows.at(-1)).toEqual({ migration_name: SALES_MIGRATION, finished: false });
    expect(rows.slice(0, -1).every((row) => row.finished)).toBe(true);
  });

  it("after the failure, the S4 schema, movement CHECKs, grants and data are exactly as before", async () => {
    expect(await fingerprint()).toEqual(before);
    expect(await dataHashes()).toEqual(beforeData);
    expect(await columnExists("inventory_movements", "sale_id")).toBe(false);
    expect(await columnExists("journal_entries", "sale_id")).toBe(false);
  });

  it("the real migration then applies: existing rows unchanged with a NULL sale source, sales tables empty", async () => {
    writeMigration(realMigration);
    const resolved = deploy("migrate", "resolve", "--rolled-back", SALES_MIGRATION);
    expect(resolved.status).toBe(0);
    const applied = deploy("migrate", "deploy");
    expect(applied.output).toMatch(/All migrations have been successfully applied/);
    expect(applied.status).toBe(0);

    const after = await dataHashes();
    for (const table of Object.keys(beforeData)) {
      expect({ table, hash: after[table] }).toEqual({ table, hash: beforeData[table] });
    }
    for (const table of SALES_TABLES) expect(after[table]?.startsWith("0:")).toBe(true);
    for (const table of ["inventory_movements", "journal_entries"]) {
      const { rows } = await shadow.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.${table} WHERE sale_id IS NOT NULL`,
      );
      expect({ table, withSale: rows[0]?.n }).toEqual({ table, withSale: 0 });
    }
    const status = deploy("migrate", "status");
    expect(status.output).toMatch(/Database schema is up to date/);
  });
});
