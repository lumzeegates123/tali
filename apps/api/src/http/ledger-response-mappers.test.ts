import {
  type AccountBalanceView,
  JOURNAL_SOURCE_KINDS,
  type JournalEntry,
  type LedgerAccountView,
} from "@tali/application";
import {
  ACCOUNT_TYPES,
  JOURNAL_DIRECTIONS,
  Money,
  NORMAL_BALANCES,
  parseCurrencyCode,
  POSTING_MEMO_KINDS,
  SYSTEM_ACCOUNT_ROLES,
} from "@tali/domain";
import {
  AccountTypeWireSchema,
  JournalDirectionWireSchema,
  JournalSourceKindWireSchema,
  LedgerAccountStatusWireSchema,
  NormalBalanceWireSchema,
  PostingMemoKindWireSchema,
  SystemAccountRoleWireSchema,
} from "@tali/shared";
import { describe, expect, it } from "vitest";
import {
  toAccountBalancesResponse,
  toJournalEntryResponse,
  toLedgerAccountsResponse,
} from "./ledger-response-mappers.js";

const NGN = parseCurrencyCode("NGN");
const ngn = (minor: bigint) => Money.ofMinor(minor, NGN);
const ACCOUNT = "019a0000-0000-7000-8000-0000000000b1";
const REVENUE = "019a0000-0000-7000-8000-0000000000b2";
const ENTRY = "019a0000-0000-7000-8000-0000000000b3";
const SALE = "019a0000-0000-7000-8000-0000000000b4";
const BUSINESS = "019a0000-0000-7000-8000-0000000000b5";
const MEMBER = "019a0000-0000-7000-8000-0000000000b6";
const DEVICE = "019a0000-0000-7000-8000-0000000000b7";
const LOCATION = "019a0000-0000-7000-8000-0000000000b8";
const AT = new Date("2026-11-02T08:00:00.000Z");

const ENTRY_RECORD = {
  id: ENTRY,
  businessId: BUSINESS,
  currency: NGN,
  occurredAt: AT,
  businessDate: "2026-11-02",
  recordedAt: AT,
  entryKind: "ORIGINAL",
  source: { kind: "sale", id: SALE },
  postingRule: "SALE_POSTED",
  postingRuleVersion: 1,
  description: "Sale S-000001",
  actorMembershipId: MEMBER,
  deviceId: DEVICE,
  locationId: LOCATION,
  sourceChannel: "api",
  correlationId: "corr-secret",
  lines: [
    {
      lineNumber: 1,
      accountId: ACCOUNT,
      systemRole: "CASH_ON_HAND",
      direction: "DEBIT",
      amount: ngn(100_000n),
      memoKind: "TENDER_CASH",
    },
    { lineNumber: 2, accountId: REVENUE, systemRole: "SALES_REVENUE", direction: "CREDIT", amount: ngn(100_000n) },
  ],
} as unknown as JournalEntry;

describe("ledger response mappers", () => {
  it("maps accounts without tenancy fields", () => {
    const account = {
      id: ACCOUNT,
      code: "1000",
      name: "Cash on hand",
      type: "ASSET",
      normalBalance: "DEBIT",
      systemRole: "CASH_ON_HAND",
      templateVersion: 1,
      status: "ACTIVE",
      businessId: BUSINESS,
    } as unknown as LedgerAccountView;
    expect(toLedgerAccountsResponse([account])).toEqual({
      items: [
        {
          accountId: ACCOUNT,
          code: "1000",
          name: "Cash on hand",
          type: "ASSET",
          normalBalance: "DEBIT",
          systemRole: "CASH_ON_HAND",
          templateVersion: 1,
          status: "ACTIVE",
        },
      ],
    });
  });

  it("maps balances as string MoneyWire, including a negative balance", () => {
    const row = {
      accountId: ACCOUNT,
      systemRole: "CASH_ON_HAND",
      code: "1000",
      name: "Cash on hand",
      currency: NGN,
      debitTotal: ngn(0n),
      creditTotal: ngn(500n),
      balance: ngn(-500n),
    } as unknown as AccountBalanceView;
    expect(toAccountBalancesResponse([row]).items[0]).toEqual({
      accountId: ACCOUNT,
      systemRole: "CASH_ON_HAND",
      code: "1000",
      name: "Cash on hand",
      debitTotal: { amountMinor: "0", currency: "NGN" },
      creditTotal: { amountMinor: "500", currency: "NGN" },
      balance: { amountMinor: "-500", currency: "NGN" },
    });
  });

  it("maps a journal entry without actor, device, channel, correlation or business", () => {
    const body = toJournalEntryResponse(ENTRY_RECORD);
    expect(body).toEqual({
      entryId: ENTRY,
      currency: "NGN",
      occurredAt: AT.toISOString(),
      businessDate: "2026-11-02",
      recordedAt: AT.toISOString(),
      entryKind: "ORIGINAL",
      source: { kind: "sale", id: SALE },
      reversesEntryId: null,
      postingRule: "SALE_POSTED",
      postingRuleVersion: 1,
      description: "Sale S-000001",
      locationId: LOCATION,
      lines: [
        {
          lineNumber: 1,
          accountId: ACCOUNT,
          systemRole: "CASH_ON_HAND",
          direction: "DEBIT",
          amount: { amountMinor: "100000", currency: "NGN" },
          memoKind: "TENDER_CASH",
        },
        {
          lineNumber: 2,
          accountId: REVENUE,
          systemRole: "SALES_REVENUE",
          direction: "CREDIT",
          amount: { amountMinor: "100000", currency: "NGN" },
          memoKind: null,
        },
      ],
    });
    const text = JSON.stringify(body);
    for (const secret of [BUSINESS, MEMBER, DEVICE, "corr-secret", "sourceChannel", "actorMembershipId"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("maps a reversal entry and an entry without a location", () => {
    const reversal = {
      ...ENTRY_RECORD,
      entryKind: "REVERSAL",
      reversesEntryId: SALE,
      locationId: undefined,
    } as unknown as JournalEntry;
    expect(toJournalEntryResponse(reversal)).toMatchObject({
      entryKind: "REVERSAL",
      reversesEntryId: SALE,
      locationId: null,
    });
  });

  it("duplicates the domain ledger enums exactly", () => {
    expect(AccountTypeWireSchema.options).toEqual([...ACCOUNT_TYPES]);
    expect(NormalBalanceWireSchema.options).toEqual([...NORMAL_BALANCES]);
    expect(JournalDirectionWireSchema.options).toEqual([...JOURNAL_DIRECTIONS]);
    expect(SystemAccountRoleWireSchema.options).toEqual([...SYSTEM_ACCOUNT_ROLES]);
    expect(PostingMemoKindWireSchema.options).toEqual([...POSTING_MEMO_KINDS]);
    expect(JournalSourceKindWireSchema.options).toEqual([...JOURNAL_SOURCE_KINDS]);
    expect(LedgerAccountStatusWireSchema.options).toEqual(["ACTIVE"]);
  });
});
