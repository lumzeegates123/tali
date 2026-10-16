import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";
import type { JournalDirection } from "./account-type.js";
import { oppositeDirection } from "./account-type.js";
import type { SystemAccountRole } from "./roles.js";

/**
 * Optional bounded line memo (ADR-009 section 8). Kept closed so free text never
 * enters journal lines; source detail lives on the business document.
 */
export const POSTING_MEMO_KINDS = [
  "TENDER_CASH",
  "TENDER_BANK_TRANSFER",
  "TENDER_POS_CARD",
  "TENDER_OTHER",
  "REVENUE",
  "DISCOUNT",
  "TAX",
  "COGS",
  "INVENTORY",
  "INVENTORY_GAIN",
  "INVENTORY_SHRINKAGE",
  "OPENING_VALUATION",
  "OPERATIONAL_VALUATION",
  "GOODS_RECEIPT",
] as const;

export type PostingMemoKind = (typeof POSTING_MEMO_KINDS)[number];

export function parsePostingMemoKind(value: string): PostingMemoKind {
  if (!(POSTING_MEMO_KINDS as readonly string[]).includes(value)) {
    throw new DomainError("INVALID_VALUE", "unknown posting memo kind", "memoKind");
  }
  return value as PostingMemoKind;
}

/** One planned journal line before role resolution and persistence. */
export interface PostingPlanLine {
  readonly role: SystemAccountRole;
  readonly direction: JournalDirection;
  readonly amount: Money;
  readonly memoKind?: PostingMemoKind;
}

export interface PostingPlanLineInput {
  readonly role: SystemAccountRole;
  readonly direction: JournalDirection;
  readonly amount: Money;
  readonly memoKind?: PostingMemoKind;
}

/**
 * A balanced set of planned journal lines in one currency (ADR-009 section 10).
 * Immutable. Zero-amount inputs are omitted; at least two effective lines and
 * equal debit and credit totals are required.
 */
export class PostingPlan {
  readonly currency: CurrencyCode;
  readonly lines: readonly PostingPlanLine[];

  private constructor(currency: CurrencyCode, lines: readonly PostingPlanLine[]) {
    this.currency = currency;
    this.lines = lines;
    Object.freeze(this);
    Object.freeze(this.lines);
  }

  /** Sum of debit amounts (always positive Money in the plan currency). */
  debitTotal(): Money {
    return Money.sum(
      this.currency,
      this.lines.filter((line) => line.direction === "DEBIT").map((line) => line.amount),
    );
  }

  /** Sum of credit amounts (always positive Money in the plan currency). */
  creditTotal(): Money {
    return Money.sum(
      this.currency,
      this.lines.filter((line) => line.direction === "CREDIT").map((line) => line.amount),
    );
  }

  /**
   * Builds a plan from rule output. Zero-amount lines are omitted. Lines that
   * share role, direction and memo kind are aggregated (ADR-009 section 8).
   */
  static create(currency: CurrencyCode, lines: readonly PostingPlanLineInput[]): PostingPlan {
    const aggregated = new Map<string, PostingPlanLine>();

    for (const input of lines) {
      const { role, direction, amount, memoKind } = input;

      if (amount.currency !== currency) {
        throw new DomainError("INVALID_VALUE", "posting plan lines must use the plan currency", "currency");
      }
      if (amount.isZero()) {
        continue;
      }
      if (!amount.isPositive()) {
        throw new DomainError("INVALID_VALUE", "posting amounts must be strictly positive", "amount");
      }

      const key = `${role}\0${direction}\0${memoKind ?? ""}`;
      const existing = aggregated.get(key);
      if (existing === undefined) {
        aggregated.set(
          key,
          Object.freeze({
            role,
            direction,
            amount,
            ...(memoKind === undefined ? {} : { memoKind }),
          }),
        );
      } else {
        aggregated.set(
          key,
          Object.freeze({
            role,
            direction,
            amount: existing.amount.add(amount),
            ...(memoKind === undefined ? {} : { memoKind }),
          }),
        );
      }
    }

    return PostingPlan.fromBalancedLines(currency, Object.freeze([...aggregated.values()]));
  }

  /** Used by reversal mirroring so line order is preserved exactly. */
  static fromBalancedLines(currency: CurrencyCode, lines: readonly PostingPlanLine[]): PostingPlan {
    if (lines.length < 2) {
      throw new DomainError("INVALID_VALUE", "a posting plan needs at least two effective lines", "lines");
    }
    for (const line of lines) {
      if (line.amount.currency !== currency) {
        throw new DomainError("INVALID_VALUE", "posting plan lines must use the plan currency", "currency");
      }
      if (!line.amount.isPositive()) {
        throw new DomainError("INVALID_VALUE", "posting amounts must be strictly positive", "amount");
      }
    }
    const debits = Money.sum(
      currency,
      lines.filter((line) => line.direction === "DEBIT").map((line) => line.amount),
    );
    const credits = Money.sum(
      currency,
      lines.filter((line) => line.direction === "CREDIT").map((line) => line.amount),
    );
    if (!debits.equals(credits)) {
      throw new DomainError("INVALID_VALUE", "posting plan debits must equal credits", "lines");
    }
    if (debits.isZero()) {
      throw new DomainError("INVALID_VALUE", "a posting plan must move a non-zero amount", "lines");
    }
    return new PostingPlan(currency, Object.freeze(lines.map((line) => Object.freeze({ ...line }))));
  }
}

/**
 * Mirrors every line's direction; amounts, roles, memo kinds and order are
 * preserved. The original plan is not mutated. The result is itself a valid
 * balanced plan (ADR-009 section 12).
 */
export function reversePostingPlan(plan: PostingPlan): PostingPlan {
  const reversed = plan.lines.map((line) =>
    Object.freeze({
      role: line.role,
      direction: oppositeDirection(line.direction),
      amount: line.amount,
      ...(line.memoKind === undefined ? {} : { memoKind: line.memoKind }),
    }),
  );
  return PostingPlan.fromBalancedLines(plan.currency, Object.freeze(reversed));
}

export function createPostingPlan(currency: CurrencyCode, lines: readonly PostingPlanLineInput[]): PostingPlan {
  return PostingPlan.create(currency, lines);
}
