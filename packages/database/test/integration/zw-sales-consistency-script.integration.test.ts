import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { findInventoryInconsistencies } from "../../src/inventory/consistency-query.js";
import { findLedgerInconsistencies } from "../../src/ledger/consistency-query.js";
import { findSalesInconsistencies } from "../../src/sales/consistency-query.js";
import {
  readInventoryConsistency,
  readLedgerConsistency,
  readSalesConsistency,
  testDatabaseUrls,
} from "../../src/testing/index.js";
import { type InventoryTenant, inventoryTenant } from "../support/inventory.js";
import { pricedProduct, reversalInput, type SaleProduct, saleInput, saleLine } from "../support/sales.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

interface ScriptRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the operator script as `db:sales-consistency` does: no shell, with only the given DATABASE_URL. */
function checkSalesConsistency(databaseUrl: string | undefined): Promise<ScriptRun> {
  const inherited = { ...process.env };
  delete inherited["DATABASE_URL"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/check-sales-consistency.mjs"], {
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
 * ZW. The read-only sales consistency check (ADR-011; Plan 005 S5), the
 * ledger check's sale-source rules, and the inventory check over SALE
 * movements. Fixtures a constraint would reject are injected inside an owner
 * transaction (with that constraint dropped or deferred there), checked, and
 * rolled back; the others are committed and seen by the operator script,
 * which reports identifiers and kinds only, exits 1, and changes nothing.
 */
describe("ZW. db:sales-consistency and the sale rules of the other checks", () => {
  const harness = useTenancyHarness();
  const appUrl = testDatabaseUrls().app;
  let tenancy: Tenancy;
  let a: InventoryTenant;
  let soap: SaleProduct;

  const sell = async (quantity = "2") =>
    (
      await tenancy.recordSale.execute(
        a.context,
        saleInput(harness, [saleLine(soap, quantity)], (50_000n * BigInt(quantity)).toString()),
      )
    ).sale;
  const sellAndReverse = async () => {
    const sale = await sell();
    return (await tenancy.reverseSale.execute(a.context, reversalInput(harness, sale.saleId))).sale;
  };

  async function one(sql: string, values: unknown[]): Promise<string> {
    const { rows } = await harness.owner.query<{ id: string }>(sql, values);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no row for ${sql}`);
    return id;
  }
  const openingMovement = () =>
    one(`SELECT id::text FROM inventory_movements WHERE business_id = $1 AND variant_id = $2 AND type = 'OPENING'`, [
      a.businessId,
      soap.variantId,
    ]);
  const openingJournal = () =>
    one(`SELECT id::text FROM journal_entries WHERE business_id = $1 AND opening_batch_id IS NOT NULL`, [a.businessId]);
  const reversalMovement = (saleId: string) =>
    one(`SELECT id::text FROM inventory_movements WHERE sale_id = $1 AND reverses_movement_id IS NOT NULL`, [saleId]);

  /** Runs `statements` as the owner in one transaction, reads all three checks inside it, and rolls back. */
  async function brokenWithin(statements: readonly string[]) {
    const client = await harness.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      for (const statement of statements) await client.query(statement);
      return {
        sales: await findSalesInconsistencies(client),
        ledger: await findLedgerInconsistencies(client),
        inventory: await findInventoryInconsistencies(client),
      };
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  const kindsFor = (issues: readonly { readonly kind: string }[]) => [...new Set(issues.map((i) => i.kind))].sort();

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "sales-consistency");
    soap = await pricedProduct(harness, a, { name: "Soap", quantity: "20", totalCost: "700000" });
  });

  describe("the operator script", () => {
    it("passes after valued, unvalued and untracked sales and a reversal", async () => {
      const salt = await pricedProduct(harness, a, { name: "Salt", quantity: "5" });
      const bag = await pricedProduct(harness, a, { name: "Bag", tracked: false, price: "2000" });
      await tenancy.recordSale.execute(
        a.context,
        saleInput(harness, [saleLine(soap, "1"), saleLine(salt, "1"), saleLine(bag, "1")], "102000"),
      );
      await sellAndReverse();
      const clean = await checkSalesConsistency(appUrl);
      expect(clean).toMatchObject({ code: 0, stderr: "" });
      expect(lines(clean.stdout)).toEqual([
        "Sales consistency check passed: every sale matches its snapshots, journals and stock effects.",
      ]);
      expect(await readLedgerConsistency()).toEqual([]);
      expect(await readInventoryConsistency()).toEqual([]);
    });

    it("reports committed broken sales by identifiers and kind only, exits 1, and changes nothing", async () => {
      const totalBroken = await sell();
      const costBroken = await sell();
      await harness.owner.query(`UPDATE sales SET total_minor = total_minor + 1 WHERE id = $1`, [totalBroken.saleId]);
      await harness.owner.query(`UPDATE sale_lines SET cost_minor = cost_minor + 1 WHERE sale_id = $1`, [
        costBroken.saleId,
      ]);
      const issues = await readSalesConsistency();
      const before = await harness.owner.query(`SELECT * FROM sales ORDER BY id`);

      const broken = await checkSalesConsistency(appUrl);
      expect(broken.code).toBe(1);
      expect(broken.stdout).toBe("");
      expect(lines(broken.stderr)).toEqual([
        ...issues.map((issue) => `INCONSISTENT ${issue.kind} business=${issue.businessId} sale=${issue.saleId}`),
        `Sales consistency check failed: ${issues.length} issue(s). Nothing was changed.`,
      ]);
      expect(issues).toContainEqual({
        businessId: a.businessId,
        saleId: totalBroken.saleId,
        kind: "SALE_TOTALS_MISMATCH",
      });
      expect(issues).toContainEqual({
        businessId: a.businessId,
        saleId: costBroken.saleId,
        kind: "SALE_VALUATION_MISMATCH",
      });
      expect(broken.stderr).not.toMatch(/Soap|S-0000|50000|35000|amount|price/i);
      expect((await harness.owner.query(`SELECT * FROM sales ORDER BY id`)).rows).toEqual(before.rows);
      expect(await readSalesConsistency()).toEqual(issues);
    });

    it("exits 1 without DATABASE_URL, and on a connection failure prints no credentials", async () => {
      const missing = await checkSalesConsistency(undefined);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("DATABASE_URL (the application role) is required");

      const unreachable = new URL(appUrl);
      unreachable.port = "1";
      const failed = await checkSalesConsistency(unreachable.toString());
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("Sales consistency check could not run");
      expect(failed.stderr).not.toContain(unreachable.toString());
      if (unreachable.password !== "") expect(failed.stderr).not.toContain(unreachable.password);
    });
  });

  describe("broken sales", () => {
    const cases: [string, string, (ids: { sale: string; other: string }) => Promise<string[]>][] = [
      [
        "a wrong header total",
        "SALE_TOTALS_MISMATCH",
        async ({ sale }) => [`UPDATE sales SET total_minor = total_minor + 1 WHERE id = '${sale}'`],
      ],
      [
        "a tender sum that does not match the total",
        "SALE_TENDER_TOTAL_MISMATCH",
        async ({ sale }) => [`UPDATE sale_tenders SET amount_minor = amount_minor + 1 WHERE sale_id = '${sale}'`],
      ],
      [
        "a missing original journal",
        "SALE_ORIGINAL_JOURNAL_MISSING",
        async ({ sale }) => [`UPDATE sales SET journal_entry_id = gen_random_uuid() WHERE id = '${sale}'`],
      ],
      [
        "a link to another journal",
        "SALE_ORIGINAL_JOURNAL_MISMATCH",
        async ({ sale }) => [`UPDATE sales SET journal_entry_id = '${await openingJournal()}' WHERE id = '${sale}'`],
      ],
      [
        "a line linked to another movement",
        "SALE_MOVEMENT_MISMATCH",
        async ({ sale }) => [
          `UPDATE sale_lines SET movement_id = '${await openingMovement()}' WHERE sale_id = '${sale}'`,
        ],
      ],
      [
        "a missing movement valuation",
        "SALE_VALUATION_MISSING",
        async ({ sale }) => [
          `DELETE FROM inventory_movement_valuations
           WHERE movement_id IN (SELECT id FROM inventory_movements WHERE sale_id = '${sale}')`,
        ],
      ],
      [
        "a line cost that does not match its valuation fact",
        "SALE_VALUATION_MISMATCH",
        async ({ sale }) => [`UPDATE sale_lines SET cost_minor = cost_minor + 1 WHERE sale_id = '${sale}'`],
      ],
      [
        "a posted journal that does not match its sale",
        "SALE_POSTING_MISMATCH",
        async ({ sale }) => [
          `UPDATE journal_lines SET amount_minor = amount_minor + 1
           WHERE entry_id = (SELECT journal_entry_id FROM sales WHERE id = '${sale}') AND direction = 'DEBIT'
             AND account_id = (SELECT id FROM ledger_accounts WHERE system_role = 'COST_OF_GOODS_SOLD'
                               AND business_id = (SELECT business_id FROM sales WHERE id = '${sale}'))`,
          `UPDATE journal_lines SET amount_minor = amount_minor + 1
           WHERE entry_id = (SELECT journal_entry_id FROM sales WHERE id = '${sale}') AND direction = 'CREDIT'
             AND account_id = (SELECT id FROM ledger_accounts WHERE system_role = 'INVENTORY'
                               AND business_id = (SELECT business_id FROM sales WHERE id = '${sale}'))`,
        ],
      ],
    ];
    for (const [label, kind, statements] of cases) {
      it(`${label} is ${kind}`, async () => {
        const sale = await sell();
        const other = await sell();
        const found = await brokenWithin(await statements({ sale: sale.saleId, other: other.saleId }));
        expect(found.sales).toContainEqual({ businessId: a.businessId, saleId: sale.saleId, kind });
        expect(found.sales.every((issue) => issue.saleId === sale.saleId)).toBe(true);
        expect(await readSalesConsistency()).toEqual([]);
      });
    }

    it("a reversed sale without its reversal journal is SALE_REVERSAL_JOURNAL_MISSING", async () => {
      const sale = await sellAndReverse();
      const found = await brokenWithin([
        `ALTER TABLE sales DROP CONSTRAINT sales_reversal_journal_fkey`,
        `UPDATE sales SET reversal_journal_entry_id = gen_random_uuid() WHERE id = '${sale.saleId}'`,
      ]);
      expect(found.sales).toContainEqual({
        businessId: a.businessId,
        saleId: sale.saleId,
        kind: "SALE_REVERSAL_JOURNAL_MISSING",
      });
    });

    it("a reversed sale without its reversal movement is SALE_REVERSAL_MOVEMENT_MISSING", async () => {
      const sale = await sellAndReverse();
      const found = await brokenWithin([
        `ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_reversal_fkey`,
        `UPDATE inventory_movements SET reverses_movement_id = '${await openingMovement()}'
         WHERE id = '${await reversalMovement(sale.saleId)}'`,
      ]);
      expect(found.sales).toContainEqual({
        businessId: a.businessId,
        saleId: sale.saleId,
        kind: "SALE_REVERSAL_MOVEMENT_MISSING",
      });
    });
  });

  describe("the ledger check over sale sources", () => {
    async function soldTwice() {
      const sale = await sell();
      const other = await sell();
      const b = await inventoryTenant(harness, "sales-consistency-b");
      const bSoap = await pricedProduct(harness, b, { name: "Soap", quantity: "5", totalCost: "175000" });
      const foreign = (await tenancy.recordSale.execute(b.context, saleInput(harness, [saleLine(bSoap, "1")], "50000")))
        .sale;
      return { sale, other, foreign };
    }

    it("a sale journal whose sale belongs to another business is SOURCE_TENANT_MISMATCH", async () => {
      const { sale, foreign } = await soldTwice();
      const found = await brokenWithin([
        `ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_business_id_sale_id_location_id_fkey`,
        `ALTER TABLE sales DROP CONSTRAINT sales_original_journal_fkey`,
        `UPDATE journal_entries SET sale_id = '${foreign.saleId}' WHERE id = '${sale.journalEntryId}'`,
      ]);
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: sale.journalEntryId,
        kind: "SOURCE_TENANT_MISMATCH",
      });
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: sale.saleId,
        kind: "SALE_ORIGINAL_JOURNAL_MISSING",
      });
    });

    it("a second ORIGINAL journal for one sale is DUPLICATE_ORIGINAL_SOURCE and SALE_ORIGINAL_JOURNAL_MISMATCH", async () => {
      const { sale } = await soldTwice();
      const duplicate = harness.world().ids.newId("JournalEntry");
      const found = await brokenWithin([
        `DROP INDEX journal_entries_original_sale_key`,
        `INSERT INTO journal_entries
         SELECT (jsonb_populate_record(NULL::journal_entries, to_jsonb(e) || jsonb_build_object('id', '${duplicate}'))).*
         FROM journal_entries e WHERE e.id = '${sale.journalEntryId}'`,
        `INSERT INTO journal_lines
         SELECT (jsonb_populate_record(NULL::journal_lines, to_jsonb(l) || jsonb_build_object('entry_id', '${duplicate}'))).*
         FROM journal_lines l WHERE l.entry_id = '${sale.journalEntryId}'`,
      ]);
      expect(kindsFor(found.ledger)).toEqual(
        expect.arrayContaining(["DUPLICATE_ORIGINAL_SOURCE", "SALE_ORIGINAL_JOURNAL_MISMATCH"]),
      );
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: sale.saleId,
        kind: "SALE_ORIGINAL_JOURNAL_MISMATCH",
      });
    });

    it("a sale without an ORIGINAL journal sourced from it is SALE_ORIGINAL_JOURNAL_MISSING", async () => {
      const { sale } = await soldTwice();
      const found = await brokenWithin([
        `ALTER TABLE sales DROP CONSTRAINT sales_original_journal_fkey`,
        `ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_one_source`,
        `UPDATE journal_entries SET sale_id = NULL WHERE id = '${sale.journalEntryId}'`,
      ]);
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: sale.saleId,
        kind: "SALE_ORIGINAL_JOURNAL_MISSING",
      });
    });

    it("a sale linked to another sale's ORIGINAL journal is SALE_ORIGINAL_JOURNAL_MISMATCH", async () => {
      const { sale, other } = await soldTwice();
      const found = await brokenWithin([
        `UPDATE sales SET journal_entry_id = '${other.journalEntryId}' WHERE id = '${sale.saleId}'`,
      ]);
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: sale.saleId,
        kind: "SALE_ORIGINAL_JOURNAL_MISMATCH",
      });
    });

    it("a sale reversal journal sourced from another sale is REVERSAL_SOURCE_MISMATCH", async () => {
      const reversed = await sellAndReverse();
      const other = await sell();
      const found = await brokenWithin([
        `ALTER TABLE sales DROP CONSTRAINT sales_reversal_journal_fkey`,
        `UPDATE journal_entries SET sale_id = '${other.saleId}' WHERE id = '${reversed.reversalJournalEntryId}'`,
      ]);
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: reversed.reversalJournalEntryId,
        kind: "REVERSAL_SOURCE_MISMATCH",
      });
      expect(kindsFor(found.ledger)).toEqual(expect.arrayContaining(["SALE_REVERSAL_JOURNAL_MISMATCH"]));
    });

    it("a sale reversal whose lines do not mirror the original is REVERSAL_DIRECTION_MISMATCH", async () => {
      const reversed = await sellAndReverse();
      const found = await brokenWithin([
        `UPDATE journal_lines SET direction = CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END
         WHERE entry_id = '${reversed.reversalJournalEntryId}'`,
      ]);
      expect(found.ledger).toContainEqual({
        businessId: a.businessId,
        accountId: reversed.reversalJournalEntryId,
        kind: "REVERSAL_DIRECTION_MISMATCH",
      });
    });
  });

  describe("the inventory check over SALE movements", () => {
    it("is clean after sales and a reversal, and catches a broken SALE valuation fact", async () => {
      const sale = await sell();
      await sellAndReverse();
      expect(await readInventoryConsistency()).toEqual([]);
      const found = await brokenWithin([
        `UPDATE inventory_movement_valuations SET value_delta_minor = value_delta_minor - 1
         WHERE movement_id = '${sale.lines[0]?.movementId}'`,
      ]);
      expect(found.inventory.length).toBeGreaterThan(0);
      expect(found.inventory.every((issue) => issue.businessId === a.businessId)).toBe(true);
    });

    it("catches a SALE movement whose quantity no longer chains to the balance", async () => {
      const sale = await sell();
      const found = await brokenWithin([
        `UPDATE inventory_movements SET quantity_delta_minor = quantity_delta_minor - 1
         WHERE id = '${sale.lines[0]?.movementId}'`,
      ]);
      expect(found.inventory.length).toBeGreaterThan(0);
      expect(found.sales).toContainEqual({
        businessId: a.businessId,
        saleId: sale.saleId,
        kind: "SALE_MOVEMENT_MISMATCH",
      });
    });
  });
});
