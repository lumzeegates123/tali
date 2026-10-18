import {
  CHART_TEMPLATE_V1,
  chartTemplateByVersion,
  findChartTemplate,
  normalBalanceFor,
  type BusinessId,
  type ChartTemplate,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope, type BusinessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import { ConflictError, LedgerChartIncompleteError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import { ledgerChartProvisioned } from "./audit-actions.js";
import { StoredLedgerAccountInvalidError, type LedgerAccount, type LedgerAccountRepository } from "./ports.js";

export const CHART_TEMPLATE_VERSION_V1 = 1;

export interface ProvisionChartOfAccountsInput {
  /** Defaults to template version 1 (Build 3). */
  readonly templateVersion?: number;
}

export interface ProvisionChartOfAccountsResult {
  readonly businessId: BusinessId;
  readonly templateVersion: number;
  readonly accountCount: number;
  /** True when the chart for this template version was already present. */
  readonly alreadyProvisioned: boolean;
  readonly accounts: readonly LedgerAccount[];
}

/**
 * Idempotent chart provisioning by `(businessId, templateVersion)` (ADR-009
 * section 6). Creates exactly one ACTIVE account per system role of the
 * template. Replay returns the existing accounts and writes no second audit
 * record. A partial or inconsistent chart (including mixed template versions,
 * a version with no known template, or a stored account that cannot be
 * restored) fails closed with `LEDGER_CHART_INCOMPLETE` (no silent repair).
 */
export interface ProvisionChartOfAccounts {
  execute(context: BusinessContext, input?: ProvisionChartOfAccountsInput): Promise<ProvisionChartOfAccountsResult>;
}

/**
 * The same provisioning as a step inside the caller's transaction, so business
 * creation writes the chart and its audit record atomically with the business
 * (ADR-009 section 6), and the operator command reuses it under its own lock.
 * It opens no unit of work.
 */
export interface ChartOfAccountsProvisioning {
  provisionInTransaction(
    scope: TransactionScope,
    envelope: BusinessAuditEnvelope,
    input?: ProvisionChartOfAccountsInput,
  ): Promise<ProvisionChartOfAccountsResult>;
}

export interface ChartProvisioningDependencies {
  readonly accounts: LedgerAccountRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ProvisionChartDependencies extends ChartProvisioningDependencies {
  readonly unitOfWork: UnitOfWork;
}

/**
 * Returns true only when every template row is present exactly once with matching
 * code, name, type, normal balance and template version. Extras or mismatches
 * fail closed.
 */
export function chartMatchesTemplate(accounts: readonly LedgerAccount[], template: ChartTemplate): boolean {
  const forVersion = accounts.filter((account) => account.templateVersion === template.version);
  if (forVersion.length !== template.accounts.length) {
    return false;
  }
  const byRole = new Map(forVersion.map((account) => [account.systemRole, account]));
  if (byRole.size !== template.accounts.length) {
    return false;
  }
  for (const row of template.accounts) {
    const account = byRole.get(row.systemRole);
    if (account === undefined) {
      return false;
    }
    if (
      account.code !== row.code ||
      account.name !== row.name ||
      account.type !== row.type ||
      account.normalBalance !== normalBalanceFor(row.type) ||
      account.systemRole !== row.systemRole ||
      account.templateVersion !== template.version
    ) {
      return false;
    }
  }
  return true;
}

/** The stored chart; a row the repository cannot restore makes the chart incomplete. */
async function storedChart(
  accounts: LedgerAccountRepository,
  scope: TransactionScope,
  businessId: BusinessId,
): Promise<readonly LedgerAccount[]> {
  try {
    return await accounts.listByBusiness(scope, businessId);
  } catch (error) {
    if (error instanceof StoredLedgerAccountInvalidError) throw new LedgerChartIncompleteError();
    throw error;
  }
}

export function createChartOfAccountsProvisioning(
  dependencies: ChartProvisioningDependencies,
): ChartOfAccountsProvisioning {
  return {
    async provisionInTransaction(scope, envelope, input = {}) {
      const templateVersion = input.templateVersion ?? CHART_TEMPLATE_VERSION_V1;
      const template = withDomainRules(() => chartTemplateByVersion(templateVersion));
      const businessId = envelope.businessId;

      const existingVersions = await dependencies.accounts.listProvisionedTemplateVersions(scope, businessId);
      if (existingVersions.length > 0) {
        const [existingVersion] = existingVersions;
        // Mixed versions, or a version this application has no template for,
        // are a corrupt chart: fail closed, never repair.
        if (
          existingVersions.length !== 1 ||
          existingVersion === undefined ||
          findChartTemplate(existingVersion) === undefined
        ) {
          throw new LedgerChartIncompleteError();
        }
        if (existingVersion !== templateVersion) {
          throw new ConflictError(
            `ledger chart template version ${existingVersion} is already provisioned for this business`,
          );
        }
        const accounts = await storedChart(dependencies.accounts, scope, businessId);
        if (!chartMatchesTemplate(accounts, template)) {
          throw new LedgerChartIncompleteError();
        }
        return {
          businessId,
          templateVersion,
          accountCount: accounts.length,
          alreadyProvisioned: true,
          accounts,
        };
      }

      const now = dependencies.clock.now();
      const accounts: LedgerAccount[] = template.accounts.map((row) =>
        Object.freeze({
          id: dependencies.ids.newId("LedgerAccount"),
          businessId,
          code: row.code,
          name: row.name,
          type: row.type,
          normalBalance: normalBalanceFor(row.type),
          systemRole: row.systemRole,
          templateVersion: template.version,
          status: "ACTIVE" as const,
          createdAt: now,
        }),
      );

      if (template.version === CHART_TEMPLATE_V1.version && accounts.length !== CHART_TEMPLATE_V1.accounts.length) {
        throw new ConflictError("chart template account count is inconsistent");
      }

      await dependencies.accounts.insertMany(scope, accounts);
      await dependencies.audit.recordBusinessEvent(scope, ledgerChartProvisioned, {
        ...envelope,
        entityId: businessId,
        payload: { templateVersion: template.version, accountCount: accounts.length },
      });

      return {
        businessId,
        templateVersion: template.version,
        accountCount: accounts.length,
        alreadyProvisioned: false,
        accounts,
      };
    },
  };
}

export function createProvisionChartOfAccounts(dependencies: ProvisionChartDependencies): ProvisionChartOfAccounts {
  const provisioning = createChartOfAccountsProvisioning(dependencies);
  return {
    async execute(context, input = {}) {
      return dependencies.unitOfWork.run((scope) =>
        provisioning.provisionInTransaction(scope, businessAuditEnvelope(context), input),
      );
    },
  };
}
