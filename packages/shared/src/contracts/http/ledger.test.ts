import { describe, expect, it } from "vitest";
import {
  AccountBalancesResponseSchema,
  AccountTypeWireSchema,
  JournalEntryResponseSchema,
  JournalSourceKindWireSchema,
  LedgerAccountsResponseSchema,
  LedgerEntryPathSchema,
  PostingMemoKindWireSchema,
  SystemAccountRoleWireSchema,
} from "./ledger.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const ID2 = "0190a000-0000-7000-8000-000000000002";
const AT = "2026-11-02T08:00:00.000Z";
const DAY = "2026-11-02";
const ngn = (amountMinor: string) => ({ amountMinor, currency: "NGN" });

type Schema = { safeParse(value: unknown): { success: boolean } };
const ok = (schema: Schema, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(true);
};
const bad = (schema: Schema, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(false);
};

const account = {
  accountId: ID,
  code: "1000",
  name: "Cash on hand",
  type: "ASSET",
  normalBalance: "DEBIT",
  systemRole: "CASH_ON_HAND",
  templateVersion: 1,
  status: "ACTIVE",
};
const balance = {
  accountId: ID,
  systemRole: "CASH_ON_HAND",
  code: "1000",
  name: "Cash on hand",
  debitTotal: ngn("100000"),
  creditTotal: ngn("0"),
  balance: ngn("100000"),
};
const entry = {
  entryId: ID,
  currency: "NGN",
  occurredAt: AT,
  businessDate: DAY,
  recordedAt: AT,
  entryKind: "ORIGINAL",
  source: { kind: "sale", id: ID2 },
  reversesEntryId: null,
  postingRule: "SALE_POSTED",
  postingRuleVersion: 1,
  description: "Sale S-000001",
  locationId: ID2,
  lines: [
    {
      lineNumber: 1,
      accountId: ID,
      systemRole: "CASH_ON_HAND",
      direction: "DEBIT",
      amount: ngn("100000"),
      memoKind: "TENDER_CASH",
    },
    {
      lineNumber: 2,
      accountId: ID2,
      systemRole: "SALES_REVENUE",
      direction: "CREDIT",
      amount: ngn("100000"),
      memoKind: "REVENUE",
    },
  ],
};

describe("ledger accounts", () => {
  it("accepts the chart and rejects tenancy or unknown values", () => {
    ok(LedgerAccountsResponseSchema, { items: [account] });
    ok(LedgerAccountsResponseSchema, { items: [] });
    for (const key of ["businessId", "createdAt", "balance"]) {
      bad(LedgerAccountsResponseSchema, { items: [{ ...account, [key]: ID }] });
    }
    bad(LedgerAccountsResponseSchema, { items: [{ ...account, status: "ARCHIVED" }] });
    bad(LedgerAccountsResponseSchema, { items: [{ ...account, type: "INCOME" }] });
    bad(LedgerAccountsResponseSchema, { items: [{ ...account, systemRole: "PETTY_CASH" }] });
    bad(LedgerAccountsResponseSchema, { items: [account], nextCursor: null });
  });

  it("duplicates the domain enums exactly", () => {
    expect(AccountTypeWireSchema.options).toEqual([
      "ASSET",
      "LIABILITY",
      "EQUITY",
      "REVENUE",
      "CONTRA_REVENUE",
      "EXPENSE",
    ]);
    expect(SystemAccountRoleWireSchema.options).toHaveLength(13);
    expect(PostingMemoKindWireSchema.options).toHaveLength(14);
    expect(JournalSourceKindWireSchema.options).toEqual([
      "sale",
      "opening_batch",
      "goods_receipt",
      "adjustment",
      "stocktake",
      "valuation",
    ]);
  });
});

describe("ledger balances", () => {
  it("carries signed string money in one currency", () => {
    ok(AccountBalancesResponseSchema, { items: [balance] });
    ok(AccountBalancesResponseSchema, {
      items: [{ ...balance, debitTotal: ngn("0"), creditTotal: ngn("5"), balance: ngn("-5") }],
    });
    bad(AccountBalancesResponseSchema, { items: [{ ...balance, balance: { amountMinor: 100000, currency: "NGN" } }] });
    bad(AccountBalancesResponseSchema, { items: [{ ...balance, creditTotal: { amountMinor: "0", currency: "KES" } }] });
    bad(AccountBalancesResponseSchema, { items: [{ ...balance, businessId: ID }] });
  });
});

describe("journal entries", () => {
  it("accepts an original and a reversal entry", () => {
    ok(JournalEntryResponseSchema, entry);
    ok(JournalEntryResponseSchema, {
      ...entry,
      entryKind: "REVERSAL",
      reversesEntryId: ID2,
      postingRule: "SALE_REVERSED",
      locationId: null,
      lines: entry.lines.map((line) => ({ ...line, memoKind: null })),
    });
  });

  it("rejects actor, device, channel, correlation and business fields", () => {
    for (const key of ["actorMembershipId", "deviceId", "sourceChannel", "correlationId", "businessId"]) {
      bad(JournalEntryResponseSchema, { ...entry, [key]: ID });
    }
    bad(JournalEntryResponseSchema, { ...entry, lines: [{ ...entry.lines[0], businessId: ID }, entry.lines[1]] });
  });

  it("checks the source kind, the reversal link, the currency and string amounts", () => {
    bad(JournalEntryResponseSchema, { ...entry, source: { kind: "SALE", id: ID2 } });
    bad(JournalEntryResponseSchema, { ...entry, reversesEntryId: ID2 });
    bad(JournalEntryResponseSchema, { ...entry, entryKind: "REVERSAL" });
    bad(JournalEntryResponseSchema, { ...entry, lines: [entry.lines[0]] });
    bad(JournalEntryResponseSchema, {
      ...entry,
      lines: [entry.lines[0], { ...entry.lines[1], amount: { amountMinor: "100000", currency: "KES" } }],
    });
    bad(JournalEntryResponseSchema, {
      ...entry,
      lines: [entry.lines[0], { ...entry.lines[1], amount: { amountMinor: 100000, currency: "NGN" } }],
    });
    bad(JournalEntryResponseSchema, { ...entry, lines: [entry.lines[0], { ...entry.lines[1], memoKind: "REFUND" }] });
  });

  it("takes the entry ID as a path claim", () => {
    ok(LedgerEntryPathSchema, { businessId: "b", entryId: "e" });
    bad(LedgerEntryPathSchema, { businessId: "b" });
  });
});
