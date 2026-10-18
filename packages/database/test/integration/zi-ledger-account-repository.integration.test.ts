import {
  ConflictError,
  type LedgerAccount,
  StoredLedgerAccountInvalidError,
  type TransactionScope,
} from "@tali/application";
import {
  CHART_TEMPLATE_V1,
  normalBalanceFor,
  parseBusinessId,
  parseLedgerAccountId,
  SYSTEM_ACCOUNT_ROLES,
  type BusinessId,
} from "@tali/domain";
import { describe, expect, it } from "vitest";
import { readLedgerConsistency } from "../../src/testing/index.js";
import { accountRow, asBusinessCreatedBeforeLedger, insertAccount } from "../support/ledger.js";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * ZI. The PostgreSQL LedgerAccountRepository (ADR-009 sections 4 to 6): every
 * lookup is scoped by business, rows map through the domain parsers and fail
 * closed on anything the template cannot produce, and a lost provisioning
 * race surfaces as ConflictError with nothing partially written.
 */
describe("ZI. ledger account repository (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const accounts = harness.repositories.ledgerAccounts;
  const run = <T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> => harness.unitOfWork.run(work);

  async function twoBusinesses() {
    const tenancy = harness.compose();
    const user = await tenancy.registeredUser("ledger-repository");
    const a = (await tenancy.create(user, { name: "Naira Shop", currencyCode: "NGN" })).result.business;
    const b = (await tenancy.create(user, { name: "Yen Shop", currencyCode: "JPY", timeZone: "Asia/Tokyo" })).result
      .business;
    return { a: a.id, b: b.id };
  }

  function templateAccounts(businessId: BusinessId): LedgerAccount[] {
    return CHART_TEMPLATE_V1.accounts.map((template) => ({
      id: parseLedgerAccountId(harness.world().ids.newId("LedgerAccount")),
      businessId,
      code: template.code,
      name: template.name,
      type: template.type,
      normalBalance: normalBalanceFor(template.type),
      systemRole: template.systemRole,
      templateVersion: 1,
      status: "ACTIVE",
      createdAt: new Date("2026-10-16T08:00:00.000Z"),
    }));
  }

  it("reads the chart business creation provisioned, ordered by code, in any currency", async () => {
    const { a, b } = await twoBusinesses();
    for (const businessId of [a, b]) {
      const listed = await run((scope) => accounts.listByBusiness(scope, businessId));
      expect(listed.map((account) => account.code)).toEqual(
        [...CHART_TEMPLATE_V1.accounts.map((account) => account.code)].sort(),
      );
      expect(new Set(listed.map((account) => account.systemRole))).toEqual(new Set(SYSTEM_ACCOUNT_ROLES));
      expect(listed.every((account) => account.businessId === businessId)).toBe(true);
      expect(await run((scope) => accounts.listProvisionedTemplateVersions(scope, businessId))).toEqual([1]);
      const inventory = await run((scope) => accounts.findByRole(scope, businessId, "INVENTORY"));
      expect(inventory).toMatchObject({ businessId, code: "1200", type: "ASSET", normalBalance: "DEBIT" });
    }
    expect(await readLedgerConsistency()).toEqual([]);
  });

  it("never returns another business's account (tenant isolation)", async () => {
    const { a, b } = await twoBusinesses();
    const cashA = await run((scope) => accounts.findByRole(scope, a, "CASH_ON_HAND"));
    const cashB = await run((scope) => accounts.findByRole(scope, b, "CASH_ON_HAND"));
    expect(cashA?.id).toBeDefined();
    expect(cashB?.id).toBeDefined();
    expect(cashA?.id).not.toBe(cashB?.id);

    await asBusinessCreatedBeforeLedger(harness.owner, b);
    expect(await run((scope) => accounts.findByRole(scope, b, "CASH_ON_HAND"))).toBeUndefined();
    expect(await run((scope) => accounts.listByBusiness(scope, b))).toEqual([]);
    expect(await run((scope) => accounts.listProvisionedTemplateVersions(scope, b))).toEqual([]);
    expect(await run((scope) => accounts.listByBusiness(scope, a))).toHaveLength(13);
    const unknown = parseBusinessId(harness.world().ids.newId("Business"));
    expect(await run((scope) => accounts.listByBusiness(scope, unknown))).toEqual([]);
  });

  it("inserts a chart and reads back exactly what was written", async () => {
    const { b } = await twoBusinesses();
    await asBusinessCreatedBeforeLedger(harness.owner, b);
    const written = templateAccounts(b);
    await run((scope) => accounts.insertMany(scope, written));
    const listed = await run((scope) => accounts.listByBusiness(scope, b));
    expect(listed).toEqual([...written].sort((x, y) => x.code.localeCompare(y.code)));
  });

  it("an empty insert writes nothing", async () => {
    const { b } = await twoBusinesses();
    await asBusinessCreatedBeforeLedger(harness.owner, b);
    await run((scope) => accounts.insertMany(scope, []));
    expect(await run((scope) => accounts.listByBusiness(scope, b))).toEqual([]);
  });

  it("a duplicate role surfaces as ConflictError and rolls back the whole insert", async () => {
    const { a, b } = await twoBusinesses();
    await asBusinessCreatedBeforeLedger(harness.owner, b);
    const first = templateAccounts(b).slice(0, 2);
    await run((scope) => accounts.insertMany(scope, first));
    // A second chart for b: its first two roles collide with the rows above.
    await expect(run((scope) => accounts.insertMany(scope, templateAccounts(b)))).rejects.toBeInstanceOf(ConflictError);
    expect(await run((scope) => accounts.listByBusiness(scope, b))).toEqual(first);
    // An account id reused across tenants is rejected too, and a's chart is untouched.
    const [accountOfA] = await run((scope) => accounts.listByBusiness(scope, a));
    const [, , , , , sixth] = templateAccounts(b);
    expect(accountOfA).toBeDefined();
    expect(sixth).toBeDefined();
    if (accountOfA === undefined || sixth === undefined) return;
    const reused = { ...sixth, id: accountOfA.id };
    await expect(run((scope) => accounts.insertMany(scope, [reused]))).rejects.toBeInstanceOf(ConflictError);
    expect(await run((scope) => accounts.listByBusiness(scope, a))).toHaveLength(13);
  });

  it("fails closed on a stored account with no system role instead of guessing", async () => {
    const { b } = await twoBusinesses();
    await insertAccount(
      harness.owner,
      accountRow(b, harness.world().ids.newId("LedgerAccount"), {
        code: "9000",
        name: "Petty cash",
        system_role: null,
      }),
    );
    const read = run((scope) => accounts.listByBusiness(scope, b));
    await expect(read).rejects.toBeInstanceOf(StoredLedgerAccountInvalidError);
    await expect(read).rejects.toThrow(/no system role/);
    expect((await readLedgerConsistency()).map((issue) => issue.kind)).toEqual(["ACCOUNT_WITHOUT_SYSTEM_ROLE"]);
    await harness.owner.query(`DELETE FROM ledger_accounts WHERE business_id = $1 AND code = '9000'`, [b]);
  });

  it("reports every distinct stored template version, so a mixed chart is visible to the caller", async () => {
    const { a, b } = await twoBusinesses();
    await harness.owner.query(
      `UPDATE ledger_accounts SET template_version = 2 WHERE business_id = $1 AND system_role = 'TAX_PAYABLE'`,
      [b],
    );
    expect(await run((scope) => accounts.listProvisionedTemplateVersions(scope, b))).toEqual([1, 2]);
    expect(await run((scope) => accounts.listProvisionedTemplateVersions(scope, a))).toEqual([1]);
  });
});
