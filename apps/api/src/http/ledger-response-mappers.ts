import type { AccountBalanceView, JournalEntry, LedgerAccountView } from "@tali/application";
import {
  type AccountBalancesResponse,
  AccountBalancesResponseSchema,
  type JournalEntryResponse,
  JournalEntryResponseSchema,
  type LedgerAccountsResponse,
  LedgerAccountsResponseSchema,
  type MoneyWire,
} from "@tali/shared";

/**
 * Ledger read results to wire DTOs (ADR-009, ADR-011, plan 005 Slice 6). Each
 * mapper builds a fresh object from the fields it names and parses it with the
 * strict shared schema. The business ID, acting membership, device, source
 * channel and correlation ID of a journal entry never reach the wire.
 */
type Money = AccountBalanceView["balance"];

function money(value: Money): MoneyWire {
  return { amountMinor: value.toMinorUnitsString(), currency: value.currency };
}

export function toLedgerAccountsResponse(accounts: readonly LedgerAccountView[]): LedgerAccountsResponse {
  return LedgerAccountsResponseSchema.parse({
    items: accounts.map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
      systemRole: account.systemRole,
      templateVersion: account.templateVersion,
      status: account.status,
    })),
  });
}

export function toAccountBalancesResponse(rows: readonly AccountBalanceView[]): AccountBalancesResponse {
  return AccountBalancesResponseSchema.parse({
    items: rows.map((row) => ({
      accountId: row.accountId,
      systemRole: row.systemRole,
      code: row.code,
      name: row.name,
      debitTotal: money(row.debitTotal),
      creditTotal: money(row.creditTotal),
      balance: money(row.balance),
    })),
  });
}

export function toJournalEntryResponse(entry: JournalEntry): JournalEntryResponse {
  return JournalEntryResponseSchema.parse({
    entryId: entry.id,
    currency: entry.currency,
    occurredAt: entry.occurredAt.toISOString(),
    businessDate: entry.businessDate,
    recordedAt: entry.recordedAt.toISOString(),
    entryKind: entry.entryKind,
    source: { kind: entry.source.kind, id: entry.source.id },
    reversesEntryId: entry.reversesEntryId ?? null,
    postingRule: entry.postingRule,
    postingRuleVersion: entry.postingRuleVersion,
    description: entry.description,
    locationId: entry.locationId ?? null,
    lines: entry.lines.map((line) => ({
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      systemRole: line.systemRole,
      direction: line.direction,
      amount: money(line.amount),
      memoKind: line.memoKind ?? null,
    })),
  });
}
