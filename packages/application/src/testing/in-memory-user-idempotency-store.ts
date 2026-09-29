import type { UserId } from "@tali/domain";
import type { IdempotencyKey } from "../idempotency/idempotency-key.js";
import type { UserIdempotencyRecord, UserIdempotencyStore } from "../idempotency/user-idempotency-store.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

/**
 * User-scoped idempotency records, unique on (userId, idempotencyKey).
 * `beforeInsert` runs before the uniqueness check, so a test can commit a
 * competing record and simulate losing the race to a concurrent request.
 */
export class InMemoryUserIdempotencyStore implements UserIdempotencyStore, RollbackParticipant {
  readonly failures = new FailureInjection();
  beforeInsert: ((record: UserIdempotencyRecord) => void) | undefined;
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  #records = new Map<string, UserIdempotencyRecord>();

  constructor(options: { readonly unitOfWork?: InMemoryUnitOfWork } = {}) {
    this.#unitOfWork = options.unitOfWork;
    this.#unitOfWork?.enlist(this);
  }

  get records(): readonly UserIdempotencyRecord[] {
    return [...this.#records.values()];
  }

  /** Stores a record directly, as if committed by another request. */
  put(record: UserIdempotencyRecord): void {
    this.#records.set(`${record.userId}|${record.idempotencyKey}`, record);
  }

  captureState(): () => void {
    const records = new Map(this.#records);
    return () => {
      this.#records = records;
    };
  }

  async find(scope: TransactionScope, userId: UserId, key: IdempotencyKey): Promise<UserIdempotencyRecord | undefined> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("idempotency.find");
    return this.#records.get(`${userId}|${key}`);
  }

  async insert(scope: TransactionScope, record: UserIdempotencyRecord): Promise<"inserted" | "duplicate"> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("idempotency.insert");
    const hook = this.beforeInsert;
    this.beforeInsert = undefined;
    hook?.(record);
    const id = `${record.userId}|${record.idempotencyKey}`;
    if (this.#records.has(id)) return "duplicate";
    this.#records.set(id, record);
    return "inserted";
  }
}
