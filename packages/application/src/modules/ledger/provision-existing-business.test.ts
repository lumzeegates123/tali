import { type BusinessId, defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { AuditRecorder } from "../../audit/audit-recorder.js";
import { taliAuditRegistry } from "../../audit/tali-audit-registry.js";
import { parseCorrelationId } from "../../context/business-context.js";
import { LedgerChartIncompleteError, NotFoundError, ValidationError } from "../../errors/application-error.js";
import { createTenancyHarness, type TenancyHarness } from "../../testing/tenancy-harness.js";
import { createChartOfAccountsProvisioning } from "./provision-chart.js";
import { createProvisionExistingBusinessChart, LEDGER_CHART_OPERATOR_ACTOR } from "./provision-existing-business.js";

const RUN = parseCorrelationId("operator-run");

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2), defineCurrency("JPY", 0)] });
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: h.auditWriter, clock: h.clock, ids: h.ids });
  const provision = createProvisionExistingBusinessChart({
    unitOfWork: h.unitOfWork,
    businesses: h.store.businessRepository,
    chartOfAccounts: createChartOfAccountsProvisioning({ accounts: h.ledger, audit, clock: h.clock, ids: h.ids }),
  });
  const owner = await h.registeredUser("owner");
  const { result } = await h.createBusiness.execute(owner.context, {
    name: "Pre-ledger Shop",
    currencyCode: "JPY",
    timeZone: "Asia/Tokyo",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  });
  const businessId = result.business.id;
  const chartAudits = () =>
    h.auditWriter.businessRecords.filter(
      (record) => record.action === "ledger.chart_provisioned" && record.businessId === businessId,
    );
  return { h, provision, businessId, chartAudits };
}

/** Returns the business to its pre-S2 state (no accounts); audit assertions are relative to it. */
function withoutChart(h: TenancyHarness, businessId: BusinessId) {
  for (const account of h.ledger.accountsFor(businessId)) {
    h.ledger.removeRole(account.businessId, account.systemRole);
  }
}

describe("ProvisionExistingBusinessChart (operator command use case)", () => {
  it("provisions a business without a chart and audits as the system actor", async () => {
    const { h, provision, businessId, chartAudits } = await setup();
    withoutChart(h, businessId);
    const before = chartAudits().length;

    const result = await provision.execute({ businessId, correlationId: RUN });
    expect(result).toEqual({ businessId, templateVersion: 1, accountCount: 13, alreadyProvisioned: false });
    expect(h.ledger.accountsFor(businessId)).toHaveLength(13);
    const written = chartAudits().slice(before);
    expect(written).toEqual([
      expect.objectContaining({
        actor: LEDGER_CHART_OPERATOR_ACTOR,
        sourceChannel: "system",
        correlationId: RUN,
        entityType: "business",
        entityId: businessId,
        payload: { templateVersion: 1, accountCount: 13 },
      }),
    ]);
    expect(written[0]?.idempotencyKey).toBeUndefined();
  });

  it("is a no-op for a business that already has its chart", async () => {
    const { h, provision, businessId, chartAudits } = await setup();
    const accounts = h.ledger.accountsFor(businessId);
    const audits = chartAudits().length;
    await expect(provision.execute({ businessId, correlationId: RUN })).resolves.toMatchObject({
      alreadyProvisioned: true,
    });
    expect(h.ledger.accountsFor(businessId)).toEqual(accounts);
    expect(chartAudits()).toHaveLength(audits);
  });

  it("fails closed on a partial chart without repairing it", async () => {
    const { h, provision, businessId, chartAudits } = await setup();
    h.ledger.removeRole(businessId, "SALES_REVENUE");
    const audits = chartAudits().length;
    await expect(provision.execute({ businessId, correlationId: RUN })).rejects.toBeInstanceOf(
      LedgerChartIncompleteError,
    );
    expect(h.ledger.accountsFor(businessId)).toHaveLength(12);
    expect(chartAudits()).toHaveLength(audits);
  });

  it.each([
    [
      "mixed template versions 1 and 2",
      (h: TenancyHarness, businessId: BusinessId) => {
        h.ledger.corruptAccount(businessId, "TAX_PAYABLE", { templateVersion: 2 });
      },
    ],
    [
      "a chart whose only version (2) has no known template",
      (h: TenancyHarness, businessId: BusinessId) => {
        for (const account of h.ledger.accountsFor(businessId)) {
          h.ledger.corruptAccount(businessId, account.systemRole, { templateVersion: 2 });
        }
      },
    ],
    [
      "a stored account the repository cannot restore (no system role)",
      (h: TenancyHarness, businessId: BusinessId) => {
        h.ledger.addUnreadableAccount(businessId);
      },
    ],
  ])("fails closed on %s as LEDGER_CHART_INCOMPLETE, writing nothing", async (_label, corrupt) => {
    const { h, provision, businessId, chartAudits } = await setup();
    corrupt(h, businessId);
    const accounts = h.ledger.accountsFor(businessId);
    const audits = h.auditWriter.businessRecords.length;
    const chart = chartAudits().length;
    await expect(provision.execute({ businessId, correlationId: RUN })).rejects.toBeInstanceOf(
      LedgerChartIncompleteError,
    );
    expect(h.ledger.accountsFor(businessId)).toEqual(accounts);
    expect(h.auditWriter.businessRecords).toHaveLength(audits);
    expect(chartAudits()).toHaveLength(chart);
  });

  it("rejects an unknown or malformed business id, writing nothing", async () => {
    const { h, provision } = await setup();
    const accounts = h.ledger.accounts.length;
    const audits = h.auditWriter.businessRecords.length;
    await expect(provision.execute({ businessId: h.ids.newId("Business"), correlationId: RUN })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(provision.execute({ businessId: "nope", correlationId: RUN })).rejects.toBeInstanceOf(ValidationError);
    expect(h.ledger.accounts).toHaveLength(accounts);
    expect(h.auditWriter.businessRecords).toHaveLength(audits);
  });

  it("rolls back accounts and audit together when the audit fails", async () => {
    const { h, provision, businessId, chartAudits } = await setup();
    withoutChart(h, businessId);
    const audits = chartAudits().length;
    h.auditWriter.failures.failNext("audit.ledger.chart_provisioned");
    await expect(provision.execute({ businessId, correlationId: RUN })).rejects.toThrow(/injected failure/);
    expect(h.ledger.accountsFor(businessId)).toHaveLength(0);
    expect(chartAudits()).toHaveLength(audits);
  });
});
