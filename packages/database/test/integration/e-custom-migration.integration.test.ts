import { describe, expect, it } from "vitest";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { insertConstraintProbe } from "../support/fixture-repositories.js";
import { TEST_CURRENCIES } from "../support/fixtures.js";
import { useFixtureHarness, uuid } from "../support/harness.js";
import { sqlState } from "../support/pg.js";
import { prisma } from "../support/prisma-cli.js";

const COMMITTED_MIGRATIONS = [
  "20260927231057_foundation_spike",
  "20260928025500_remove_foundation_spike",
  "20260929212026_build1_identity_tenancy",
  "20260929213019_build1_timestamp_consistency",
  "20260930165547_build1_invitations_devices",
  "20261005120000_build2_catalog",
  "20261006120000_build2_inventory_core",
];

const BUILD_1_TABLES = [
  "public.business_audit_records",
  "public.business_idempotency_records",
  "public.business_invitations",
  "public.business_locations",
  "public.business_memberships",
  "public.businesses",
  "public.currencies",
  "public.devices",
  "public.external_identities",
  "public.platform_audit_records",
  "public.user_idempotency_records",
  "public.users",
];

/** Build 2 Slice 2 adds the catalog. */
const BUILD_2_CATALOG_TABLES = [
  "public.product_categories",
  "public.product_packs",
  "public.product_variant_prices",
  "public.product_variants",
  "public.products",
  "public.units_of_measure",
];

/** Build 2 Slice 5 adds the inventory core: three document headers, movements, balances and thresholds; no stocktakes. */
const BUILD_2_INVENTORY_TABLES = [
  "public.goods_receipts",
  "public.inventory_adjustments",
  "public.inventory_balances",
  "public.inventory_movements",
  "public.inventory_opening_batches",
  "public.inventory_stock_thresholds",
];

/**
 * Criterion E and the migration chain. The global setup has already run
 * `migrate deploy` against this database from empty: the spike migration, the
 * approved cleanup migration that removes the temporary foundation_spike
 * schema, the two Build 1 identity and tenancy migrations, the Slice 5
 * invitations and devices migration, the Build 2 catalog migration and the
 * Build 2 inventory core migration.
 */
describe("E. migration chain", () => {
  const { owner } = useFixtureHarness();

  it("migrate deploy recorded every committed migration, in order, as fully applied", async () => {
    const { rows } = await owner.query<{ migration_name: string; finished: boolean; rolled_back: boolean }>(
      `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM public._prisma_migrations ORDER BY migration_name`,
    );
    expect(rows.map((row) => row.migration_name)).toEqual(COMMITTED_MIGRATIONS);
    expect(rows.every((row) => row.finished && !row.rolled_back)).toBe(true);
  });

  it("re-running migrate deploy is a no-op", () => {
    const result = prisma(["migrate", "deploy"], testDatabaseUrls().owner);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/No pending migrations to apply/);
  });

  it("migrate status reports the database schema is up to date", () => {
    const result = prisma(["migrate", "status"], testDatabaseUrls().owner);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/Database schema is up to date/);
  });

  // --from-migrations replays the whole chain from zero in the shadow database.
  it.each([
    ["the Prisma schema", ["--to-schema", "prisma/schema"]],
    ["the migrated database", ["--to-config-datasource"]],
  ])("the chain replayed from zero has no drift against %s", (_label, target) => {
    const shadow = new URL(testDatabaseUrls().owner);
    shadow.pathname = `${shadow.pathname}_shadow`;
    const result = prisma(
      ["migrate", "diff", "--from-migrations", "prisma/migrations", ...target, "--exit-code"],
      testDatabaseUrls().owner,
      shadow.toString(),
    );
    expect(result.output).toMatch(/No difference detected/);
    expect(result.status).toBe(0);
  });

  it("the cleanup migration left no foundation_spike schema or objects", async () => {
    const schemas = await owner.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'foundation_spike'`);
    expect(schemas.rows).toEqual([]);
    const objects = await owner.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'foundation_spike'`,
    );
    expect(objects.rows).toEqual([]);
  });

  it("the migration chain creates exactly the Build 1, catalog and inventory tables (and Prisma's migration table)", async () => {
    const { rows } = await owner.query<{ name: string }>(
      `SELECT schemaname || '.' || tablename AS name FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'test_fixtures') ORDER BY (schemaname || '.' || tablename) COLLATE "C"`,
    );
    expect(rows.map((row) => row.name)).toEqual(
      ["public._prisma_migrations", ...BUILD_1_TABLES, ...BUILD_2_CATALOG_TABLES, ...BUILD_2_INVENTORY_TABLES].sort(),
    );
  });

  it("the inventory migration adds no trigger, function, RLS policy or CASCADE", async () => {
    const triggers = await owner.query(
      `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = 'public'`,
    );
    expect(triggers.rows).toEqual([]);
    const functions = await owner.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
    );
    expect(functions.rows).toEqual([]);
    const cascades = await owner.query(
      `SELECT conname FROM pg_constraint WHERE contype = 'f' AND (confdeltype IN ('c', 'n', 'd') OR confupdtype IN ('c', 'n', 'd'))
       AND connamespace = 'public'::regnamespace`,
    );
    expect(cascades.rows).toEqual([]);
  });

  it("the migrations seed NGN as the only reference currency (test currencies are fixtures)", async () => {
    const { rows } = await owner.query<{ code: string; minor_unit_digits: number }>(
      `SELECT code, minor_unit_digits FROM currencies WHERE code <> ALL($1::text[]) ORDER BY code`,
      [TEST_CURRENCIES.map((currency) => currency.code)],
    );
    expect(rows).toEqual([{ code: "NGN", minor_unit_digits: 2 }]);
  });
});

/**
 * Custom constraints (CHECK, partial unique index) on the test-only fixture
 * table, exercised as the application role through the Prisma unit of work.
 */
describe("E. custom constraints", () => {
  const { unitOfWork, owner } = useFixtureHarness();
  const insert = (id: number, scopeKey: string, isDefault: boolean, amountMinor: bigint) =>
    unitOfWork.run((scope) => insertConstraintProbe(scope, { id: uuid(id), scopeKey, isDefault, amountMinor }));

  it("CHECK constraint rejects a negative amount (through Prisma, as the app role)", async () => {
    await expect(insert(1, "scope-a", false, -1n)).rejects.toThrow(
      /constraint_probe_amount_minor_non_negative|check constraint|23514/i,
    );
    await expect(insert(2, "scope-a", false, 0n)).resolves.toBeUndefined();
  });

  it("CHECK constraint is enforced at SQL level (SQLSTATE 23514)", async () => {
    const state = await sqlState(
      owner.query(
        `INSERT INTO test_fixtures.constraint_probe (id, scope_key, is_default, amount_minor) VALUES ($1, 's', false, -5)`,
        [uuid(9)],
      ),
    );
    expect(state).toBe("23514");
  });

  it("partial unique index allows one default per scope, any number of non-defaults", async () => {
    await insert(1, "scope-a", true, 1n);
    await insert(2, "scope-a", false, 1n);
    await insert(3, "scope-a", false, 1n);
    await insert(4, "scope-b", true, 1n);
    await expect(insert(5, "scope-a", true, 1n)).rejects.toThrow();
    const state = await sqlState(
      owner.query(
        `INSERT INTO test_fixtures.constraint_probe (id, scope_key, is_default, amount_minor) VALUES ($1, 'scope-b', true, 1)`,
        [uuid(6)],
      ),
    );
    expect(state).toBe("23505");
  });

  it("a violation inside a unit of work rolls the whole transaction back", async () => {
    await expect(
      unitOfWork.run(async (scope) => {
        await insertConstraintProbe(scope, { id: uuid(1), scopeKey: "scope-a", isDefault: true, amountMinor: 1n });
        await insertConstraintProbe(scope, { id: uuid(2), scopeKey: "scope-a", isDefault: true, amountMinor: 1n });
      }),
    ).rejects.toThrow();
    const { rows } = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM test_fixtures.constraint_probe`);
    expect(rows[0]?.n).toBe("0");
  });
});
