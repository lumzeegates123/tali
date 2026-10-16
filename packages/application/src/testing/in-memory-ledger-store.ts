import type { BusinessId, JournalEntryId, LedgerAccountId, SystemAccountRole } from "@tali/domain";
import type {
  JournalEntry,
  JournalLineRow,
  JournalRepository,
  JournalSourceRef,
  LedgerAccount,
  LedgerAccountRepository,
} from "../modules/ledger/ports.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

/**
 * In-memory ledger accounts and journal entries for S1 tests. S2 replaces this
 * with PostgreSQL repositories. Tenant-scoped: every lookup requires businessId.
 */
export class InMemoryLedgerStore implements LedgerAccountRepository, JournalRepository, RollbackParticipant {
  readonly failures = new FailureInjection();
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  #accounts: LedgerAccount[] = [];
  #entries: JournalEntry[] = [];

  constructor(options: { readonly unitOfWork?: InMemoryUnitOfWork } = {}) {
    this.#unitOfWork = options.unitOfWork;
    this.#unitOfWork?.enlist(this);
  }

  captureState(): () => void {
    const accounts = [...this.#accounts];
    const entries = this.#entries.map((entry) => ({ ...entry, lines: [...entry.lines] }));
    return () => {
      this.#accounts = accounts;
      this.#entries = entries;
    };
  }

  get accounts(): readonly LedgerAccount[] {
    return [...this.#accounts];
  }

  get entries(): readonly JournalEntry[] {
    return [...this.#entries];
  }

  async findByRole(
    scope: TransactionScope,
    businessId: BusinessId,
    role: SystemAccountRole,
  ): Promise<LedgerAccount | undefined> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.accounts.findByRole");
    return this.#accounts.find((account) => account.businessId === businessId && account.systemRole === role);
  }

  async listByBusiness(scope: TransactionScope, businessId: BusinessId): Promise<readonly LedgerAccount[]> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.accounts.listByBusiness");
    return Object.freeze(
      [...this.#accounts.filter((account) => account.businessId === businessId)].sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    );
  }

  async findProvisionedTemplateVersion(scope: TransactionScope, businessId: BusinessId): Promise<number | undefined> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.accounts.findProvisionedTemplateVersion");
    let version: number | undefined;
    for (const account of this.#accounts) {
      if (account.businessId !== businessId) continue;
      version = version === undefined ? account.templateVersion : Math.max(version, account.templateVersion);
    }
    return version;
  }

  async insertMany(scope: TransactionScope, accounts: readonly LedgerAccount[]): Promise<void> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.accounts.insertMany");
    for (const account of accounts) {
      const duplicateRole = this.#accounts.some(
        (existing) => existing.businessId === account.businessId && existing.systemRole === account.systemRole,
      );
      if (duplicateRole) {
        throw new Error(`duplicate ledger account role ${account.systemRole}`);
      }
      const duplicateId = this.#accounts.some(
        (existing) => existing.businessId === account.businessId && existing.id === account.id,
      );
      if (duplicateId) {
        throw new Error(`duplicate ledger account id ${account.id}`);
      }
    }
    this.#accounts.push(...accounts);
    this.failures.checkAfter("ledger.accounts.insertMany");
  }

  async insert(scope: TransactionScope, entry: JournalEntry): Promise<void> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.journals.insert");
    if (this.#entries.some((existing) => existing.businessId === entry.businessId && existing.id === entry.id)) {
      throw new Error(`duplicate journal entry ${entry.id}`);
    }
    if (entry.entryKind === "ORIGINAL") {
      const duplicateSource = this.#entries.some(
        (existing) =>
          existing.businessId === entry.businessId &&
          existing.entryKind === "ORIGINAL" &&
          existing.source.kind === entry.source.kind &&
          existing.source.id === entry.source.id,
      );
      if (duplicateSource) {
        throw new Error("duplicate original journal source");
      }
    }
    if (entry.reversesEntryId !== undefined) {
      const duplicateReversal = this.#entries.some(
        (existing) => existing.businessId === entry.businessId && existing.reversesEntryId === entry.reversesEntryId,
      );
      if (duplicateReversal) {
        throw new Error("duplicate reversal of journal entry");
      }
    }
    this.#entries.push(entry);
    this.failures.checkAfter("ledger.journals.insert");
  }

  async findById(
    scope: TransactionScope,
    businessId: BusinessId,
    entryId: JournalEntryId,
  ): Promise<JournalEntry | undefined> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.journals.findById");
    return this.#entries.find((entry) => entry.businessId === businessId && entry.id === entryId);
  }

  async findOriginalBySource(
    scope: TransactionScope,
    businessId: BusinessId,
    source: JournalSourceRef,
  ): Promise<JournalEntry | undefined> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.journals.findOriginalBySource");
    return this.#entries.find(
      (entry) =>
        entry.businessId === businessId &&
        entry.entryKind === "ORIGINAL" &&
        entry.source.kind === source.kind &&
        entry.source.id === source.id,
    );
  }

  async listLinesForBusiness(scope: TransactionScope, businessId: BusinessId): Promise<readonly JournalLineRow[]> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("ledger.journals.listLinesForBusiness");
    const rows: JournalLineRow[] = [];
    for (const entry of this.#entries) {
      if (entry.businessId !== businessId) continue;
      for (const line of entry.lines) {
        rows.push(
          Object.freeze({
            businessId,
            entryId: entry.id,
            accountId: line.accountId,
            direction: line.direction,
            amount: line.amount,
          }),
        );
      }
    }
    return Object.freeze(rows);
  }

  /** Test helper: accounts for one business only. */
  accountsFor(businessId: BusinessId): readonly LedgerAccount[] {
    return this.#accounts.filter((account) => account.businessId === businessId);
  }

  /** Test helper: force a missing role after provisioning (simulates partial chart). */
  removeRole(businessId: BusinessId, role: SystemAccountRole): void {
    this.#accounts = this.#accounts.filter(
      (account) => !(account.businessId === businessId && account.systemRole === role),
    );
  }

  /**
   * Test helper: replace one provisioned account with a patched copy (simulates
   * an inconsistent stored chart without silent repair).
   */
  corruptAccount(
    businessId: BusinessId,
    role: SystemAccountRole,
    patch: Partial<Pick<LedgerAccount, "code" | "name" | "type" | "normalBalance" | "templateVersion" | "status">>,
  ): void {
    this.#accounts = this.#accounts.map((account) => {
      if (account.businessId !== businessId || account.systemRole !== role) {
        return account;
      }
      return Object.freeze({ ...account, ...patch });
    });
  }

  accountId(businessId: BusinessId, role: SystemAccountRole): LedgerAccountId | undefined {
    return this.#accounts.find((account) => account.businessId === businessId && account.systemRole === role)?.id;
  }
}
