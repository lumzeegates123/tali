import {
  ValidationError,
  type JournalEntry,
  type JournalLine,
  type JournalRepository,
  type JournalSourceRef,
} from "@tali/application";
import {
  Money,
  parseBusinessId,
  parseJournalDirection,
  parseJournalEntryId,
  parseLedgerAccountId,
  parsePostingMemoKind,
  parseSystemAccountRole,
} from "@tali/domain";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import type {
  JournalEntry as JournalEntryRow,
  JournalLine as JournalLineRow,
  LedgerAccount,
} from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { fromDateColumn } from "./inventory-rows.js";

export const JOURNAL_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  journal_entries_pkey: "a journal entry with this identity already exists",
  journal_entries_business_id_id_key: "a journal entry with this identity already exists",
  journal_entries_business_id_reverses_entry_id_key: "this journal entry has already been reversed",
  journal_entries_original_opening_batch_key: "an original journal entry already exists for this source",
  journal_entries_original_goods_receipt_key: "an original journal entry already exists for this source",
  journal_entries_original_adjustment_key: "an original journal entry already exists for this source",
  journal_entries_original_stocktake_key: "an original journal entry already exists for this source",
  journal_entries_original_valuation_key: "an original journal entry already exists for this source",
});

function sourceColumns(source: JournalSourceRef) {
  if (source.kind === "sale") {
    throw new ValidationError("sale journal sources are not available until the sales slice", [
      { path: ["source", "kind"], message: "unavailable" },
    ]);
  }
  return {
    openingBatchId: source.kind === "opening_batch" ? source.id : null,
    goodsReceiptId: source.kind === "goods_receipt" ? source.id : null,
    adjustmentId: source.kind === "adjustment" ? source.id : null,
    stocktakeId: source.kind === "stocktake" ? source.id : null,
    valuationId: source.kind === "valuation" ? source.id : null,
  };
}

function sourceOf(row: JournalEntryRow): JournalSourceRef {
  if (row.openingBatchId !== null) return { kind: "opening_batch", id: row.openingBatchId };
  if (row.goodsReceiptId !== null) return { kind: "goods_receipt", id: row.goodsReceiptId };
  if (row.adjustmentId !== null) return { kind: "adjustment", id: row.adjustmentId };
  if (row.stocktakeId !== null) return { kind: "stocktake", id: row.stocktakeId };
  if (row.valuationId !== null) return { kind: "valuation", id: row.valuationId };
  throw new Error("a stored journal entry must have exactly one typed source");
}

function toLine(
  row: JournalLineRow & { readonly account: LedgerAccount },
  currency: JournalEntry["currency"],
): JournalLine {
  if (row.account.systemRole === null) throw new Error("a journal line account must have a system role");
  return Object.freeze({
    lineNumber: row.lineNumber,
    accountId: parseLedgerAccountId(row.accountId),
    systemRole: parseSystemAccountRole(row.account.systemRole),
    direction: parseJournalDirection(row.direction),
    amount: Money.ofMinor(row.amountMinor, currency),
    ...(row.memoKind === null ? {} : { memoKind: parsePostingMemoKind(row.memoKind) }),
  });
}

function toEntry(
  row: JournalEntryRow & {
    readonly lines: readonly (JournalLineRow & { readonly account: LedgerAccount })[];
  },
): JournalEntry {
  const currency = row.currency as JournalEntry["currency"];
  const entry: JournalEntry = {
    id: parseJournalEntryId(row.id),
    businessId: parseBusinessId(row.businessId),
    currency,
    occurredAt: row.occurredAt,
    businessDate: fromDateColumn(row.businessDate).toString(),
    recordedAt: row.recordedAt,
    entryKind: row.entryKind === "REVERSAL" ? "REVERSAL" : "ORIGINAL",
    source: sourceOf(row),
    postingRule: row.postingRule,
    postingRuleVersion: row.postingRuleVersion,
    description: row.description,
    sourceChannel: row.sourceChannel as JournalEntry["sourceChannel"],
    correlationId: row.correlationId as JournalEntry["correlationId"],
    lines: Object.freeze(row.lines.map((line) => toLine(line, currency))),
    ...(row.reversesEntryId === null ? {} : { reversesEntryId: parseJournalEntryId(row.reversesEntryId) }),
    ...(row.actorMembershipId === null
      ? {}
      : { actorMembershipId: row.actorMembershipId as NonNullable<JournalEntry["actorMembershipId"]> }),
    ...(row.deviceId === null ? {} : { deviceId: row.deviceId as NonNullable<JournalEntry["deviceId"]> }),
    ...(row.locationId === null ? {} : { locationId: row.locationId as NonNullable<JournalEntry["locationId"]> }),
  };
  return Object.freeze(entry);
}

export function createJournalRepository(): JournalRepository {
  return {
    async insert(scope, entry) {
      const columns = sourceColumns(entry.source);
      await translatingUniqueViolations(JOURNAL_CONFLICTS, () =>
        transactionClient(scope).journalEntry.create({
          data: {
            businessId: entry.businessId,
            id: entry.id,
            currency: entry.currency,
            occurredAt: entry.occurredAt,
            businessDate: new Date(`${entry.businessDate}T00:00:00.000Z`),
            recordedAt: entry.recordedAt,
            entryKind: entry.entryKind,
            ...columns,
            reversesEntryId: entry.reversesEntryId ?? null,
            postingRule: entry.postingRule,
            postingRuleVersion: entry.postingRuleVersion,
            description: entry.description,
            actorMembershipId: entry.actorMembershipId ?? null,
            deviceId: entry.deviceId ?? null,
            locationId: entry.locationId ?? null,
            sourceChannel: entry.sourceChannel,
            correlationId: entry.correlationId,
            lines: {
              create: entry.lines.map((line) => ({
                lineNumber: line.lineNumber,
                accountId: line.accountId,
                direction: line.direction,
                amountMinor: line.amount.amountMinor,
                currency: entry.currency,
                memoKind: line.memoKind ?? null,
              })),
            },
          },
        }),
      );
    },

    async findById(scope, businessId, entryId) {
      const row = await transactionClient(scope).journalEntry.findUnique({
        where: { businessId_id: { businessId, id: entryId } },
        include: { lines: { include: { account: true }, orderBy: { lineNumber: "asc" } } },
      });
      return row === null ? undefined : toEntry(row);
    },

    async findOriginalBySource(scope, businessId, source) {
      const columns = sourceColumns(source);
      const where = {
        businessId,
        entryKind: "ORIGINAL",
        ...(columns.openingBatchId === null ? {} : { openingBatchId: columns.openingBatchId }),
        ...(columns.goodsReceiptId === null ? {} : { goodsReceiptId: columns.goodsReceiptId }),
        ...(columns.adjustmentId === null ? {} : { adjustmentId: columns.adjustmentId }),
        ...(columns.stocktakeId === null ? {} : { stocktakeId: columns.stocktakeId }),
        ...(columns.valuationId === null ? {} : { valuationId: columns.valuationId }),
      };
      const row = await transactionClient(scope).journalEntry.findFirst({
        where,
        include: { lines: { include: { account: true }, orderBy: { lineNumber: "asc" } } },
      });
      return row === null ? undefined : toEntry(row);
    },

    async listLinesForBusiness(scope, businessId) {
      const rows = await transactionClient(scope).journalLine.findMany({
        where: { businessId },
        orderBy: [{ entryId: "asc" }, { lineNumber: "asc" }],
      });
      return rows.map((row) =>
        Object.freeze({
          businessId: parseBusinessId(row.businessId),
          entryId: parseJournalEntryId(row.entryId),
          accountId: parseLedgerAccountId(row.accountId),
          direction: parseJournalDirection(row.direction),
          amount: Money.ofMinor(row.amountMinor, row.currency as JournalEntry["currency"]),
        }),
      );
    },
  };
}
