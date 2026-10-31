import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readInventoryConsistency, readInventorySnapshot, testDatabaseUrls } from "../../src/testing/index.js";
import { inventoryProduct, inventoryTenant } from "../support/inventory.js";
import { useTenancyHarness } from "../support/tenancy.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

interface ScriptRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the operator script as `db:inventory-consistency` does: no shell, with only the given DATABASE_URL. */
function checkInventoryConsistency(databaseUrl: string | undefined): Promise<ScriptRun> {
  const inherited = { ...process.env };
  delete inherited["DATABASE_URL"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/check-inventory-consistency.mjs"], {
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

/**
 * The read-only inventory consistency check (plan section T; D16): run as the
 * application role, it reports an injected balance mismatch by identifiers and
 * kind only, exits 1, and changes nothing; a consistent ledger exits 0.
 */
describe("db:inventory-consistency (operator script)", () => {
  const harness = useTenancyHarness();
  const appUrl = testDatabaseUrls().app;

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  it("passes on a consistent ledger, reports an injected mismatch without repairing it, and exits 1", async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "consistency-script");
    const sugar = await inventoryProduct(harness, t, { name: "Sugar" });
    await tenancy.postGoodsReceipt.execute(t.context, {
      lines: [{ variantId: sugar.variant.id, quantityMinor: "12", unit: "PIECE" }],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });

    const clean = await checkInventoryConsistency(appUrl);
    expect(clean).toMatchObject({ code: 0, stderr: "" });
    expect(clean.stdout).toContain("Inventory consistency check passed");

    const stockItem = [t.businessId, t.locationId, sugar.variant.id];
    const where = "business_id = $1 AND location_id = $2 AND variant_id = $3";
    await harness.owner.query(
      `UPDATE inventory_balances SET quantity_minor = quantity_minor + 1 WHERE ${where}`,
      stockItem,
    );
    try {
      const before = await readInventorySnapshot();
      const broken = await checkInventoryConsistency(appUrl);
      expect(broken.code).toBe(1);
      expect(broken.stderr.trim().split(/\r?\n/)).toEqual([
        `INCONSISTENT BALANCE_QUANTITY_MISMATCH business=${t.businessId} location=${t.locationId} variant=${sugar.variant.id}`,
        "Inventory consistency check failed: 1 mismatch(es). Nothing was changed.",
      ]);
      expect(broken.stdout).toBe("");
      expect(`${broken.stdout}${broken.stderr}`).not.toMatch(/\b1[23]\b/);
      expect(await readInventorySnapshot()).toEqual(before);
      expect(before.balances.find((row) => row.variantId === sugar.variant.id)?.quantityText).toBe("13");
    } finally {
      await harness.owner.query(
        `UPDATE inventory_balances SET quantity_minor = quantity_minor - 1 WHERE ${where}`,
        stockItem,
      );
    }
  });

  it("reports missing post-cutover movement facts, valued zero-qty leftover value, and the inventory ledger invariant", async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "valuation-consistency");
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
    const fact = await harness.owner.query<{ movement_id: string }>(
      `SELECT movement_id::text FROM inventory_movement_valuations WHERE business_id = $1`,
      [t.businessId],
    );
    const movementId = fact.rows[0]?.movement_id;
    const saved = await harness.owner.query(
      `SELECT * FROM inventory_movement_valuations WHERE business_id = $1 AND movement_id = $2`,
      [t.businessId, movementId],
    );
    await harness.owner.query(`DELETE FROM inventory_movement_valuations WHERE business_id = $1 AND movement_id = $2`, [
      t.businessId,
      movementId,
    ]);
    try {
      const missing = await checkInventoryConsistency(appUrl);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("MISSING_MOVEMENT_VALUATION");
      expect(missing.stderr).not.toMatch(/Soap|200/);
    } finally {
      const row = saved.rows[0] as Record<string, unknown>;
      await harness.owner.query(
        `INSERT INTO inventory_movement_valuations (
           business_id, movement_id, cost_basis, value_delta_minor, value_after_minor, currency,
           status_after, supplied_cost_minor, journal_entry_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row["business_id"],
          row["movement_id"],
          row["cost_basis"],
          row["value_delta_minor"],
          row["value_after_minor"],
          row["currency"],
          row["status_after"],
          row["supplied_cost_minor"],
          row["journal_entry_id"],
        ],
      );
    }

    await tenancy.recordWriteOff.execute(t.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "2", unit: "PIECE" }],
      reasonCode: "THEFT_OR_LOSS",
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    await harness.owner.query(
      `UPDATE inventory_valuations SET value_minor = 1
       WHERE business_id = $1 AND variant_id = $2`,
      [t.businessId, soap.variant.id],
    );
    try {
      const leftover = await checkInventoryConsistency(appUrl);
      expect(leftover.code).toBe(1);
      expect(leftover.stderr).toContain("VALUED_ZERO_QTY_NONZERO_VALUE");
      expect(leftover.stderr).toContain("INVENTORY_LEDGER_MISMATCH");
    } finally {
      await harness.owner.query(
        `UPDATE inventory_valuations SET value_minor = 0
         WHERE business_id = $1 AND variant_id = $2`,
        [t.businessId, soap.variant.id],
      );
    }
  });

  it("reports a negative reversal fact that is missing its residual pair", async () => {
    const tenancy = harness.compose();
    const t = await inventoryTenant(harness, "residual-consistency");
    const soap = await inventoryProduct(harness, t, { name: "Soap" });
    await tenancy.recordOpeningStock.execute(t.context, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    const receipt = await tenancy.postGoodsReceipt.execute(t.context, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "10",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: harness.world().ids.newId("IdempotencyKey"),
    });
    await tenancy.reverseGoodsReceipt.execute(t.context, {
      documentId: receipt.document.id,
      reason: "Returned the delivery",
    });
    const reversal = await harness.owner.query<{ movement_id: string }>(
      `SELECT f.movement_id::text
       FROM inventory_movement_valuations f
       JOIN inventory_movements m ON m.id = f.movement_id
       WHERE m.business_id = $1 AND m.reverses_movement_id IS NOT NULL`,
      [t.businessId],
    );
    const saved = await harness.owner.query<{ value_after_minor: string }>(
      `SELECT value_after_minor::text FROM inventory_movement_valuations WHERE movement_id = $1`,
      [reversal.rows[0]?.movement_id],
    );
    await harness.owner.query(
      `UPDATE inventory_movement_valuations SET value_after_minor = -1 WHERE movement_id = $1`,
      [reversal.rows[0]?.movement_id],
    );
    try {
      const missing = await checkInventoryConsistency(appUrl);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("MISSING_RESIDUAL");
      expect(missing.stderr).toContain("NEGATIVE_VALUE_AFTER_UNPAIRED");
    } finally {
      await harness.owner.query(
        `UPDATE inventory_movement_valuations SET value_after_minor = $2 WHERE movement_id = $1`,
        [reversal.rows[0]?.movement_id, saved.rows[0]?.value_after_minor],
      );
    }
  });

  it("exits 1 without DATABASE_URL, and on a connection failure prints no credentials", async () => {
    const missing = await checkInventoryConsistency(undefined);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("DATABASE_URL (the application role) is required");

    const unreachable = new URL(appUrl);
    unreachable.port = "1";
    const failed = await checkInventoryConsistency(unreachable.toString());
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Inventory consistency check could not run");
    expect(failed.stderr).not.toContain(unreachable.toString());
    if (unreachable.password !== "") expect(failed.stderr).not.toContain(unreachable.password);
  });
});
