import type { CurrencyCode } from "../../kernel/currency.js";
import type { Money } from "../../kernel/money.js";
import type { PostingPlan, PostingPlanLineInput, SystemAccountRole } from "../ledger/index.js";
import { createPostingPlan } from "../ledger/index.js";
import { revenueAmount, sumMoney } from "./amounts.js";
import type { SaleLine } from "./sale.js";
import type { SaleTender, TenderMethod } from "./tender.js";

export const SALE_POSTED_RULE = "SALE_POSTED";
export const SALE_POSTED_VERSION = 1;

const TENDER_ROLE: Readonly<Record<TenderMethod, SystemAccountRole>> = {
  CASH: "CASH_ON_HAND",
  BANK_TRANSFER: "BANK_TRANSFER_PENDING",
  POS_CARD: "POS_CARD_CLEARING",
  OTHER: "OTHER_TENDER_CLEARING",
};

const TENDER_MEMO = {
  CASH: "TENDER_CASH",
  BANK_TRANSFER: "TENDER_BANK_TRANSFER",
  POS_CARD: "TENDER_POS_CARD",
  OTHER: "TENDER_OTHER",
} as const;

export interface SalePostingInput {
  readonly currency: CurrencyCode;
  readonly lines: readonly SaleLine[];
  readonly tenders: readonly SaleTender[];
}

/**
 * SALE_POSTED version 1 (ADR-011 section 25). Tender amounts only: cash
 * received and change are not lines. Zero amounts are omitted by PostingPlan.
 * Roles are aggregated per method.
 */
export function salePostedPlan(input: SalePostingInput): PostingPlan {
  const lines: PostingPlanLineInput[] = [];
  for (const method of ["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"] as const) {
    const amount = sumMoney(
      input.currency,
      input.tenders.filter((tender) => tender.method === method).map((tender) => tender.amount),
    );
    if (!amount.isPositive()) continue;
    lines.push({
      role: TENDER_ROLE[method],
      direction: "DEBIT",
      amount,
      memoKind: TENDER_MEMO[method],
    });
  }
  const discount = sumMoney(
    input.currency,
    input.lines.map((line) => line.discountAmount),
  );
  if (discount.isPositive()) {
    lines.push({ role: "SALES_DISCOUNTS", direction: "DEBIT", amount: discount, memoKind: "DISCOUNT" });
  }
  const revenue = sumMoney(
    input.currency,
    input.lines.map((line) => revenueAmount(line.gross, line.taxAmount, line.tax.taxPricingMode)),
  );
  if (revenue.isPositive()) {
    lines.push({ role: "SALES_REVENUE", direction: "CREDIT", amount: revenue, memoKind: "REVENUE" });
  }
  const tax = sumMoney(
    input.currency,
    input.lines.map((line) => line.taxAmount),
  );
  if (tax.isPositive()) {
    lines.push({ role: "TAX_PAYABLE", direction: "CREDIT", amount: tax, memoKind: "TAX" });
  }
  const cogs = sumMoney(
    input.currency,
    input.lines.flatMap((line) => (line.cost === undefined ? [] : [line.cost])),
  );
  if (cogs.isPositive()) {
    lines.push({ role: "COST_OF_GOODS_SOLD", direction: "DEBIT", amount: cogs, memoKind: "COGS" });
    lines.push({ role: "INVENTORY", direction: "CREDIT", amount: cogs, memoKind: "INVENTORY" });
  }
  return createPostingPlan(input.currency, lines);
}

export function cogsTotal(currency: CurrencyCode, lines: readonly SaleLine[]): Money {
  return sumMoney(
    currency,
    lines.flatMap((line) => (line.cost === undefined ? [] : [line.cost])),
  );
}
