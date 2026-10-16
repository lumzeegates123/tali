import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";

export type LedgerAccountId = Id<"LedgerAccount">;
export type JournalEntryId = Id<"JournalEntry">;

export function parseLedgerAccountId(value: string): LedgerAccountId {
  return parseId("LedgerAccount", value);
}

export function parseJournalEntryId(value: string): JournalEntryId {
  return parseId("JournalEntry", value);
}
