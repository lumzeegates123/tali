import {
  AuditRecorder,
  ConflictError,
  createChartOfAccountsProvisioning,
  type LedgerAccountRepository,
  LedgerChartIncompleteError,
  NotFoundError,
  parseCorrelationId,
  taliAuditRegistry,
  ValidationError,
} from "@tali/application";
import { parseBusinessId } from "@tali/domain";
import { afterAll, describe, expect, it } from "vitest";
import { readLedgerConsistency } from "../../src/testing/index.js";
import { delay, gate } from "../support/harness.js";
import { accountCount, asBusinessCreatedBeforeLedger, chartAudits } from "../support/ledger.js";
import { appPool } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const RUN = parseCorrelationId("operator-run-1");

/**
 * ZJ. The operator chart command's use case over PostgreSQL (ADR-009 section
 * 29; maintainer decision M16), composed as apps/api composes it: it
 * provisions template version 1 for a business created before the ledger,
 * audits once as the system actor, is a no-op on rerun, fails closed on a
 * partial or altered chart without repairing it, and serializes concurrent
 * runs on the business row lock. A run that bypasses the lock still cannot
 * create a second chart: the unique keys reject it as ConflictError.
 */
describe("ZJ. operator ledger chart provisioning (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const app = appPool();
  afterAll(() => app.end());

  async function businessBeforeLedger(name = "Pre-ledger Shop", currencyCode = "NGN") {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser(`owner-${name}`);
    const { business } = (await tenancy.create(user, { name, currencyCode })).result;
    await asBusinessCreatedBeforeLedger(harness.owner, business.id);
    return business.id;
  }

  /**
   * Resolves once an application-role backend of this database is waiting on
   * a lock. Polls as the application role: pg_stat_activity shows wait events
   * only for sessions of the querying role.
   */
  async function someoneWaitsOnALock(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await app.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await delay(10);
    }
    throw new Error("no backend started waiting on a lock");
  }

  it("provisions a business created before the ledger, audited once as the system actor", async () => {
    const businessId = await businessBeforeLedger();
    expect(await readLedgerConsistency()).toEqual([{ businessId, accountId: null, kind: "MISSING_CHART" }]);
    const result = await harness.compose().provisionExistingBusinessChart.execute({ businessId, correlationId: RUN });

    expect(result).toEqual({ businessId, templateVersion: 1, accountCount: 13, alreadyProvisioned: false });
    expect(await accountCount(harness.owner, businessId)).toBe(13);
    expect(await chartAudits(harness.owner, businessId)).toEqual([
      {
        actor_type: "system",
        actor_user_id: null,
        actor_name: "ledger.chart_provisioning",
        source_channel: "system",
        correlation_id: "operator-run-1",
        idempotency_key: null,
        entity_type: "business",
        entity_id: businessId,
        payload: { templateVersion: 1, accountCount: 13 },
      },
    ]);
    expect(await readLedgerConsistency()).toEqual([]);
  });

  it("works for a business in a non-NGN currency (the chart is currency-free)", async () => {
    const businessId = await businessBeforeLedger("Yen Shop", "JPY");
    await expect(
      harness.compose().provisionExistingBusinessChart.execute({ businessId, correlationId: RUN }),
    ).resolves.toMatchObject({ alreadyProvisioned: false, accountCount: 13 });
  });

  it("provisions a SUSPENDED business too, so a later reactivation finds its chart", async () => {
    const businessId = await businessBeforeLedger("Suspended Shop");
    await harness.owner.query(`UPDATE businesses SET status = 'SUSPENDED' WHERE id = $1`, [businessId]);
    expect(await readLedgerConsistency()).toEqual([]);
    await expect(
      harness.compose().provisionExistingBusinessChart.execute({ businessId, correlationId: RUN }),
    ).resolves.toMatchObject({ alreadyProvisioned: false, accountCount: 13 });
    expect(await chartAudits(harness.owner, businessId)).toHaveLength(1);
    expect(await readLedgerConsistency()).toEqual([]);
  });

  it("a rerun, and a run for a business created after S2, change nothing and audit nothing", async () => {
    const tenancy = harness.compose();
    const before = await businessBeforeLedger();
    await tenancy.provisionExistingBusinessChart.execute({ businessId: before, correlationId: RUN });
    const user = await tenancy.registeredUser("post-s2-owner");
    const after = (await tenancy.create(user, { name: "New Shop" })).result.business.id;

    for (const businessId of [before, after]) {
      const accountsBefore = await harness.owner.query(
        `SELECT * FROM ledger_accounts WHERE business_id = $1 ORDER BY id`,
        [businessId],
      );
      const rerun = await tenancy.provisionExistingBusinessChart.execute({
        businessId,
        correlationId: parseCorrelationId("operator-run-2"),
      });
      expect(rerun).toEqual({ businessId, templateVersion: 1, accountCount: 13, alreadyProvisioned: true });
      const accountsAfter = await harness.owner.query(
        `SELECT * FROM ledger_accounts WHERE business_id = $1 ORDER BY id`,
        [businessId],
      );
      expect(accountsAfter.rows).toEqual(accountsBefore.rows);
      expect(await chartAudits(harness.owner, businessId)).toHaveLength(1);
    }
  });

  it.each([
    ["a missing account", `DELETE FROM ledger_accounts WHERE business_id = $1 AND system_role = 'SALES_REVENUE'`],
    ["a renamed account", `UPDATE ledger_accounts SET name = 'Takings' WHERE business_id = $1 AND code = '4000'`],
    ["a recoded account", `UPDATE ledger_accounts SET code = '4001' WHERE business_id = $1 AND code = '4000'`],
    [
      "mixed template versions 1 and 2",
      `UPDATE ledger_accounts SET template_version = 2 WHERE business_id = $1 AND system_role = 'TAX_PAYABLE'`,
    ],
    [
      "a chart whose only version (2) is unknown",
      `UPDATE ledger_accounts SET template_version = 2 WHERE business_id = $1`,
    ],
    [
      "an account with no system role",
      `INSERT INTO ledger_accounts (business_id, id, code, name, type, normal_balance, system_role, template_version,
         status, created_at)
       VALUES ($1, gen_random_uuid(), '9000', 'Petty cash', 'ASSET', 'DEBIT', NULL, 1, 'ACTIVE', now())`,
    ],
  ])(
    "fails closed on %s as LEDGER_CHART_INCOMPLETE: no repair, no new account, no audit",
    async (_label, corruption) => {
      const businessId = await businessBeforeLedger();
      const tenancy = harness.compose();
      await tenancy.provisionExistingBusinessChart.execute({ businessId, correlationId: RUN });
      await harness.owner.query(corruption, [businessId]);
      const stored = await harness.owner.query(`SELECT * FROM ledger_accounts WHERE business_id = $1 ORDER BY id`, [
        businessId,
      ]);

      await expect(
        tenancy.provisionExistingBusinessChart.execute({ businessId, correlationId: RUN }),
      ).rejects.toBeInstanceOf(LedgerChartIncompleteError);
      const after = await harness.owner.query(`SELECT * FROM ledger_accounts WHERE business_id = $1 ORDER BY id`, [
        businessId,
      ]);
      expect(after.rows).toEqual(stored.rows);
      expect(await chartAudits(harness.owner, businessId)).toHaveLength(1);
      expect((await readLedgerConsistency()).length).toBeGreaterThan(0);
    },
  );

  it("an unknown or malformed business id writes nothing", async () => {
    const tenancy = harness.compose();
    const unknown = harness.world().ids.newId("Business");
    await expect(
      tenancy.provisionExistingBusinessChart.execute({ businessId: unknown, correlationId: RUN }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      tenancy.provisionExistingBusinessChart.execute({ businessId: "not-a-uuid", correlationId: RUN }),
    ).rejects.toBeInstanceOf(ValidationError);
    const { rows } = await harness.owner.query(`SELECT count(*)::int AS n FROM ledger_accounts`);
    expect(rows[0]).toEqual({ n: 0 });
  });

  describe("concurrent runs", () => {
    it("many runs for one business: exactly one provisions, the rest are no-ops, one audit", async () => {
      for (let round = 0; round < 3; round += 1) {
        const businessId = await businessBeforeLedger(`Race Shop ${round}`);
        const runs = Array.from({ length: 6 }, () =>
          harness.compose().provisionExistingBusinessChart.execute({ businessId, correlationId: RUN }),
        );
        const results = await Promise.all(runs);
        expect(results.filter((result) => !result.alreadyProvisioned)).toHaveLength(1);
        expect(await accountCount(harness.owner, businessId)).toBe(13);
        expect(await chartAudits(harness.owner, businessId)).toHaveLength(1);
      }
      expect(await readLedgerConsistency()).toEqual([]);
    });

    it("a second run waits on the business row lock, then sees the committed chart", async () => {
      const businessId = await businessBeforeLedger();
      const inserted = gate();
      const release = gate();
      const holding: LedgerAccountRepository = {
        ...harness.repositories.ledgerAccounts,
        async insertMany(scope, accounts) {
          await harness.repositories.ledgerAccounts.insertMany(scope, accounts);
          inserted.open();
          await release.opened;
        },
      };
      const first = harness
        .compose({ decorate: { ledgerAccounts: holding } })
        .provisionExistingBusinessChart.execute({ businessId, correlationId: RUN });
      await inserted.opened;
      const second = harness.compose().provisionExistingBusinessChart.execute({ businessId, correlationId: RUN });
      await someoneWaitsOnALock();
      release.open();

      await expect(first).resolves.toMatchObject({ alreadyProvisioned: false });
      await expect(second).resolves.toMatchObject({ alreadyProvisioned: true, accountCount: 13 });
      expect(await chartAudits(harness.owner, businessId)).toHaveLength(1);
    });

    it("provisioning that bypasses the business lock loses the unique-key race as ConflictError", async () => {
      const businessId = parseBusinessId(await businessBeforeLedger());
      const { clock, ids } = harness.world();
      const audit = new AuditRecorder({
        registry: taliAuditRegistry,
        writer: harness.repositories.auditWriter,
        clock,
        ids,
      });
      const inserted = gate();
      const release = gate();
      const holding: LedgerAccountRepository = {
        ...harness.repositories.ledgerAccounts,
        async insertMany(scope, accounts) {
          await harness.repositories.ledgerAccounts.insertMany(scope, accounts);
          inserted.open();
          await release.opened;
        },
      };
      const envelope = {
        businessId,
        actor: { type: "system", process: "ledger.chart_provisioning" } as const,
        sourceChannel: "system" as const,
        correlationId: RUN,
      };
      const holder = createChartOfAccountsProvisioning({ accounts: holding, audit, clock, ids });
      const racer = createChartOfAccountsProvisioning({
        accounts: harness.repositories.ledgerAccounts,
        audit,
        clock,
        ids,
      });

      const first = harness.unitOfWork.run((scope) => holder.provisionInTransaction(scope, envelope));
      await inserted.opened;
      const second = harness.unitOfWork.run((scope) => racer.provisionInTransaction(scope, envelope));
      await someoneWaitsOnALock();
      release.open();

      await expect(first).resolves.toMatchObject({ alreadyProvisioned: false });
      await expect(second).rejects.toBeInstanceOf(ConflictError);
      expect(await accountCount(harness.owner, businessId)).toBe(13);
      expect(await chartAudits(harness.owner, businessId)).toHaveLength(1);
      expect(await readLedgerConsistency()).toEqual([]);
    });
  });
});
