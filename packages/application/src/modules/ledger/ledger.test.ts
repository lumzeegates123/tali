import {
  CHART_TEMPLATE_V1,
  Money,
  SYSTEM_ACCOUNT_ROLES,
  createPostingPlan,
  defineCurrency,
  parseCurrencyCode,
  reversePostingPlan,
  type MembershipRole,
} from "@tali/domain";
import { describe, expect, it } from "vitest";
import { AuditRecorder } from "../../audit/audit-recorder.js";
import { taliAuditRegistry } from "../../audit/tali-audit-registry.js";
import type { BusinessContext } from "../../context/business-context.js";
import {
  LedgerChartIncompleteError,
  LedgerNotProvisionedError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/application-error.js";
import { createCatalogHarness } from "../../testing/catalog-harness.js";
import { InMemoryLedgerStore } from "../../testing/in-memory-ledger-store.js";
import { createLedgerPostingService } from "./posting.js";
import { createProvisionChartOfAccounts } from "./provision-chart.js";
import { createGetJournalEntry, createListAccountBalances, createListLedgerAccounts } from "./reads.js";

async function setup(currencyCode: "NGN" | "KES" | "USD" = "KES") {
  const catalog = createCatalogHarness({
    currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2), defineCurrency("USD", 2)],
  });
  const { tenancy } = catalog;
  const ledger = new InMemoryLedgerStore({ unitOfWork: tenancy.unitOfWork });
  const audit = new AuditRecorder({
    registry: taliAuditRegistry,
    writer: tenancy.auditWriter,
    clock: tenancy.clock,
    ids: tenancy.ids,
  });
  const provision = createProvisionChartOfAccounts({
    unitOfWork: tenancy.unitOfWork,
    accounts: ledger,
    audit,
    clock: tenancy.clock,
    ids: tenancy.ids,
  });
  const posting = createLedgerPostingService({
    accounts: ledger,
    journals: ledger,
    clock: tenancy.clock,
    ids: tenancy.ids,
  });
  const reads = {
    listAccounts: createListLedgerAccounts({ unitOfWork: tenancy.unitOfWork, accounts: ledger, journals: ledger }),
    listBalances: createListAccountBalances({ unitOfWork: tenancy.unitOfWork, accounts: ledger, journals: ledger }),
    getEntry: createGetJournalEntry({ unitOfWork: tenancy.unitOfWork, accounts: ledger, journals: ledger }),
  };
  const roles = await catalog.businessWithRoles(`Shop-${currencyCode}`, currencyCode);
  return { catalog, tenancy, ledger, provision, posting, reads, roles };
}

function money(context: BusinessContext, minor: bigint) {
  return Money.ofMinor(minor, context.currency);
}

function saleSource(ids: { newId: (entity: string) => string }) {
  return { kind: "sale" as const, id: ids.newId("Sale") };
}

describe("ProvisionChartOfAccounts", () => {
  it("creates exactly one account per accepted system role", async () => {
    const { provision, roles, ledger } = await setup();
    const result = await provision.execute(roles.OWNER);
    expect(result.alreadyProvisioned).toBe(false);
    expect(result.accountCount).toBe(13);
    expect(result.templateVersion).toBe(1);
    expect(result.accounts.map((a) => a.systemRole).sort()).toEqual([...SYSTEM_ACCOUNT_ROLES].sort());
    expect(ledger.accountsFor(roles.OWNER.businessId)).toHaveLength(13);
    expect(result.accounts.map((a) => a.code).sort()).toEqual(
      [...CHART_TEMPLATE_V1.accounts.map((a) => a.code)].sort(),
    );
  });

  it("is idempotent on replay and does not write a second audit record", async () => {
    const { provision, roles, tenancy, ledger } = await setup();
    const first = await provision.execute(roles.OWNER);
    const auditsBefore = tenancy.auditWriter.businessRecords.filter((r) => r.action === "ledger.chart_provisioned");
    expect(auditsBefore).toHaveLength(1);
    expect(auditsBefore[0]?.payload).toEqual({ templateVersion: 1, accountCount: 13 });

    const second = await provision.execute(roles.OWNER);
    expect(second.alreadyProvisioned).toBe(true);
    expect(second.accountCount).toBe(13);
    expect(second.accounts.map((a) => a.id).sort()).toEqual(first.accounts.map((a) => a.id).sort());
    expect(ledger.accountsFor(roles.OWNER.businessId)).toHaveLength(13);
    expect(tenancy.auditWriter.businessRecords.filter((r) => r.action === "ledger.chart_provisioned")).toHaveLength(1);
  });

  it("provisions another business in isolation", async () => {
    const { provision, roles, catalog, ledger } = await setup("KES");
    await provision.execute(roles.OWNER);
    const other = await catalog.businessWithRoles("Other", "USD");
    await provision.execute(other.OWNER);
    expect(ledger.accountsFor(roles.OWNER.businessId)).toHaveLength(13);
    expect(ledger.accountsFor(other.OWNER.businessId)).toHaveLength(13);
    expect(new Set(ledger.accountsFor(roles.OWNER.businessId).map((a) => a.businessId))).toEqual(
      new Set([roles.OWNER.businessId]),
    );
    expect(new Set(ledger.accountsFor(other.OWNER.businessId).map((a) => a.businessId))).toEqual(
      new Set([other.OWNER.businessId]),
    );
  });

  it("rolls back accounts and audit when insert fails", async () => {
    const { provision, roles, ledger, tenancy } = await setup();
    ledger.failures.failNext("ledger.accounts.insertMany");
    await expect(provision.execute(roles.OWNER)).rejects.toThrow();
    expect(ledger.accountsFor(roles.OWNER.businessId)).toHaveLength(0);
    expect(tenancy.auditWriter.businessRecords.filter((r) => r.action === "ledger.chart_provisioned")).toHaveLength(0);
    expect(tenancy.unitOfWork.rollbacks).toBeGreaterThan(0);
  });

  it("fails closed on a partial chart without repairing or auditing", async () => {
    const { provision, roles, ledger, tenancy } = await setup();
    await provision.execute(roles.OWNER);
    ledger.removeRole(roles.OWNER.businessId, "SALES_REVENUE");
    const remaining = ledger.accountsFor(roles.OWNER.businessId).map((account) => account.id);
    expect(remaining).toHaveLength(12);
    await expect(provision.execute(roles.OWNER)).rejects.toBeInstanceOf(LedgerChartIncompleteError);
    expect(
      ledger
        .accountsFor(roles.OWNER.businessId)
        .map((account) => account.id)
        .sort(),
    ).toEqual([...remaining].sort());
    expect(tenancy.auditWriter.businessRecords.filter((r) => r.action === "ledger.chart_provisioned")).toHaveLength(1);
  });

  it("fails closed when an existing account code or type is inconsistent", async () => {
    const { provision, roles, ledger, tenancy } = await setup();
    await provision.execute(roles.OWNER);
    ledger.corruptAccount(roles.OWNER.businessId, "CASH_ON_HAND", { code: "9999", type: "LIABILITY" });
    await expect(provision.execute(roles.OWNER)).rejects.toBeInstanceOf(LedgerChartIncompleteError);
    expect(tenancy.auditWriter.businessRecords.filter((r) => r.action === "ledger.chart_provisioned")).toHaveLength(1);
    expect(ledger.accountsFor(roles.OWNER.businessId)).toHaveLength(13);
  });
});

describe("LedgerPostingService", () => {
  it("resolves roles by business and posts a balanced entry", async () => {
    const { provision, posting, roles, ledger, tenancy } = await setup("USD");
    await provision.execute(roles.OWNER);
    const plan = createPostingPlan(roles.OWNER.currency, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(roles.OWNER, 1000n), memoKind: "TENDER_CASH" },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: money(roles.OWNER, 1000n), memoKind: "REVENUE" },
    ]);
    const { entry } = await tenancy.unitOfWork.run((scope) =>
      posting.post(scope, roles.OWNER, {
        plan,
        source: saleSource(tenancy.ids),
        postingRule: "SALE_POSTED",
        postingRuleVersion: 1,
        description: "Sale S-000001",
      }),
    );
    expect(entry.currency).toBe("USD");
    expect(entry.entryKind).toBe("ORIGINAL");
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.map((line) => line.accountId)).toContain(
      ledger.accountId(roles.OWNER.businessId, "CASH_ON_HAND"),
    );
    expect(entry.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ledger.entries).toHaveLength(1);
  });

  it("fails with LEDGER_NOT_PROVISIONED when a required role is missing and writes nothing", async () => {
    const { provision, posting, roles, ledger, tenancy } = await setup();
    await provision.execute(roles.OWNER);
    ledger.removeRole(roles.OWNER.businessId, "SALES_REVENUE");
    const plan = createPostingPlan(roles.OWNER.currency, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(roles.OWNER, 500n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: money(roles.OWNER, 500n) },
    ]);
    await expect(
      tenancy.unitOfWork.run((scope) =>
        posting.post(scope, roles.OWNER, {
          plan,
          source: saleSource(tenancy.ids),
          postingRule: "SALE_POSTED",
          postingRuleVersion: 1,
          description: "Sale S-000002",
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerNotProvisionedError);
    expect(ledger.entries).toHaveLength(0);
  });

  it("rejects a currency mismatch with no write", async () => {
    const { provision, posting, roles, ledger, tenancy } = await setup("KES");
    await provision.execute(roles.OWNER);
    const usd = parseCurrencyCode("USD");
    const plan = createPostingPlan(usd, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: Money.ofMinor(100n, usd) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: Money.ofMinor(100n, usd) },
    ]);
    await expect(
      tenancy.unitOfWork.run((scope) =>
        posting.post(scope, roles.OWNER, {
          plan,
          source: saleSource(tenancy.ids),
          postingRule: "SALE_POSTED",
          postingRuleVersion: 1,
          description: "Sale S-000003",
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(ledger.entries).toHaveLength(0);
  });

  it("cannot resolve another business's accounts (cross-tenant isolation)", async () => {
    const { provision, posting, roles, catalog, ledger, tenancy } = await setup("KES");
    await provision.execute(roles.OWNER);
    const other = await catalog.businessWithRoles("Foreign", "KES");
    const plan = createPostingPlan(other.OWNER.currency, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(other.OWNER, 100n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: money(other.OWNER, 100n) },
    ]);
    await expect(
      tenancy.unitOfWork.run((scope) =>
        posting.post(scope, other.OWNER, {
          plan,
          source: saleSource(tenancy.ids),
          postingRule: "SALE_POSTED",
          postingRuleVersion: 1,
          description: "Sale S-000004",
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerNotProvisionedError);
    expect(ledger.entries.filter((e) => e.businessId === other.OWNER.businessId)).toHaveLength(0);
    expect(ledger.accountsFor(roles.OWNER.businessId)).toHaveLength(13);
  });

  it("rolls back a journal insert failure without leaving a partial entry", async () => {
    const { provision, posting, roles, ledger, tenancy } = await setup();
    await provision.execute(roles.OWNER);
    ledger.failures.failNext("ledger.journals.insert");
    const plan = createPostingPlan(roles.OWNER.currency, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(roles.OWNER, 50n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: money(roles.OWNER, 50n) },
    ]);
    await expect(
      tenancy.unitOfWork.run((scope) =>
        posting.post(scope, roles.OWNER, {
          plan,
          source: saleSource(tenancy.ids),
          postingRule: "SALE_POSTED",
          postingRuleVersion: 1,
          description: "Sale S-000005",
        }),
      ),
    ).rejects.toThrow();
    expect(ledger.entries).toHaveLength(0);
  });

  it("posts a multi-line sale-shaped plan and derives balances", async () => {
    const { provision, posting, reads, roles, tenancy } = await setup();
    await provision.execute(roles.OWNER);
    const plan = createPostingPlan(roles.OWNER.currency, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(roles.OWNER, 600n) },
      { role: "BANK_TRANSFER_PENDING", direction: "DEBIT", amount: money(roles.OWNER, 400n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: money(roles.OWNER, 1000n) },
      { role: "COST_OF_GOODS_SOLD", direction: "DEBIT", amount: money(roles.OWNER, 700n) },
      { role: "INVENTORY", direction: "CREDIT", amount: money(roles.OWNER, 700n) },
    ]);
    const { entry } = await tenancy.unitOfWork.run((scope) =>
      posting.post(scope, roles.OWNER, {
        plan,
        source: saleSource(tenancy.ids),
        postingRule: "SALE_POSTED",
        postingRuleVersion: 1,
        description: "Sale S-000006",
      }),
    );
    const balances = await reads.listBalances.execute(roles.OWNER);
    const cash = balances.find((b) => b.systemRole === "CASH_ON_HAND");
    const revenue = balances.find((b) => b.systemRole === "SALES_REVENUE");
    expect(cash?.balance.amountMinor).toBe(600n);
    expect(revenue?.balance.amountMinor).toBe(1000n);
    const loaded = await reads.getEntry.execute(roles.OWNER, { entryId: entry.id });
    expect(loaded.entry.id).toBe(entry.id);
  });
});

describe("LedgerPostingService reversal source identity (ADR-009 section 13)", () => {
  async function postOriginal() {
    const harness = await setup();
    const { provision, posting, roles, tenancy } = harness;
    await provision.execute(roles.OWNER);
    const plan = createPostingPlan(roles.OWNER.currency, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(roles.OWNER, 1000n), memoKind: "TENDER_CASH" },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: money(roles.OWNER, 1000n), memoKind: "REVENUE" },
      { role: "COST_OF_GOODS_SOLD", direction: "DEBIT", amount: money(roles.OWNER, 700n), memoKind: "COGS" },
      { role: "INVENTORY", direction: "CREDIT", amount: money(roles.OWNER, 700n), memoKind: "INVENTORY" },
    ]);
    const source = saleSource(tenancy.ids);
    const { entry: original } = await tenancy.unitOfWork.run((scope) =>
      posting.post(scope, roles.OWNER, {
        plan,
        source,
        postingRule: "SALE_POSTED",
        postingRuleVersion: 1,
        description: "Sale S-000100",
      }),
    );
    return { ...harness, plan, source, original };
  }

  function reverse(
    harness: Awaited<ReturnType<typeof postOriginal>>,
    source: { readonly kind: "sale" | "stocktake"; readonly id: string },
  ) {
    const { posting, roles, tenancy, plan, original } = harness;
    return tenancy.unitOfWork.run((scope) =>
      posting.post(scope, roles.OWNER, {
        plan: reversePostingPlan(plan),
        source,
        postingRuleVersion: 1,
        postingRule: "SALE_REVERSED",
        description: "Sale S-000100 reversal",
        entryKind: "REVERSAL",
        reversesEntryId: original.id,
      }),
    );
  }

  it("posts a reversal with the same source, mirroring directions and keeping roles and amounts", async () => {
    const harness = await postOriginal();
    const { original, source, ledger } = harness;
    expect(original.entryKind).toBe("ORIGINAL");

    const { entry: reversal } = await reverse(harness, source);
    expect(reversal.entryKind).toBe("REVERSAL");
    expect(reversal.reversesEntryId).toBe(original.id);
    expect(reversal.source.kind).toBe(original.source.kind);
    expect(reversal.source.id).toBe(original.source.id);
    expect(reversal.lines.map((line) => line.systemRole)).toEqual(original.lines.map((line) => line.systemRole));
    expect(reversal.lines.map((line) => line.accountId)).toEqual(original.lines.map((line) => line.accountId));
    expect(reversal.lines.map((line) => line.amount.amountMinor)).toEqual(
      original.lines.map((line) => line.amount.amountMinor),
    );
    expect(reversal.lines.map((line) => line.direction)).toEqual(
      original.lines.map((line) => (line.direction === "DEBIT" ? "CREDIT" : "DEBIT")),
    );
    expect(ledger.entries).toHaveLength(2);
  });

  it.each([
    [
      "a different source id",
      (source: { kind: "sale"; id: string }, newId: string) => ({ kind: source.kind, id: newId }),
    ],
    [
      "a different source kind",
      (source: { kind: "sale"; id: string }) => ({ kind: "stocktake" as const, id: source.id }),
    ],
  ])("rejects a reversal with %s and writes nothing", async (_label, mismatch) => {
    const harness = await postOriginal();
    const { original, source, ledger, tenancy } = harness;
    const snapshot = { ...original, lines: [...original.lines] };

    await expect(reverse(harness, mismatch(source, tenancy.ids.newId("Sale")))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "reversal source must match the original journal source",
    });

    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries.filter((entry) => entry.entryKind === "REVERSAL")).toHaveLength(0);
    const stored = ledger.entries[0];
    expect(stored).toEqual(snapshot);
    expect(stored?.source).toEqual(source);
  });
});

describe("ledger:read permissions", () => {
  it.each([
    ["OWNER", true],
    ["ACCOUNTANT", true],
    ["MANAGER", false],
    ["CASHIER", false],
    ["STOCK_KEEPER", false],
  ] as const)("%s ledger read allowed=%s", async (role: MembershipRole, allowed) => {
    const { provision, reads, roles } = await setup();
    await provision.execute(roles.OWNER);
    if (allowed) {
      const accounts = await reads.listAccounts.execute(roles[role]);
      expect(accounts).toHaveLength(13);
    } else {
      await expect(reads.listAccounts.execute(roles[role])).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(reads.listBalances.execute(roles[role])).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });
});

describe("ledger posting property-style plans through the application service", () => {
  it("accepts many balanced plans after provisioning", async () => {
    const { provision, posting, roles, tenancy, ledger } = await setup("USD");
    await provision.execute(roles.OWNER);
    let seed = 7n;
    const next = (): bigint => {
      seed = (seed * 1103515245n + 12345n) % 2147483648n;
      return (seed % 5_000n) + 1n;
    };
    for (let i = 0; i < 40; i += 1) {
      const a = next();
      const plan = createPostingPlan(roles.OWNER.currency, [
        { role: "CASH_ON_HAND", direction: "DEBIT", amount: money(roles.OWNER, a) },
        { role: "SALES_REVENUE", direction: "CREDIT", amount: money(roles.OWNER, a) },
      ]);
      const reversed = reversePostingPlan(plan);
      expect(plan.debitTotal().equals(plan.creditTotal())).toBe(true);
      expect(reversed.debitTotal().equals(reversed.creditTotal())).toBe(true);
      await tenancy.unitOfWork.run((scope) =>
        posting.post(scope, roles.OWNER, {
          plan,
          source: saleSource(tenancy.ids),
          postingRule: "SALE_POSTED",
          postingRuleVersion: 1,
          description: `Sale S-${String(i).padStart(6, "0")}`,
        }),
      );
    }
    expect(ledger.entries).toHaveLength(40);
  });
});
