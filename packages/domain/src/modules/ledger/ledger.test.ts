import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { parseCurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";
import {
  ACCOUNT_TYPES,
  CHART_TEMPLATE_V1,
  POSTING_MEMO_KINDS,
  SYSTEM_ACCOUNT_ROLES,
  accountTypeForRole,
  assertValidChartTemplate,
  createPostingPlan,
  normalBalanceFor,
  oppositeDirection,
  reversePostingPlan,
} from "./index.js";

const KES = parseCurrencyCode("KES");
const NGN = parseCurrencyCode("NGN");
const USD = parseCurrencyCode("USD");
const GHS = parseCurrencyCode("GHS");

describe("chart template v1 (ADR-009 sections 5 and 6)", () => {
  it("is version 1 with exactly the thirteen accepted roles", () => {
    expect(CHART_TEMPLATE_V1.version).toBe(1);
    expect(CHART_TEMPLATE_V1.accounts).toHaveLength(13);
    expect(CHART_TEMPLATE_V1.accounts.map((a) => a.systemRole).sort()).toEqual([...SYSTEM_ACCOUNT_ROLES].sort());
  });

  it("has unique codes and unique roles", () => {
    const codes = CHART_TEMPLATE_V1.accounts.map((a) => a.code);
    const roles = CHART_TEMPLATE_V1.accounts.map((a) => a.systemRole);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("embeds no currency and no tenant id", () => {
    expect(JSON.stringify(CHART_TEMPLATE_V1)).not.toMatch(/NGN|USD|business|currency/i);
    expect("currency" in CHART_TEMPLATE_V1).toBe(false);
  });

  it("keeps the accountant-approved codes and names", () => {
    expect(CHART_TEMPLATE_V1.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "1000", name: "Cash on hand", systemRole: "CASH_ON_HAND" }),
        expect.objectContaining({
          code: "1010",
          name: "Bank transfers pending verification",
          systemRole: "BANK_TRANSFER_PENDING",
        }),
        expect.objectContaining({ code: "1020", name: "POS/card clearing", systemRole: "POS_CARD_CLEARING" }),
        expect.objectContaining({ code: "1030", name: "Other tender clearing", systemRole: "OTHER_TENDER_CLEARING" }),
        expect.objectContaining({ code: "1200", name: "Inventory", systemRole: "INVENTORY" }),
        expect.objectContaining({ code: "2100", name: "Tax payable", systemRole: "TAX_PAYABLE" }),
        expect.objectContaining({
          code: "2200",
          name: "Goods received not invoiced",
          systemRole: "GOODS_RECEIVED_NOT_INVOICED",
        }),
        expect.objectContaining({
          code: "3000",
          name: "Opening balance equity",
          systemRole: "OPENING_BALANCE_EQUITY",
        }),
        expect.objectContaining({ code: "4000", name: "Sales revenue", systemRole: "SALES_REVENUE" }),
        expect.objectContaining({ code: "4010", name: "Sales discounts", systemRole: "SALES_DISCOUNTS" }),
        expect.objectContaining({ code: "4100", name: "Inventory gains", systemRole: "INVENTORY_GAIN" }),
        expect.objectContaining({ code: "5000", name: "Cost of goods sold", systemRole: "COST_OF_GOODS_SOLD" }),
        expect.objectContaining({ code: "5100", name: "Inventory shrinkage", systemRole: "INVENTORY_SHRINKAGE" }),
      ]),
    );
  });

  it("maps every role to the accepted account type", () => {
    for (const account of CHART_TEMPLATE_V1.accounts) {
      expect(account.type).toBe(accountTypeForRole(account.systemRole));
    }
  });

  it("accepts the validated v1 template through assertValidChartTemplate", () => {
    const again = assertValidChartTemplate({
      version: 1,
      accounts: CHART_TEMPLATE_V1.accounts.map((account) => ({ ...account })),
    });
    expect(again.version).toBe(1);
    expect(again.accounts).toHaveLength(13);
  });

  it("rejects a template missing one role", () => {
    expect(() =>
      assertValidChartTemplate({
        version: 1,
        accounts: CHART_TEMPLATE_V1.accounts.slice(0, 12).map((account) => ({ ...account })),
      }),
    ).toThrow(DomainError);
  });

  it("rejects a template with a duplicate role", () => {
    const accounts = CHART_TEMPLATE_V1.accounts.map((account) => ({ ...account }));
    const first = accounts[0];
    const last = accounts[accounts.length - 1];
    if (first === undefined || last === undefined) throw new Error("expected chart rows");
    accounts[accounts.length - 1] = { ...last, systemRole: first.systemRole, type: first.type };
    expect(() => assertValidChartTemplate({ version: 1, accounts })).toThrow(DomainError);
  });

  it("rejects an unexpected role", () => {
    const accounts: { code: string; name: string; type: string; systemRole: string }[] = CHART_TEMPLATE_V1.accounts.map(
      (account) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        systemRole: account.systemRole,
      }),
    );
    const last = accounts[accounts.length - 1];
    if (last === undefined) throw new Error("expected chart rows");
    accounts[accounts.length - 1] = { ...last, systemRole: "NOT_A_SYSTEM_ROLE" };
    expect(() => assertValidChartTemplate({ version: 1, accounts })).toThrow(DomainError);
  });

  it("rejects the wrong account type for a role", () => {
    const accounts: { code: string; name: string; type: string; systemRole: string }[] = CHART_TEMPLATE_V1.accounts.map(
      (account) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        systemRole: account.systemRole,
      }),
    );
    const revenue = accounts.find((account) => account.systemRole === "SALES_REVENUE");
    if (revenue === undefined) throw new Error("expected sales revenue row");
    revenue.type = "ASSET";
    expect(() => assertValidChartTemplate({ version: 1, accounts })).toThrow(DomainError);
  });
});

describe("account type → normal balance", () => {
  it.each([
    ["ASSET", "DEBIT"],
    ["LIABILITY", "CREDIT"],
    ["EQUITY", "CREDIT"],
    ["REVENUE", "CREDIT"],
    ["CONTRA_REVENUE", "DEBIT"],
    ["EXPENSE", "DEBIT"],
  ] as const)("%s → %s", (type, balance) => {
    expect(normalBalanceFor(type)).toBe(balance);
  });

  it("covers every account type", () => {
    expect(ACCOUNT_TYPES).toHaveLength(6);
    for (const type of ACCOUNT_TYPES) {
      expect(normalBalanceFor(type)).toMatch(/^(DEBIT|CREDIT)$/);
    }
  });
});

describe("PostingPlan", () => {
  const kes = (minor: bigint) => Money.ofMinor(minor, KES);
  const ngn = (minor: bigint) => Money.ofMinor(minor, NGN);

  it("accepts a balanced two-line plan", () => {
    const plan = createPostingPlan(KES, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(1000n), memoKind: "TENDER_CASH" },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(1000n), memoKind: "REVENUE" },
    ]);
    expect(plan.lines).toHaveLength(2);
    expect(plan.debitTotal().equals(plan.creditTotal())).toBe(true);
    expect(plan.currency).toBe("KES");
  });

  it("accepts a multi-line balanced plan", () => {
    const plan = createPostingPlan(KES, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(600n) },
      { role: "BANK_TRANSFER_PENDING", direction: "DEBIT", amount: kes(400n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(1000n) },
      { role: "COST_OF_GOODS_SOLD", direction: "DEBIT", amount: kes(700n) },
      { role: "INVENTORY", direction: "CREDIT", amount: kes(700n) },
    ]);
    expect(plan.lines).toHaveLength(5);
    expect(plan.debitTotal().amountMinor).toBe(1700n);
    expect(plan.creditTotal().amountMinor).toBe(1700n);
  });

  it("rejects an unbalanced plan", () => {
    expect(() =>
      createPostingPlan(KES, [
        { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(1000n) },
        { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(900n) },
      ]),
    ).toThrow(DomainError);
  });

  it("rejects mixed-currency lines", () => {
    expect(() =>
      createPostingPlan(KES, [
        { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(1000n) },
        { role: "SALES_REVENUE", direction: "CREDIT", amount: ngn(1000n) },
      ]),
    ).toThrow(DomainError);
  });

  it("omits zero-amount lines and accepts the remaining balanced plan", () => {
    const plan = createPostingPlan(KES, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(1000n) },
      { role: "SALES_DISCOUNTS", direction: "DEBIT", amount: kes(0n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(1000n) },
    ]);
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines.every((line) => line.amount.isPositive())).toBe(true);
  });

  it("rejects when omitting zeros leaves fewer than two effective lines", () => {
    expect(() =>
      createPostingPlan(KES, [
        { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(1000n) },
        { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(0n) },
      ]),
    ).toThrow(/at least two effective lines/);
  });

  it("rejects a negative posting amount", () => {
    expect(() =>
      createPostingPlan(KES, [
        { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(-1000n) },
        { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(1000n) },
      ]),
    ).toThrow(/strictly positive/);
  });

  it("succeeds for a non-NGN currency", () => {
    const plan = createPostingPlan(USD, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: Money.ofMinor(250n, USD) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: Money.ofMinor(250n, USD) },
    ]);
    expect(plan.currency).toBe("USD");
  });

  it("never uses floating-point money amounts", () => {
    const plan = createPostingPlan(KES, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(199n) },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(199n) },
    ]);
    expect(plan.lines.every((line) => typeof line.amount.amountMinor === "bigint")).toBe(true);
    expect(plan.debitTotal().amountMinor).toBe(199n);
  });

  it("aggregates lines that share role, direction and memo kind", () => {
    const plan = createPostingPlan(KES, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(600n), memoKind: "TENDER_CASH" },
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(400n), memoKind: "TENDER_CASH" },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(1000n), memoKind: "REVENUE" },
    ]);
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines.find((l) => l.role === "CASH_ON_HAND")?.amount.amountMinor).toBe(1000n);
  });

  it("exposes a closed memo-kind catalogue that includes ADR examples", () => {
    expect(POSTING_MEMO_KINDS).toEqual(expect.arrayContaining(["TENDER_CASH", "COGS"]));
  });
});

describe("reversePostingPlan", () => {
  const kes = (minor: bigint) => Money.ofMinor(minor, KES);

  it("swaps every direction, preserves amounts, roles, memo kinds and order, and stays balanced", () => {
    const original = createPostingPlan(KES, [
      { role: "CASH_ON_HAND", direction: "DEBIT", amount: kes(600n), memoKind: "TENDER_CASH" },
      { role: "BANK_TRANSFER_PENDING", direction: "DEBIT", amount: kes(400n), memoKind: "TENDER_BANK_TRANSFER" },
      { role: "SALES_REVENUE", direction: "CREDIT", amount: kes(1000n), memoKind: "REVENUE" },
    ]);
    const snapshot = original.lines.map((line) => ({ ...line, amountMinor: line.amount.amountMinor }));
    const reversed = reversePostingPlan(original);

    expect(reversed.lines).toHaveLength(3);
    expect(
      reversed.lines.map((line, index) => ({
        role: line.role,
        amountMinor: line.amount.amountMinor,
        memoKind: line.memoKind,
        direction: line.direction,
        originalDirection: original.lines[index]?.direction,
      })),
    ).toEqual(
      original.lines.map((line) => ({
        role: line.role,
        amountMinor: line.amount.amountMinor,
        memoKind: line.memoKind,
        direction: oppositeDirection(line.direction),
        originalDirection: line.direction,
      })),
    );
    expect(reversed.debitTotal().equals(reversed.creditTotal())).toBe(true);
    expect(original.lines.map((l) => l.direction)).toEqual(snapshot.map((l) => l.direction));
  });

  it("leaves the original plan immutable", () => {
    const original = createPostingPlan(KES, [
      { role: "INVENTORY", direction: "DEBIT", amount: kes(500n) },
      { role: "OPENING_BALANCE_EQUITY", direction: "CREDIT", amount: kes(500n) },
    ]);
    reversePostingPlan(original);
    expect(() => {
      (original as { currency: string }).currency = "USD";
    }).toThrow();
    expect(() => {
      (original.lines as PostingPlanLineMutable[]).push({
        role: "CASH_ON_HAND",
        direction: "DEBIT",
        amount: kes(1n),
      });
    }).toThrow();
  });
});

type PostingPlanLineMutable = {
  role: string;
  direction: string;
  amount: Money;
};

describe("property-style generated balanced plans", () => {
  it("accepts many seeded balanced plans and keeps reversals balanced", () => {
    let seed = 1n;
    const next = (): bigint => {
      seed = (seed * 1103515245n + 12345n) % 2147483648n;
      return (seed % 10_000n) + 1n;
    };

    for (let i = 0; i < 200; i += 1) {
      const currency = i % 3 === 0 ? KES : i % 3 === 1 ? USD : GHS;
      const amount = (minor: bigint) => Money.ofMinor(minor, currency);
      const a = next();
      const b = next();
      const c = next();
      const revenue = a + b;
      const plan = createPostingPlan(currency, [
        { role: "CASH_ON_HAND", direction: "DEBIT", amount: amount(a) },
        { role: "BANK_TRANSFER_PENDING", direction: "DEBIT", amount: amount(b) },
        { role: "SALES_REVENUE", direction: "CREDIT", amount: amount(revenue) },
        { role: "COST_OF_GOODS_SOLD", direction: "DEBIT", amount: amount(c) },
        { role: "INVENTORY", direction: "CREDIT", amount: amount(c) },
      ]);
      expect(plan.debitTotal().equals(plan.creditTotal())).toBe(true);
      const reversed = reversePostingPlan(plan);
      expect(reversed.debitTotal().equals(reversed.creditTotal())).toBe(true);
      expect(reversed.debitTotal().equals(plan.debitTotal())).toBe(true);
    }
  });
});
