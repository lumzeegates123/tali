import type {
  AccountType,
  BusinessId,
  CurrencyCode,
  JournalDirection,
  JournalEntryId,
  LedgerAccountId,
  Money,
  NormalBalance,
  PostingMemoKind,
  SystemAccountRole,
} from "@tali/domain";
import type {
  Actor,
  CorrelationId,
  DeviceId,
  LocationId,
  MembershipId,
  SourceChannel,
} from "../../context/business-context.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";

/** Lifecycle status of a ledger account (ADR-009 section 4: ACTIVE only in Build 3). */
export type LedgerAccountStatus = "ACTIVE";

/** A provisioned ledger account for one business. */
export interface LedgerAccount {
  readonly id: LedgerAccountId;
  readonly businessId: BusinessId;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  readonly systemRole: SystemAccountRole;
  readonly templateVersion: number;
  readonly status: LedgerAccountStatus;
  readonly createdAt: Date;
}

export type JournalEntryKind = "ORIGINAL" | "REVERSAL";

/**
 * Typed source of a journal entry (ADR-009 section 13). Source document IDs are
 * UUIDv7 strings; sales and valuation modules introduce branded IDs later.
 */
export const JOURNAL_SOURCE_KINDS = [
  "sale",
  "opening_batch",
  "goods_receipt",
  "adjustment",
  "stocktake",
  "valuation",
] as const;

export type JournalSourceKind = (typeof JOURNAL_SOURCE_KINDS)[number];

export interface JournalSourceRef {
  readonly kind: JournalSourceKind;
  readonly id: string;
}

export interface JournalLine {
  readonly lineNumber: number;
  readonly accountId: LedgerAccountId;
  readonly systemRole: SystemAccountRole;
  readonly direction: JournalDirection;
  readonly amount: Money;
  readonly memoKind?: PostingMemoKind;
}

export interface JournalEntry {
  readonly id: JournalEntryId;
  readonly businessId: BusinessId;
  readonly currency: CurrencyCode;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly recordedAt: Date;
  readonly entryKind: JournalEntryKind;
  readonly source: JournalSourceRef;
  readonly reversesEntryId?: JournalEntryId;
  readonly postingRule: string;
  readonly postingRuleVersion: number;
  readonly description: string;
  readonly actorMembershipId?: MembershipId;
  readonly deviceId?: DeviceId;
  readonly locationId?: LocationId;
  readonly sourceChannel: SourceChannel;
  readonly correlationId: CorrelationId;
  readonly lines: readonly JournalLine[];
}

/**
 * Chart and account persistence port. S2 provides the PostgreSQL adapter; S1
 * uses an in-memory adapter in tests only.
 */
export interface LedgerAccountRepository {
  /** The account for a system role within the business, or undefined. */
  findByRole(
    scope: TransactionScope,
    businessId: BusinessId,
    role: SystemAccountRole,
  ): Promise<LedgerAccount | undefined>;
  /**
   * Every account of the business, ordered by code ascending. Throws
   * StoredLedgerAccountInvalidError for a stored row the domain cannot restore.
   */
  listByBusiness(scope: TransactionScope, businessId: BusinessId): Promise<readonly LedgerAccount[]>;
  /**
   * Every distinct template version among the business's accounts, ascending;
   * empty when the business has no account. Reported as stored: the caller
   * decides what a mixed or unknown set means.
   */
  listProvisionedTemplateVersions(scope: TransactionScope, businessId: BusinessId): Promise<readonly number[]>;
  /** Inserts accounts for a new chart version. Callers must not duplicate roles. */
  insertMany(scope: TransactionScope, accounts: readonly LedgerAccount[]): Promise<void>;
}

/**
 * A stored ledger account row that cannot be restored as a LedgerAccount (for
 * example no system role). Not an ApplicationError: outside chart
 * provisioning it fails loudly as an unexpected error; provisioning reports
 * it as LEDGER_CHART_INCOMPLETE.
 */
export class StoredLedgerAccountInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoredLedgerAccountInvalidError";
  }
}

/**
 * The business row lock the operator chart command takes, so concurrent runs
 * for one business serialize. The business module's BusinessRepository
 * satisfies it structurally (SELECT ... FOR UPDATE on the business row).
 */
export interface LedgerBusinessLock {
  findByIdForUpdate(scope: TransactionScope, businessId: BusinessId): Promise<{ readonly id: BusinessId } | undefined>;
}

/**
 * Journal persistence port. Other modules never write ledger tables; they call
 * the ledger posting service, which uses this port inside the source mutation's
 * transaction (ADR-009 section 17).
 */
export interface JournalRepository {
  insert(scope: TransactionScope, entry: JournalEntry): Promise<void>;
  findById(scope: TransactionScope, businessId: BusinessId, entryId: JournalEntryId): Promise<JournalEntry | undefined>;
  /**
   * The ORIGINAL entry for a typed source, if any. Used to enforce one original
   * per source (ADR-009 section 13).
   */
  findOriginalBySource(
    scope: TransactionScope,
    businessId: BusinessId,
    source: JournalSourceRef,
  ): Promise<JournalEntry | undefined>;
  /** Every journal line for the business (for derived balances in S1 in-memory). */
  listLinesForBusiness(scope: TransactionScope, businessId: BusinessId): Promise<readonly JournalLineRow[]>;
}

/** Flat line row used when deriving account balances without a SQL SUM. */
export interface JournalLineRow {
  readonly businessId: BusinessId;
  readonly entryId: JournalEntryId;
  readonly accountId: LedgerAccountId;
  readonly direction: JournalDirection;
  readonly amount: Money;
}

export type { Actor };
