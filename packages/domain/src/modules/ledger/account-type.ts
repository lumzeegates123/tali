import { DomainError } from "../../errors.js";

/** Chart-of-accounts account types (ADR-009 section 4). */
export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "CONTRA_REVENUE", "EXPENSE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Normal balance side stored for clarity; derived from account type (ADR-009 section 4). */
export const NORMAL_BALANCES = ["DEBIT", "CREDIT"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** Journal line direction: explicit direction plus a strictly positive amount (ADR-009 section 9). */
export const JOURNAL_DIRECTIONS = ["DEBIT", "CREDIT"] as const;
export type JournalDirection = (typeof JOURNAL_DIRECTIONS)[number];

const NORMAL_BALANCE_BY_TYPE: Readonly<Record<AccountType, NormalBalance>> = Object.freeze({
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  CONTRA_REVENUE: "DEBIT",
  EXPENSE: "DEBIT",
});

/** Deterministic type → normal-balance mapping. Arbitrary combinations are not allowed. */
export function normalBalanceFor(type: AccountType): NormalBalance {
  return NORMAL_BALANCE_BY_TYPE[type];
}

export function parseAccountType(value: string): AccountType {
  if (!(ACCOUNT_TYPES as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown account type", "type");
  }
  return value as AccountType;
}

export function parseJournalDirection(value: string): JournalDirection {
  if (!(JOURNAL_DIRECTIONS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown journal direction", "direction");
  }
  return value as JournalDirection;
}

/** Opposite direction for a reversal line (ADR-009 section 12). */
export function oppositeDirection(direction: JournalDirection): JournalDirection {
  return direction === "DEBIT" ? "CREDIT" : "DEBIT";
}
