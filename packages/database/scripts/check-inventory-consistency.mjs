// Inventory consistency check (ADR-008 section 7.3; plan section T). Compares
// every stock item's balance row with its movement ledger and reports each
// mismatch as identifiers and a kind, never quantities or other data. Runs as
// the application role (DATABASE_URL; least privilege) inside one READ ONLY
// transaction that is always rolled back: it never repairs or changes
// anything. Exit 0: consistent. Exit 1: a mismatch, or the check could not run.
import pg from "pg";
import { findInventoryInconsistencies } from "../src/inventory/consistency-query.ts";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error("DATABASE_URL (the application role) is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString, application_name: "tali-inventory-consistency" });
let exitCode;
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  try {
    const issues = await findInventoryInconsistencies(client);
    for (const issue of issues) {
      console.error(
        `INCONSISTENT ${issue.kind} business=${issue.businessId} location=${issue.locationId} variant=${issue.variantId}`,
      );
    }
    if (issues.length === 0) console.log("Inventory consistency check passed: balances match the movement ledger.");
    else console.error(`Inventory consistency check failed: ${issues.length} mismatch(es). Nothing was changed.`);
    exitCode = issues.length === 0 ? 0 : 1;
  } finally {
    await client.query("ROLLBACK");
  }
} catch (error) {
  console.error(
    `Inventory consistency check could not run: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
process.exit(exitCode);
