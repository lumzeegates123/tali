import {
  ApplicationError,
  AuditRecorder,
  type Clock,
  createChartOfAccountsProvisioning,
  createProvisionExistingBusinessChart,
  type IdGenerator,
  parseCorrelationId,
  taliAuditRegistry,
} from "@tali/application";
import type { Database } from "@tali/database";

export interface ProvisionLedgerChartsDependencies {
  readonly database: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type ProvisionLedgerChartStatus = "PROVISIONED" | "ALREADY_PROVISIONED" | "FAILED";

export interface ProvisionLedgerChartOutcome {
  /** The identifier as the operator supplied it. */
  readonly businessId: string;
  readonly status: ProvisionLedgerChartStatus;
  /** Application error code for FAILED; UNEXPECTED for anything else. */
  readonly code?: string;
}

export interface ProvisionLedgerChartsRun {
  /** Recorded on every audit the run writes. */
  readonly correlationId: string;
  readonly outcomes: readonly ProvisionLedgerChartOutcome[];
}

export const PROVISION_LEDGER_CHARTS_USAGE =
  "usage: provision-ledger-charts --business <business-id> [--business <business-id> ...]";

/**
 * The business identifiers from `--business <id>` pairs, or an error for
 * anything else. A single leading `--` (passed through by `pnpm run <script>
 * -- ...`) is ignored.
 */
export function parseProvisionLedgerChartsArgs(
  argv: readonly string[],
): { readonly businessIds: readonly string[] } | { readonly error: string } {
  const businessIds: string[] = [];
  for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag !== "--business" || value === undefined || value.startsWith("--")) {
      return { error: PROVISION_LEDGER_CHARTS_USAGE };
    }
    if (!businessIds.includes(value)) businessIds.push(value);
  }
  if (businessIds.length === 0) return { error: PROVISION_LEDGER_CHARTS_USAGE };
  return { businessIds };
}

/**
 * Provisions chart template version 1 for each listed business that existed
 * before the ledger (ADR-009 section 29; maintainer decision M16). Each
 * business runs in its own transaction through the application use case, so
 * one failure never affects another, a rerun is a no-op, and a partial chart
 * fails closed without repair. One correlation ID covers the whole run.
 * Outcomes carry identifiers, statuses and error codes only.
 */
export async function provisionLedgerCharts(
  dependencies: ProvisionLedgerChartsDependencies,
  businessIds: readonly string[],
): Promise<ProvisionLedgerChartsRun> {
  const { database, clock, ids } = dependencies;
  const repos = database.repositories;
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: repos.auditWriter, clock, ids });
  const provision = createProvisionExistingBusinessChart({
    unitOfWork: database.unitOfWork,
    businesses: repos.businesses,
    chartOfAccounts: createChartOfAccountsProvisioning({ accounts: repos.ledgerAccounts, audit, clock, ids }),
  });
  const correlationId = parseCorrelationId(ids.newId("Correlation"));
  const outcomes: ProvisionLedgerChartOutcome[] = [];
  for (const businessId of businessIds) {
    try {
      const result = await provision.execute({ businessId, correlationId });
      outcomes.push({ businessId, status: result.alreadyProvisioned ? "ALREADY_PROVISIONED" : "PROVISIONED" });
    } catch (error) {
      outcomes.push({
        businessId,
        status: "FAILED",
        code: error instanceof ApplicationError ? error.code : "UNEXPECTED",
      });
    }
  }
  return { correlationId, outcomes };
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One line per business plus a summary; never names, amounts or error text.
 * Input that is not a UUID is not echoed back.
 */
export function formatProvisionLedgerChartsReport(run: ProvisionLedgerChartsRun): string[] {
  const lines = run.outcomes.map((outcome) => {
    const business = UUID_TEXT.test(outcome.businessId) ? outcome.businessId : "<invalid>";
    return `business=${business} status=${outcome.status}${outcome.code === undefined ? "" : ` code=${outcome.code}`}`;
  });
  const count = (status: ProvisionLedgerChartStatus) =>
    run.outcomes.filter((outcome) => outcome.status === status).length;
  lines.push(
    `summary correlation=${run.correlationId} provisioned=${count("PROVISIONED")} already_provisioned=${count("ALREADY_PROVISIONED")} failed=${count("FAILED")}`,
  );
  return lines;
}
