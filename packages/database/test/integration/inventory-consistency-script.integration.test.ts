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
