// Ledger consistency check (ADR-009 sections 29 and 30; Plan 005 S2). Every
// ACTIVE business must have a chart of accounts (MISSING_CHART otherwise),
// and every business's accounts must match the chart template they were
// provisioned from. Each issue is reported as identifiers and a kind, never
// names, codes or other data. Runs as the application role (DATABASE_URL;
// least privilege) inside one READ ONLY transaction that is always rolled
// back: it never repairs or changes anything. Businesses that existed before
// S2 report MISSING_CHART until the operator provisioning command runs for
// them. Exit 0: consistent. Exit 1: any issue, or the check could not run.
import pg from "pg";
import { findLedgerInconsistencies } from "../src/ledger/consistency-query.ts";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error("DATABASE_URL (the application role) is required");
  process.exit(1);
}

const client = new pg.Client({ connectionString, application_name: "tali-ledger-consistency" });
let exitCode;
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  try {
    const issues = await findLedgerInconsistencies(client);
    for (const issue of issues) {
      const account = issue.accountId === null ? "" : ` account=${issue.accountId}`;
      console.error(`INCONSISTENT ${issue.kind} business=${issue.businessId}${account}`);
    }
    if (issues.length === 0) {
      console.log("Ledger consistency check passed: every active business has a chart matching its template.");
    } else {
      console.error(`Ledger consistency check failed: ${issues.length} issue(s). Nothing was changed.`);
    }
    exitCode = issues.length === 0 ? 0 : 1;
  } finally {
    await client.query("ROLLBACK");
  }
} catch (error) {
  console.error(`Ledger consistency check could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
process.exit(exitCode);
