import { parseBusinessId, type BusinessId } from "@tali/domain";
import type { CorrelationId, SystemActor } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { LedgerBusinessLock } from "./ports.js";
import type { ChartOfAccountsProvisioning } from "./provision-chart.js";

/** The system actor recorded on audits written by the operator chart command. */
export const LEDGER_CHART_OPERATOR_ACTOR: SystemActor = Object.freeze({
  type: "system",
  process: "ledger.chart_provisioning",
});

export interface ProvisionExistingBusinessChartInput {
  /** The business to provision, as an operator supplies it (validated here). */
  readonly businessId: string;
  readonly correlationId: CorrelationId;
}

export interface ProvisionExistingBusinessChartResult {
  readonly businessId: BusinessId;
  readonly templateVersion: number;
  readonly accountCount: number;
  /** True when the business already had a complete chart: nothing was written. */
  readonly alreadyProvisioned: boolean;
}

/**
 * Rollout of chart template version 1 to a business that existed before the
 * ledger (ADR-009 section 29; maintainer decision M16): the idempotent
 * operator command, never a SQL backfill. One transaction per business, under
 * the business row lock, so concurrent runs serialize: the first provisions
 * and audits as the system actor, every later run is a no-op. A partial or
 * inconsistent chart fails closed with LEDGER_CHART_INCOMPLETE and is never
 * repaired. Not reachable from any HTTP route.
 */
export interface ProvisionExistingBusinessChart {
  execute(input: ProvisionExistingBusinessChartInput): Promise<ProvisionExistingBusinessChartResult>;
}

export function createProvisionExistingBusinessChart(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly businesses: LedgerBusinessLock;
  readonly chartOfAccounts: ChartOfAccountsProvisioning;
}): ProvisionExistingBusinessChart {
  return {
    async execute(input) {
      const businessId = withDomainRules(() => parseBusinessId(input.businessId), "businessId");
      return dependencies.unitOfWork.run(async (scope) => {
        if ((await dependencies.businesses.findByIdForUpdate(scope, businessId)) === undefined) {
          throw new NotFoundError();
        }
        const result = await dependencies.chartOfAccounts.provisionInTransaction(scope, {
          businessId,
          actor: LEDGER_CHART_OPERATOR_ACTOR,
          sourceChannel: "system",
          correlationId: input.correlationId,
        });
        return {
          businessId: result.businessId,
          templateVersion: result.templateVersion,
          accountCount: result.accountCount,
          alreadyProvisioned: result.alreadyProvisioned,
        };
      });
    },
  };
}
