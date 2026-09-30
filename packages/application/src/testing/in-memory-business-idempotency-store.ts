import type { BusinessId } from "@tali/domain";
import type {
  BusinessIdempotencyRecord,
  BusinessIdempotencyStore,
  IdempotencyActor,
} from "../idempotency/business-idempotency-store.js";
import type { IdempotencyKey } from "../idempotency/idempotency-key.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

const keyOf = (businessId: BusinessId, actor: IdempotencyActor, key: IdempotencyKey) =>
  `${businessId}|${actor.type}|${actor.id}|${key}`;

/**
 * Business-scoped idempotency records, unique on (businessId, actor, key).
 * `beforeInsert` runs before the uniqueness check, so a test can commit a
 * competing record and simulate losing the race to a concurrent request.
 */
export class InMemoryBusinessIdempotencyStore implements BusinessIdempotencyStore, RollbackParticipant {
  readonly failures = new FailureInjection();
  beforeInsert: ((record: BusinessIdempotencyRecord) => void) | undefined;
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  #records = new Map<string, BusinessIdempotencyRecord>();

  constructor(options: { readonly unitOfWork?: InMemoryUnitOfWork } = {}) {
    this.#unitOfWork = options.unitOfWork;
    this.#unitOfWork?.enlist(this);
  }

  get records(): readonly BusinessIdempotencyRecord[] {
    return [...this.#records.values()];
  }

  /** Stores a record directly, as if committed by another request. */
  put(record: BusinessIdempotencyRecord): void {
    this.#records.set(keyOf(record.businessId, record.actor, record.idempotencyKey), record);
  }

  captureState(): () => void {
    const records = new Map(this.#records);
    return () => {
      this.#records = records;
    };
  }

  async find(
    scope: TransactionScope,
    businessId: BusinessId,
    actor: IdempotencyActor,
    key: IdempotencyKey,
  ): Promise<BusinessIdempotencyRecord | undefined> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("businessIdempotency.find");
    return this.#records.get(keyOf(businessId, actor, key));
  }

  async insert(scope: TransactionScope, record: BusinessIdempotencyRecord): Promise<"inserted" | "duplicate"> {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check("businessIdempotency.insert");
    const hook = this.beforeInsert;
    this.beforeInsert = undefined;
    hook?.(record);
    const id = keyOf(record.businessId, record.actor, record.idempotencyKey);
    if (this.#records.has(id)) return "duplicate";
    this.#records.set(id, record);
    return "inserted";
  }
}
