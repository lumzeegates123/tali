import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCorrelationId } from "@tali/application";
import { CHART_TEMPLATE_V1 } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { LEDGER_TEMPLATE_ROWS_SQL } from "../../src/ledger/consistency-query.js";
import { readLedgerConsistency, readLedgerSnapshot, testDatabaseUrls } from "../../src/testing/index.js";
import { inventoryProduct, inventoryTenant } from "../support/inventory.js";
import { asBusinessCreatedBeforeLedger } from "../support/ledger.js";
import { useTenancyHarness } from "../support/tenancy.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

interface ScriptRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the operator script as `db:ledger-consistency` does: no shell, with only the given DATABASE_URL. */
function checkLedgerConsistency(databaseUrl: string | undefined): Promise<ScriptRun> {
  const inherited = { ...process.env };
  delete inherited["DATABASE_URL"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/check-ledger-consistency.mjs"], {
      cwd: packageRoot,
      env: databaseUrl === undefined ? inherited : { ...inherited, DATABASE_URL: databaseUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const lines = (text: string): string[] => text.trim().split(/\r?\n/);

/**
 * ZK. The read-only ledger consistency check (ADR-009 section 29; Plan 005
 * S2): run as the application role, it passes on charts provisioned by the
 * application, reports an active business without a chart (MISSING_CHART)
 * and deliberately broken charts by identifiers and kind only, exits 1, and
 * repairs nothing.
 */
describe("ZK. db:ledger-consistency (operator script)", () => {
  const harness = useTenancyHarness();
  const appUrl = testDatabaseUrls().app;

  async function businesses(count: number): Promise<string[]> {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("ledger-consistency");
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push((await tenancy.create(user, { name: `Shop ${index}` })).result.business.id);
    }
    return ids;
  }

  it("the SQL template rows are exactly the domain's template version 1", () => {
    const expected = CHART_TEMPLATE_V1.accounts.map(
      (account) =>
        `(1, '${account.systemRole}', '${account.code}', '${account.name}', '${account.type}', '${
          ["ASSET", "CONTRA_REVENUE", "EXPENSE"].includes(account.type) ? "DEBIT" : "CREDIT"
        }')`,
    );
    const actual = LEDGER_TEMPLATE_ROWS_SQL.split(/,\r?\n/).map((row) => row.trim());
    expect(actual).toEqual(expected);
  });

  it("passes when every active business has an application-provisioned chart", async () => {
    await businesses(3);
    const clean = await checkLedgerConsistency(appUrl);
    expect(clean).toMatchObject({ code: 0, stderr: "" });
    expect(lines(clean.stdout)).toEqual([
      "Ledger consistency check passed: every active business has a chart matching its template.",
    ]);
  });

  it("fails with MISSING_CHART for an active business without a chart until the operator command provisions it", async () => {
    const [provisioned, missing] = await businesses(2);
    if (provisioned === undefined || missing === undefined) throw new Error("expected two businesses");
    await asBusinessCreatedBeforeLedger(harness.owner, missing);

    const before = await readLedgerSnapshot();
    const failed = await checkLedgerConsistency(appUrl);
    expect(failed.code).toBe(1);
    expect(lines(failed.stderr)).toEqual([
      `INCONSISTENT MISSING_CHART business=${missing}`,
      "Ledger consistency check failed: 1 issue(s). Nothing was changed.",
    ]);
    expect(failed.stdout).toBe("");
    expect(`${failed.stdout}${failed.stderr}`).not.toMatch(/Shop/);
    expect(await readLedgerSnapshot()).toEqual(before);

    await harness.compose().provisionExistingBusinessChart.execute({
      businessId: missing,
      correlationId: parseCorrelationId("zk-rollout"),
    });
    const clean = await checkLedgerConsistency(appUrl);
    expect(clean).toMatchObject({ code: 0, stderr: "" });
  });

  it("does not report a SUSPENDED business without a chart", async () => {
    const [suspended] = await businesses(1);
    if (suspended === undefined) throw new Error("expected one business");
    await asBusinessCreatedBeforeLedger(harness.owner, suspended);
    await harness.owner.query(`UPDATE businesses SET status = 'SUSPENDED' WHERE id = $1`, [suspended]);

    const run = await checkLedgerConsistency(appUrl);
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(await readLedgerConsistency()).toEqual([]);
  });

  it("reports deliberately broken charts by identifiers and kind only, exits 1, and changes nothing", async () => {
    const [incomplete, renamed, versioned] = await businesses(3);
    if (incomplete === undefined || renamed === undefined || versioned === undefined) {
      throw new Error("expected three businesses");
    }
    await harness.owner.query(`DELETE FROM ledger_accounts WHERE business_id = $1 AND system_role = 'INVENTORY'`, [
      incomplete,
    ]);
    const renamedAccount = await harness.owner.query<{ id: string }>(
      `UPDATE ledger_accounts SET name = 'Till float' WHERE business_id = $1 AND system_role = 'CASH_ON_HAND'
       RETURNING id::text`,
      [renamed],
    );
    const versionedAccount = await harness.owner.query<{ id: string }>(
      `UPDATE ledger_accounts SET template_version = 2 WHERE business_id = $1 AND system_role = 'TAX_PAYABLE'
       RETURNING id::text`,
      [versioned],
    );
    const renamedId = renamedAccount.rows[0]?.id;
    const versionedId = versionedAccount.rows[0]?.id;

    const before = await readLedgerSnapshot();
    const broken = await checkLedgerConsistency(appUrl);
    expect(broken.code).toBe(1);
    const expectedIssues = [
      { line: `INCONSISTENT CHART_INCOMPLETE business=${incomplete}`, business: incomplete },
      { line: `INCONSISTENT TEMPLATE_MISMATCH business=${renamed} account=${renamedId}`, business: renamed },
      { line: `INCONSISTENT MIXED_TEMPLATE_VERSIONS business=${versioned}`, business: versioned },
      {
        line: `INCONSISTENT UNKNOWN_TEMPLATE_VERSION business=${versioned} account=${versionedId}`,
        business: versioned,
      },
    ]
      .sort((x, y) => (x.business < y.business ? -1 : x.business > y.business ? 1 : 0))
      .map((issue) => issue.line);
    expect(lines(broken.stderr)).toEqual([
      ...expectedIssues,
      "Ledger consistency check failed: 4 issue(s). Nothing was changed.",
    ]);
    expect(broken.stdout).toBe("");
    expect(`${broken.stdout}${broken.stderr}`).not.toMatch(/Till float|Cash on hand|Inventory|Tax payable|code=/);
    expect(await readLedgerSnapshot()).toEqual(before);

    expect((await readLedgerConsistency()).map((issue) => issue.kind).sort()).toEqual(
      ["CHART_INCOMPLETE", "MIXED_TEMPLATE_VERSIONS", "TEMPLATE_MISMATCH", "UNKNOWN_TEMPLATE_VERSION"].sort(),
    );
  });

  it("reports an account with no system role", async () => {
    const [businessId] = await businesses(1);
    const { rows } = await harness.owner.query<{ id: string }>(
      `INSERT INTO ledger_accounts (business_id, id, code, name, type, normal_balance, system_role, template_version,
         status, created_at)
       VALUES ($1, $2, '9000', 'Petty cash', 'ASSET', 'DEBIT', NULL, 1, 'ACTIVE', now()) RETURNING id::text`,
      [businessId, harness.world().ids.newId("LedgerAccount")],
    );
    const broken = await checkLedgerConsistency(appUrl);
    expect(broken.code).toBe(1);
    expect(lines(broken.stderr)[0]).toBe(
      `INCONSISTENT ACCOUNT_WITHOUT_SYSTEM_ROLE business=${businessId} account=${rows[0]?.id}`,
    );
  });

  it("reports an unbalanced journal entry by identifiers and kind only", async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "ledger-unbalanced");
    const soap = await inventoryProduct(harness, t, { name: "Soap" });
    const opening = await tenancy.recordOpeningStock.execute(t.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" }],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    const inventory = await harness.owner.query<{ id: string }>(
      `SELECT id::text FROM ledger_accounts WHERE business_id = $1 AND system_role = 'INVENTORY'`,
      [t.businessId],
    );
    const entryId = harness.world().ids.newId("JournalEntry");
    const at = "2026-10-18T08:00:00.000Z";
    await harness.owner.query(
      `INSERT INTO journal_entries (
         business_id, id, currency, occurred_at, business_date, recorded_at, entry_kind,
         opening_batch_id, posting_rule, posting_rule_version, description,
         actor_membership_id, location_id, source_channel, correlation_id
       ) VALUES ($1, $2, 'NGN', $3, '2026-10-18', $3, 'ORIGINAL',
         $4, 'OPENING_STOCK_VALUED', 1, 'unbalanced probe', $5, $6, 'web', 'zk-unbalanced')`,
      [t.businessId, entryId, at, opening.document.id, t.membershipId, t.locationId],
    );
    await harness.owner.query(
      `INSERT INTO journal_lines (
         business_id, entry_id, line_number, account_id, direction, amount_minor, currency
       ) VALUES ($1, $2, 1, $3, 'DEBIT', 100, 'NGN')`,
      [t.businessId, entryId, inventory.rows[0]?.id],
    );
    const before = await readLedgerSnapshot();
    const broken = await checkLedgerConsistency(appUrl);
    expect(broken.code).toBe(1);
    expect(lines(broken.stderr)[0]).toBe(`INCONSISTENT UNBALANCED_ENTRY business=${t.businessId} account=${entryId}`);
    expect(broken.stdout).toBe("");
    expect(await readLedgerSnapshot()).toEqual(before);
  });

  it("reports a reversal that does not mirror original line directions", async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "ledger-reversal-mirror");
    const soap = await inventoryProduct(harness, t, { name: "Soap" });
    await tenancy.recordOpeningStock.execute(t.context, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "2",
          unit: "PIECE",
          totalCost: { amountMinor: "200", currency: "NGN" },
        },
      ],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    const original = await harness.owner.query<{ id: string; opening_batch_id: string }>(
      `SELECT id::text, opening_batch_id::text FROM journal_entries WHERE business_id = $1 AND entry_kind = 'ORIGINAL'`,
      [t.businessId],
    );
    const originalId = original.rows[0]?.id;
    const openingBatchId = original.rows[0]?.opening_batch_id;
    const originalLines = await harness.owner.query<{
      line_number: number;
      account_id: string;
      direction: string;
      amount_minor: string;
      memo_kind: string | null;
    }>(
      `SELECT line_number, account_id::text, direction, amount_minor::text, memo_kind
       FROM journal_lines WHERE business_id = $1 AND entry_id = $2 ORDER BY line_number`,
      [t.businessId, originalId],
    );
    const reversalId = harness.world().ids.newId("JournalEntry");
    const at = "2026-10-18T09:00:00.000Z";
    await harness.owner.query(
      `INSERT INTO journal_entries (
         business_id, id, currency, occurred_at, business_date, recorded_at, entry_kind,
         opening_batch_id, reverses_entry_id, posting_rule, posting_rule_version, description,
         actor_membership_id, location_id, source_channel, correlation_id
       ) VALUES ($1, $2, 'NGN', $3, '2026-10-18', $3, 'REVERSAL',
         $4, $5, 'OPENING_STOCK_REVERSED', 1, 'mirror probe', $6, $7, 'web', 'zk-mirror')`,
      [t.businessId, reversalId, at, openingBatchId, originalId, t.membershipId, t.locationId],
    );
    for (const line of originalLines.rows) {
      await harness.owner.query(
        `INSERT INTO journal_lines (
           business_id, entry_id, line_number, account_id, direction, amount_minor, currency, memo_kind
         ) VALUES ($1, $2, $3, $4, $5, $6, 'NGN', $7)`,
        [
          t.businessId,
          reversalId,
          line.line_number,
          line.account_id,
          line.direction,
          line.amount_minor,
          line.memo_kind,
        ],
      );
    }
    const broken = await checkLedgerConsistency(appUrl);
    expect(broken.code).toBe(1);
    expect(lines(broken.stderr)[0]).toBe(
      `INCONSISTENT REVERSAL_DIRECTION_MISMATCH business=${t.businessId} account=${reversalId}`,
    );
    await harness.owner.query(`DELETE FROM journal_lines WHERE business_id = $1 AND entry_id = $2`, [
      t.businessId,
      reversalId,
    ]);
    await harness.owner.query(`DELETE FROM journal_entries WHERE business_id = $1 AND id = $2`, [
      t.businessId,
      reversalId,
    ]);
  });

  it("exits 1 without DATABASE_URL, and on a connection failure prints no credentials", async () => {
    const missing = await checkLedgerConsistency(undefined);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("DATABASE_URL (the application role) is required");

    const unreachable = new URL(appUrl);
    unreachable.port = "1";
    const failed = await checkLedgerConsistency(unreachable.toString());
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Ledger consistency check could not run");
    expect(failed.stderr).not.toContain(unreachable.toString());
    if (unreachable.password !== "") expect(failed.stderr).not.toContain(unreachable.password);
  });
});
