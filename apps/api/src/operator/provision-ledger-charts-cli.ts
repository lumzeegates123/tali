import { ConfigurationError, loadServerConfig } from "@tali/config/server";
import { createDatabase } from "@tali/database";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import { systemClock } from "../composition/api-runtime.js";
import {
  formatProvisionLedgerChartsReport,
  parseProvisionLedgerChartsArgs,
  provisionLedgerCharts,
} from "./provision-ledger-charts.js";

/**
 * Operator entry point: `pnpm --filter @tali/api ops:provision-ledger-charts
 * -- --business <id> ...`. Uses the API process configuration, so it connects
 * as the application role (DATABASE_URL). Exit 0 when every business is
 * provisioned or already was; exit 1 on any failure or invalid usage.
 */
async function main(): Promise<number> {
  const args = parseProvisionLedgerChartsArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`${args.error}\n`);
    return 1;
  }
  const config = loadServerConfig(process.env);
  const database = createDatabase({
    connectionString: config.database.url,
    applicationName: `${config.observability.serviceName}-ledger-chart-provisioning`,
  });
  try {
    const run = await provisionLedgerCharts({ database, clock: systemClock, ids: uuidV7IdGenerator }, args.businessIds);
    for (const line of formatProvisionLedgerChartsReport(run)) process.stdout.write(`${line}\n`);
    return run.outcomes.every((outcome) => outcome.status !== "FAILED") ? 0 : 1;
  } finally {
    await database.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Configuration errors list keys and problems only, never values.
    const message = error instanceof ConfigurationError ? error.message : "ledger chart provisioning could not run";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
