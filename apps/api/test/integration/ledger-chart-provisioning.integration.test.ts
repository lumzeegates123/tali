import {
  readLedgerConsistency,
  readLedgerSnapshot,
  readTenancySnapshot,
  resetTenancyTables,
  tenancyFixtures,
} from "@tali/database/testing";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/composition/api-runtime.js";
import {
  formatProvisionLedgerChartsReport,
  provisionLedgerCharts,
} from "../../src/operator/provision-ledger-charts.js";
import { startApi, type ApiHarness } from "../support/api-harness.js";
import { createBusinessAs, registerActor } from "../support/tenancy-client.js";

/**
 * The API composition provisions a ledger chart with every business it
 * creates (ADR-009 section 6), and the operator command provisions charts
 * for businesses created before Build 3 S2 over the same database adapters
 * (ADR-009 section 29; maintainer decision M16). No HTTP route reaches the
 * operator command.
 */
describe("ledger chart provisioning through the API composition (PostgreSQL)", () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    await resetTenancyTables();
  });

  const run = (businessIds: readonly string[]) =>
    provisionLedgerCharts({ database: api.runtime.database, clock: systemClock, ids: uuidV7IdGenerator }, businessIds);
  const chartAuditsOf = async (businessId: string) =>
    (await readTenancySnapshot()).businessAudit.filter(
      (row) => row.businessId === businessId && row.action === "ledger.chart_provisioned",
    );

  it("POST /v1/businesses creates the thirteen template v1 accounts and one chart audit", async () => {
    const owner = await registerActor(api, "ledger-owner", "Ngozi");
    const created = await createBusinessAs(api, owner, { name: "Ngozi Provisions" });
    const accounts = (await readLedgerSnapshot()).accounts.filter((row) => row.businessId === created.business.id);
    expect(accounts).toHaveLength(13);
    expect(accounts.every((row) => row.templateVersion === 1 && row.status === "ACTIVE")).toBe(true);
    const audits = await chartAuditsOf(created.business.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "user", actorUserId: owner.userId, sourceChannel: "api" });
    expect(await readLedgerConsistency()).toEqual([]);
  });

  it("the operator command provisions businesses created before S2, is a no-op on rerun, and reports failures by code", async () => {
    const owner = await registerActor(api, "ledger-operator-owner", "Bola");
    const first = (await createBusinessAs(api, owner, { name: "First" })).business.id;
    const second = (await createBusinessAs(api, owner, { name: "Second" })).business.id;
    await tenancyFixtures.removeLedgerChart(first);
    await tenancyFixtures.removeLedgerChart(second);
    const unknown = uuidV7IdGenerator.newId("Business");
    expect(await readLedgerConsistency()).toEqual(
      [first, second].sort().map((businessId) => ({ businessId, accountId: null, kind: "MISSING_CHART" })),
    );

    const initial = await run([first, second, unknown, "not-a-uuid"]);
    expect(initial.outcomes).toEqual([
      { businessId: first, status: "PROVISIONED" },
      { businessId: second, status: "PROVISIONED" },
      { businessId: unknown, status: "FAILED", code: "NOT_FOUND" },
      { businessId: "not-a-uuid", status: "FAILED", code: "VALIDATION_FAILED" },
    ]);
    const report = formatProvisionLedgerChartsReport(initial);
    expect(report).toEqual([
      `business=${first} status=PROVISIONED`,
      `business=${second} status=PROVISIONED`,
      `business=${unknown} status=FAILED code=NOT_FOUND`,
      "business=<invalid> status=FAILED code=VALIDATION_FAILED",
      `summary correlation=${initial.correlationId} provisioned=2 already_provisioned=0 failed=2`,
    ]);
    for (const businessId of [first, second]) {
      const audits = await chartAuditsOf(businessId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: "system",
        actorUserId: null,
        actorMembershipId: null,
        sourceChannel: "system",
        correlationId: initial.correlationId,
        idempotencyKey: null,
      });
    }
    expect((await readLedgerSnapshot()).accounts).toHaveLength(26);

    const before = await readLedgerSnapshot();
    const rerun = await run([first, second]);
    expect(rerun.outcomes.map((outcome) => outcome.status)).toEqual(["ALREADY_PROVISIONED", "ALREADY_PROVISIONED"]);
    expect(await readLedgerSnapshot()).toEqual(before);
    expect(await chartAuditsOf(first)).toHaveLength(1);
    expect(await readLedgerConsistency()).toEqual([]);
  });
});
