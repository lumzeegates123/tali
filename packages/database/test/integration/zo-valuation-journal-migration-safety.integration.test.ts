import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { fixtureTargetUrl } from "../support/fixtures.js";
import { prisma, type CliResult } from "../support/prisma-cli.js";

const VALUATION_MIGRATION = "20261018120000_build3_valuation_journal";
const migrationsDir = fileURLToPath(new URL("../../prisma/migrations", import.meta.url));
const schemaDir = fileURLToPath(new URL("../../prisma/schema", import.meta.url));
const realMigration = readFileSync(join(migrationsDir, VALUATION_MIGRATION, "migration.sql"), "utf8");
const migrationCode = realMigration
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const INJECTION_POINT = `GRANT UPDATE ("status", "value_minor", "first_valued_at", "version", "updated_at") ON "inventory_valuations" TO tali_app;\n`;

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

describe("ZO. valuation journal migration safety (shadow database, S2 data present)", () => {
  let shadowUrl: string;
  let workDir: string;
  let configPath: string;
  let shadow: pg.Client;
  let s2: Fingerprint;
  let s2Data: Record<string, string>;
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
        `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash, count(*)::int AS n
         FROM public.${quoted} t`,
      );
      hashes[name] = `${rows[0]?.n}:${rows[0]?.hash}`;
    }
    return hashes;
  };
  const writeMigration = (sql: string): void => {
    writeFileSync(join(workDir, "migrations", VALUATION_MIGRATION, "migration.sql"), sql, "utf8");
  };
  const resetShadow = async (): Promise<void> => {
    await shadow.query(`SET client_min_messages = warning`);
    await shadow.query(`DROP SCHEMA public CASCADE`);
    await shadow.query(`CREATE SCHEMA public`);
    await shadow.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await shadow.query(`GRANT USAGE ON SCHEMA public TO tali_app`);
  };

  const seedS2Data = async (): Promise<void> => {
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
      const receipt = `00000000-0000-7000-8000-00000000f90${n}`;
      const receiptMovement = `00000000-0000-7000-8000-00000000fa0${n}`;
      const adjustment = `00000000-0000-7000-8000-00000000fb0${n}`;
      const adjustmentMovement = `00000000-0000-7000-8000-00000000fc0${n}`;
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
      for (const [roleIndex, row] of CHART.entries()) {
        const [systemRole, code, name, type, normal] = row;
        await shadow.query(
          `INSERT INTO ledger_accounts (business_id, id, code, name, type, normal_balance, system_role, template_version,
             status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'ACTIVE', $8)`,
          [
            businessId,
            `00000000-0000-7000-8000-${n}${String(roleIndex).padStart(11, "0")}`,
            code,
            name,
            type,
            normal,
            systemRole,
            at,
          ],
        );
      }
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
        `INSERT INTO goods_receipts (business_id, id, location_id, status, actor_membership_id, source_channel,
           correlation_id, occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, 'POSTED', $4, 'api', 'seed-receipt', $5, '2026-10-10', $5)`,
        [businessId, receipt, location, membership, at],
      );
      await shadow.query(
        `INSERT INTO inventory_movements (business_id, id, location_id, variant_id, type, quantity_delta_minor,
           balance_after_minor, balance_version, goods_receipt_id, actor_membership_id, source_channel, correlation_id,
           occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, $4, 'PURCHASE_RECEIPT', 6, 30, 2, $5, $6, 'api', 'seed-receipt', $7, '2026-10-10', $7)`,
        [businessId, receiptMovement, location, variant, receipt, membership, at],
      );
      await shadow.query(
        `INSERT INTO inventory_adjustments (business_id, id, location_id, kind, reason_code, status, actor_membership_id,
           source_channel, correlation_id, occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, 'ADJUSTMENT', 'FOUND_STOCK', 'POSTED', $4, 'api', 'seed-adj', $5, '2026-10-10', $5)`,
        [businessId, adjustment, location, membership, at],
      );
      await shadow.query(
        `INSERT INTO inventory_movements (business_id, id, location_id, variant_id, type, quantity_delta_minor,
           balance_after_minor, balance_version, adjustment_id, reason_code, actor_membership_id, source_channel,
           correlation_id, occurred_at, business_date, recorded_at)
         VALUES ($1, $2, $3, $4, 'ADJUSTMENT', 1, 31, 3, $5, 'FOUND_STOCK', $6, 'api', 'seed-adj', $7, '2026-10-10', $7)`,
        [businessId, adjustmentMovement, location, variant, adjustment, membership, at],
      );
      await shadow.query(
        `INSERT INTO inventory_balances (business_id, location_id, variant_id, quantity_minor, version, last_movement_id,
           updated_at)
         VALUES ($1, $2, $3, 31, 3, $4, $5)`,
        [businessId, location, variant, adjustmentMovement, at],
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
         VALUES ($1, $2, $3, 'COUNTED', 30, 'PIECE', 31, 3, 1, $4, $5)`,
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

  const SEEDED_TABLES = [
    "users",
    "businesses",
    "business_locations",
    "business_memberships",
    "ledger_accounts",
    "product_categories",
    "products",
    "product_variants",
    "product_variant_prices",
    "inventory_opening_batches",
    "goods_receipts",
    "inventory_adjustments",
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

    workDir = mkdtempSync(join(tmpdir(), "tali-valuation-migration-"));
    mkdirSync(join(workDir, "migrations"));
    cpSync(join(migrationsDir, "migration_lock.toml"), join(workDir, "migrations", "migration_lock.toml"));
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name < VALUATION_MIGRATION) {
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

    const s2Deploy = deploy("migrate", "deploy");
    expect(s2Deploy.output).toMatch(/All migrations have been successfully applied/);
    expect(s2Deploy.status).toBe(0);
    await seedS2Data();
    s2 = await fingerprint();
    s2Data = await dataHashes();

    expect(realMigration.split(INJECTION_POINT)).toHaveLength(2);
    cpSync(join(migrationsDir, VALUATION_MIGRATION), join(workDir, "migrations", VALUATION_MIGRATION), {
      recursive: true,
    });
    writeMigration(realMigration.replace(INJECTION_POINT, `SELECT 1 / 0;\n${INJECTION_POINT}`));
    failedDeploy = deploy("migrate", "deploy");
  }, 180_000);

  afterAll(async () => {
    await resetShadow();
    await shadow.end();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("representative S2 data exists before the S3 migration", () => {
    for (const table of SEEDED_TABLES) {
      const count = Number(s2Data[table]?.split(":")[0]);
      expect({ table, populated: count > 0 }).toEqual({ table, populated: true });
    }
    expect(s2Data["journal_entries"]).toBeUndefined();
    expect(s2Data["inventory_valuations"]).toBeUndefined();
  });

  it("the real migration is one explicit transaction and additive only", () => {
    const statements = realMigration
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
    expect(statements[0]).toBe("BEGIN;");
    expect(statements.at(-1)).toBe("COMMIT;");
    expect(migrationCode).not.toMatch(/\b(TRUNCATE|DROP|RENAME|COPY)\b/i);
    expect(migrationCode).not.toMatch(/\bINSERT INTO\b/i);
  });

  it("the failure-injected migration fails the deploy and is not recorded as applied", async () => {
    expect(failedDeploy.status).not.toBe(0);
    expect(failedDeploy.output).toContain(VALUATION_MIGRATION);
    const { rows } = await shadow.query<{ migration_name: string; finished: boolean }>(
      `SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name`,
    );
    expect(rows.at(-1)).toEqual({ migration_name: VALUATION_MIGRATION, finished: false });
    expect(rows.slice(0, -1).every((row) => row.finished)).toBe(true);
  });

  it("after the failure, the schema, grants and S2 data are exactly as before", async () => {
    expect(await fingerprint()).toEqual(s2);
    expect(await dataHashes()).toEqual(s2Data);
    const { rows } = await shadow.query(
      `SELECT to_regclass('public.journal_entries')::text AS journals,
              to_regclass('public.inventory_valuations')::text AS valuations`,
    );
    expect(rows[0]).toEqual({ journals: null, valuations: null });
  });

  it("the real migration then applies: S2 data unchanged, valuation and journal tables empty, no backfill", async () => {
    writeMigration(realMigration);
    const resolved = deploy("migrate", "resolve", "--rolled-back", VALUATION_MIGRATION);
    expect(resolved.status).toBe(0);
    const applied = deploy("migrate", "deploy");
    expect(applied.output).toMatch(/All migrations have been successfully applied/);
    expect(applied.status).toBe(0);

    const after = await dataHashes();
    for (const table of Object.keys(s2Data)) {
      expect({ table, hash: after[table] }).toEqual({ table, hash: s2Data[table] });
    }
    expect(after["journal_entries"]?.startsWith("0:")).toBe(true);
    expect(after["journal_lines"]?.startsWith("0:")).toBe(true);
    expect(after["inventory_valuations"]?.startsWith("0:")).toBe(true);
    expect(after["inventory_movement_valuations"]?.startsWith("0:")).toBe(true);
    expect(after["stock_valuations"]?.startsWith("0:")).toBe(true);
    expect(after["ledger_accounts"]).toEqual(s2Data["ledger_accounts"]);
    expect(after["inventory_movements"]).toEqual(s2Data["inventory_movements"]);
  });
});
