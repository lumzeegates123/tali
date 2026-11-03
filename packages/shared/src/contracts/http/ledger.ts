import { z } from "zod";
import { CurrencyCodeWireSchema, MoneyWireSchema } from "./money.js";

/**
 * Build 3 ledger read contracts (ADR-009, ADR-011, plan 005 Slice 6). Ledger
 * routes are read-only: there is no request body. Every object is strict.
 * Responses never carry the business ID, the acting membership, the device,
 * the source channel or the correlation ID; those stay in the audit trail.
 * Amounts are base-10 strings of minor units, never JSON numbers. A balance
 * is signed in the account's normal-balance direction and may be negative.
 */

const IdWireSchema = z.uuid();
const InstantWireSchema = z.iso.datetime();
const BusinessDateWireSchema = z.iso.date();
const VersionWireSchema = z.number().int().min(1).max(2_147_483_647);

export const AccountTypeWireSchema = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "CONTRA_REVENUE", "EXPENSE"]);
export const NormalBalanceWireSchema = z.enum(["DEBIT", "CREDIT"]);
export const JournalDirectionWireSchema = z.enum(["DEBIT", "CREDIT"]);
export const SystemAccountRoleWireSchema = z.enum([
  "CASH_ON_HAND",
  "BANK_TRANSFER_PENDING",
  "POS_CARD_CLEARING",
  "OTHER_TENDER_CLEARING",
  "INVENTORY",
  "SALES_REVENUE",
  "SALES_DISCOUNTS",
  "TAX_PAYABLE",
  "COST_OF_GOODS_SOLD",
  "INVENTORY_SHRINKAGE",
  "INVENTORY_GAIN",
  "OPENING_BALANCE_EQUITY",
  "GOODS_RECEIVED_NOT_INVOICED",
]);
export const LedgerAccountStatusWireSchema = z.enum(["ACTIVE"]);
export const JournalEntryKindWireSchema = z.enum(["ORIGINAL", "REVERSAL"]);
export const JournalSourceKindWireSchema = z.enum([
  "sale",
  "opening_batch",
  "goods_receipt",
  "adjustment",
  "stocktake",
  "valuation",
]);
export const PostingMemoKindWireSchema = z.enum([
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
]);

// ---- Paths ---------------------------------------------------------------

export const LedgerEntryPathSchema = z.strictObject({ businessId: z.string(), entryId: z.string() });

// ---- Responses -------------------------------------------------------------

export const LedgerAccountResponseSchema = z.strictObject({
  accountId: IdWireSchema,
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(200),
  type: AccountTypeWireSchema,
  normalBalance: NormalBalanceWireSchema,
  systemRole: SystemAccountRoleWireSchema,
  templateVersion: VersionWireSchema,
  status: LedgerAccountStatusWireSchema,
});
export type LedgerAccountResponse = z.infer<typeof LedgerAccountResponseSchema>;

/** `GET .../ledger/accounts` (`ledger:read`): the business's chart of accounts, by code. */
export const LedgerAccountsResponseSchema = z.strictObject({ items: z.array(LedgerAccountResponseSchema) });
export type LedgerAccountsResponse = z.infer<typeof LedgerAccountsResponseSchema>;

export const AccountBalanceResponseSchema = z
  .strictObject({
    accountId: IdWireSchema,
    systemRole: SystemAccountRoleWireSchema,
    code: z.string().min(1).max(32),
    name: z.string().min(1).max(200),
    debitTotal: MoneyWireSchema,
    creditTotal: MoneyWireSchema,
    balance: MoneyWireSchema,
  })
  .refine(
    (row) => row.debitTotal.currency === row.balance.currency && row.creditTotal.currency === row.balance.currency,
    { message: "a balance has one currency" },
  );
export type AccountBalanceResponse = z.infer<typeof AccountBalanceResponseSchema>;

/** `GET .../ledger/balances` (`ledger:read`): totals per account over every posted journal line. */
export const AccountBalancesResponseSchema = z.strictObject({ items: z.array(AccountBalanceResponseSchema) });
export type AccountBalancesResponse = z.infer<typeof AccountBalancesResponseSchema>;

export const JournalLineResponseSchema = z.strictObject({
  lineNumber: z.number().int().min(1).max(10_000),
  accountId: IdWireSchema,
  systemRole: SystemAccountRoleWireSchema,
  direction: JournalDirectionWireSchema,
  amount: MoneyWireSchema,
  memoKind: PostingMemoKindWireSchema.nullable(),
});
export type JournalLineResponse = z.infer<typeof JournalLineResponseSchema>;

/** `GET .../ledger/entries/:entryId` (`ledger:read`): one balanced journal entry and its lines. */
export const JournalEntryResponseSchema = z
  .strictObject({
    entryId: IdWireSchema,
    currency: CurrencyCodeWireSchema,
    occurredAt: InstantWireSchema,
    businessDate: BusinessDateWireSchema,
    recordedAt: InstantWireSchema,
    entryKind: JournalEntryKindWireSchema,
    source: z.strictObject({ kind: JournalSourceKindWireSchema, id: IdWireSchema }),
    reversesEntryId: IdWireSchema.nullable(),
    postingRule: z
      .string()
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    postingRuleVersion: VersionWireSchema,
    description: z.string().max(1000),
    locationId: IdWireSchema.nullable(),
    lines: z.array(JournalLineResponseSchema).min(2).max(10_000),
  })
  .refine((entry) => entry.lines.every((line) => line.amount.currency === entry.currency), {
    message: "every line is in the entry currency",
  })
  .refine((entry) => (entry.entryKind === "REVERSAL") === (entry.reversesEntryId !== null), {
    message: "reversesEntryId is set exactly on a REVERSAL",
  });
export type JournalEntryResponse = z.infer<typeof JournalEntryResponseSchema>;
