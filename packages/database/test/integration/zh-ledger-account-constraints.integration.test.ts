import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { accountRow, insertAccount } from "../support/ledger.js";
import { appPool, sqlState } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const CHECK = "23514";
const FOREIGN_KEY = "23503";
const UNIQUE = "23505";
const NOT_NULL = "23502";
const INSUFFICIENT_PRIVILEGE = "42501";

/** The constraint named by a rejected query's PostgreSQL error. */
async function violatedConstraint(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { constraint?: string }).constraint;
  }
  throw new Error("expected the query to fail");
}

/**
 * ZH. The Build 3 S2 ledger_accounts schema (ADR-009 sections 4 to 6 and 11)
 * against the migrated test database: every CHECK, the unique keys, the tenant
 * foreign key, and the application role's privileges (SELECT and INSERT only;
 * no UPDATE, DELETE or TRUNCATE, so an account is never changed in place).
 * Rows are written as the owner so the constraints, not the adapter, are
 * under test; privileges are probed as the application role.
 */
describe("ZH. ledger account constraints and privileges (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const app = appPool();
  afterAll(() => app.end());

  let businessId: string;
  let otherBusinessId: string;
  const newId = () => harness.world().ids.newId("Row");

  beforeEach(async () => {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("ledger-constraints");
    businessId = (await tenancy.create(user, { name: "Constraint Shop" })).result.business.id;
    otherBusinessId = (await tenancy.create(user, { name: "Other Shop" })).result.business.id;
    // Business creation provisions a chart; the probes below need an empty one.
    await harness.owner.query(`DELETE FROM ledger_accounts WHERE business_id = $1`, [businessId]);
  });

  const ownerInsert = (overrides: Record<string, unknown>) =>
    insertAccount(harness.owner, accountRow(businessId, newId(), overrides));

  it("accepts a valid template v1 account", async () => {
    await expect(ownerInsert({})).resolves.toMatchObject({ rowCount: 1 });
  });

  it.each([
    ["an unknown account type", { type: "INCOME" }],
    ["an unknown normal balance", { normal_balance: "BOTH" }],
    ["a normal balance that does not follow the type", { normal_balance: "CREDIT" }],
    ["an unknown system role", { system_role: "PETTY_CASH" }],
    ["a system role with the wrong type", { type: "LIABILITY", normal_balance: "CREDIT" }],
    ["template version 0", { template_version: 0 }],
    ["a negative template version", { template_version: -1 }],
    ["an ARCHIVED status (no account management in Build 3)", { status: "ARCHIVED" }],
    ["an empty code", { code: "" }],
    ["a padded code", { code: " 1000" }],
    ["a code over 20 characters", { code: "1".repeat(21) }],
    ["an empty name", { name: "" }],
    ["a padded name", { name: "Cash on hand " }],
    ["a name over 120 characters", { name: "x".repeat(121) }],
  ])("rejects %s with a CHECK violation", async (_label, overrides) => {
    expect(await sqlState(ownerInsert(overrides))).toBe(CHECK);
  });

  it.each([
    ["CONTRA_REVENUE", "DEBIT", "SALES_DISCOUNTS"],
    ["EXPENSE", "DEBIT", "COST_OF_GOODS_SOLD"],
    ["LIABILITY", "CREDIT", "TAX_PAYABLE"],
    ["EQUITY", "CREDIT", "OPENING_BALANCE_EQUITY"],
    ["REVENUE", "CREDIT", "INVENTORY_GAIN"],
  ])("accepts type %s with normal balance %s for role %s", async (type, normalBalance, role) => {
    await expect(ownerInsert({ type, normal_balance: normalBalance, system_role: role })).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("allows a NULL system role at the schema level (reserved for later user accounts)", async () => {
    await expect(ownerInsert({ system_role: null })).resolves.toMatchObject({ rowCount: 1 });
  });

  it.each(["business_id", "id", "code", "name", "type", "normal_balance", "template_version", "status", "created_at"])(
    "requires %s",
    async (column) => {
      expect(await sqlState(ownerInsert({ [column]: null }))).toBe(NOT_NULL);
    },
  );

  it("one account per system role per business; the same role in another business is independent", async () => {
    await ownerInsert({});
    expect(await sqlState(ownerInsert({ code: "1001" }))).toBe(UNIQUE);
    // otherBusinessId already has its own CASH_ON_HAND from business creation.
    const { rows } = await harness.owner.query(
      `SELECT count(*)::int AS n FROM ledger_accounts WHERE business_id = $1 AND system_role = 'CASH_ON_HAND'`,
      [otherBusinessId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("one account per code per business", async () => {
    await ownerInsert({});
    expect(await sqlState(ownerInsert({ system_role: "INVENTORY", name: "Inventory" }))).toBe(UNIQUE);
  });

  it("the primary key rejects a reused account id, even in another business", async () => {
    const id = newId();
    await insertAccount(harness.owner, accountRow(businessId, id));
    const reused = insertAccount(harness.owner, accountRow(otherBusinessId, id, { code: "9000", system_role: null }));
    expect(await violatedConstraint(reused)).toBe("ledger_accounts_pkey");
  });

  it("rejects an account for a business that does not exist", async () => {
    expect(await sqlState(insertAccount(harness.owner, accountRow(newId(), newId())))).toBe(FOREIGN_KEY);
  });

  it("a business with ledger accounts cannot be deleted (RESTRICT, no cascade)", async () => {
    const client = await harness.owner.connect();
    try {
      await client.query("BEGIN");
      // Remove every other reference first, so only the ledger foreign key can block the delete.
      for (const table of [
        "business_audit_records",
        "user_idempotency_records",
        "business_memberships",
        "business_locations",
      ]) {
        const column = table === "user_idempotency_records" ? "resource_id" : "business_id";
        await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [otherBusinessId]);
      }
      const blocked = client.query(`DELETE FROM businesses WHERE id = $1`, [otherBusinessId]);
      expect(await violatedConstraint(blocked)).toBe("ledger_accounts_business_id_fkey");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  describe("application role privileges", () => {
    it("reads and inserts ledger accounts", async () => {
      await expect(insertAccount(app, accountRow(businessId, newId()))).resolves.toMatchObject({ rowCount: 1 });
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ledger_accounts WHERE business_id = $1`, [
        businessId,
      ]);
      expect(rows[0]).toEqual({ n: 1 });
    });

    it.each([
      ["UPDATE a name", `UPDATE ledger_accounts SET name = 'Renamed' WHERE business_id = $1`],
      ["UPDATE a type", `UPDATE ledger_accounts SET type = 'EXPENSE', normal_balance = 'DEBIT' WHERE business_id = $1`],
      ["UPDATE a status", `UPDATE ledger_accounts SET status = 'ACTIVE' WHERE business_id = $1`],
      ["DELETE", `DELETE FROM ledger_accounts WHERE business_id = $1`],
    ])("cannot %s", async (_label, sql) => {
      expect(await sqlState(app.query(sql, [otherBusinessId]))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("cannot TRUNCATE ledger accounts", async () => {
      expect(await sqlState(app.query(`TRUNCATE ledger_accounts`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("holds exactly SELECT and INSERT on ledger_accounts, with no column grants", async () => {
      const table = await harness.owner.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'ledger_accounts' AND grantee = 'tali_app'
         ORDER BY privilege_type`,
      );
      expect(table.rows.map((row) => row.privilege_type)).toEqual(["INSERT", "SELECT"]);
      const columns = await harness.owner.query(
        `SELECT column_name, privilege_type FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = 'ledger_accounts' AND grantee = 'tali_app'
           AND privilege_type NOT IN ('INSERT', 'SELECT')`,
      );
      expect(columns.rows).toEqual([]);
      const publicGrants = await harness.owner.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'ledger_accounts' AND grantee = 'PUBLIC'`,
      );
      expect(publicGrants.rows).toEqual([]);
    });

    it("no journal entry or journal line table exists yet (they arrive with typed sources in S3)", async () => {
      const { rows } = await harness.owner.query(
        `SELECT to_regclass('public.journal_entries')::text AS entries, to_regclass('public.journal_lines')::text AS lines`,
      );
      expect(rows[0]).toEqual({ entries: null, lines: null });
    });
  });
});
