// Sales consistency check (ADR-011; Plan 005 S5). Every sale's header must
// equal its immutable line and tender snapshots; its original (and, once
// reversed, its reversal) journal must be linked, sourced and posted as
// SALE_POSTED v1 expects; and every tracked line must have exactly its SALE
// movement and valuation fact (and, once reversed, its reversal). Each issue
// is reported as identifiers and a kind, never names, prices or amounts. Runs
// as the application role (DATABASE_URL; least privilege) inside one READ
// ONLY transaction that is always rolled back: it never repairs or changes
// anything. Exit 0: consistent. Exit 1: any issue, or the check could not run.
import pg from "pg";
import { findSalesInconsistencies } from "../src/sales/consistency-query.ts";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error("DATABASE_URL (the application role) is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString, application_name: "tali-sales-consistency" });
let exitCode;
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  try {
    const issues = await findSalesInconsistencies(client);
    for (const issue of issues) {
      console.error(`INCONSISTENT ${issue.kind} business=${issue.businessId} sale=${issue.saleId}`);
    }
    if (issues.length === 0) {
      console.log("Sales consistency check passed: every sale matches its snapshots, journals and stock effects.");
    } else {
      console.error(`Sales consistency check failed: ${issues.length} issue(s). Nothing was changed.`);
    }
    exitCode = issues.length === 0 ? 0 : 1;
  } finally {
    await client.query("ROLLBACK");
  }
} catch (error) {
  console.error(`Sales consistency check could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
process.exit(exitCode);
