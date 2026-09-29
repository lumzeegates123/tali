import type { AuditWriter, BusinessAuditRecord, PlatformAuditRecord } from "../audit/audit-writer.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

/** Collects audit records; records written by a failed unit of work are rolled back with it. */
export class InMemoryAuditWriter implements AuditWriter, RollbackParticipant {
  readonly failures = new FailureInjection();
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  #business: BusinessAuditRecord[] = [];
  #platform: PlatformAuditRecord[] = [];

  constructor(options: { readonly unitOfWork?: InMemoryUnitOfWork } = {}) {
    this.#unitOfWork = options.unitOfWork;
    this.#unitOfWork?.enlist(this);
  }

  get businessRecords(): readonly BusinessAuditRecord[] {
    return [...this.#business];
  }

  get platformRecords(): readonly PlatformAuditRecord[] {
    return [...this.#platform];
  }

  get all(): readonly (BusinessAuditRecord | PlatformAuditRecord)[] {
    return [...this.#platform, ...this.#business];
  }

  captureState(): () => void {
    const business = [...this.#business];
    const platform = [...this.#platform];
    return () => {
      this.#business = business;
      this.#platform = platform;
    };
  }

  async recordBusinessEvent(scope: TransactionScope, record: BusinessAuditRecord): Promise<void> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check(`audit.${record.action}`);
    this.#business.push(record);
  }

  async recordPlatformEvent(scope: TransactionScope, record: PlatformAuditRecord): Promise<void> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check(`audit.${record.action}`);
    this.#platform.push(record);
  }
}
