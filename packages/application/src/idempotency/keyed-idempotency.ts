import type { BusinessId, UserId, Uuid } from "@tali/domain";
import { IdempotencyKeyReusedError } from "../errors/application-error.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { JsonValue } from "../ports/queue-provider.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { BusinessIdempotencyStore, IdempotencyActor } from "./business-idempotency-store.js";
import type { CanonicalCommand } from "./canonical-command.js";
import type { CommandFingerprint } from "./fingerprint-hasher.js";
import { sameFingerprint } from "./fingerprint-hasher.js";
import type { IdempotencyKey } from "./idempotency-key.js";
import type { IdempotencyRecordId, UserIdempotencyStore } from "./user-idempotency-store.js";

/** ADR-004 section 13: initial keyed-idempotency retention (at least 30 days). */
export const MIN_IDEMPOTENCY_RETENTION_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Encodes a use case result for storage and decodes it for replay, deterministically. */
export interface IdempotentResultCodec<T> {
  encode(result: T): JsonValue;
  decode(stored: JsonValue): T;
}

/** The decided, not yet applied, effect of a keyed mutation. */
export interface PlannedMutation<T> {
  /** What is stored for replay. For operations with a one-time secret, this never contains the secret. */
  readonly result: T;
  readonly resourceId: Uuid;
  /** Performs the writes and audit records. Runs only after the key has been claimed. */
  apply(): Promise<void>;
}

export interface KeyedOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}

interface KeyedRequest<T> {
  readonly key: IdempotencyKey;
  readonly command: CanonicalCommand;
  readonly fingerprint: CommandFingerprint;
  readonly resourceType: string;
  readonly codec: IdempotentResultCodec<T>;
  readonly plan: () => Promise<PlannedMutation<T>>;
}

interface StoredCommand {
  readonly operation: string;
  readonly fingerprint: CommandFingerprint;
  readonly result: JsonValue;
}

interface NewRecord {
  readonly id: IdempotencyRecordId;
  readonly operation: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly fingerprint: CommandFingerprint;
  readonly result: JsonValue;
  readonly resourceType: string;
  readonly resourceId: Uuid;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Keyed idempotency (ADR-004 section 4) in user scope (mutations before a
 * business exists) and in business scope (per business and actor). Runs
 * inside the caller's transaction, after authentication and authorization
 * (section 6):
 *
 * 1. an existing record with the same operation and fingerprint is replayed
 *    (no new effect, no new audit); a different one is IDEMPOTENCY_KEY_REUSED;
 * 2. otherwise the mutation is planned and the key is claimed by inserting
 *    the record before any other write, so a concurrent duplicate waits on
 *    the key and then replays instead of repeating the effect;
 * 3. the planned writes are applied. Everything commits or rolls back
 *    together; a deterministic rejection leaves no record.
 */
export class KeyedIdempotency {
  readonly #userStore: UserIdempotencyStore | undefined;
  readonly #businessStore: BusinessIdempotencyStore | undefined;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #retentionMs: number;

  constructor(dependencies: {
    readonly store?: UserIdempotencyStore;
    readonly businessStore?: BusinessIdempotencyStore;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly retentionDays?: number;
  }) {
    const retentionDays = dependencies.retentionDays ?? MIN_IDEMPOTENCY_RETENTION_DAYS;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_IDEMPOTENCY_RETENTION_DAYS) {
      throw new Error(`idempotency retention must be at least ${MIN_IDEMPOTENCY_RETENTION_DAYS} days`);
    }
    this.#userStore = dependencies.store;
    this.#businessStore = dependencies.businessStore;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#retentionMs = retentionDays * MS_PER_DAY;
  }

  async runUserScoped<T>(
    scope: TransactionScope,
    request: KeyedRequest<T> & { readonly userId: UserId },
  ): Promise<KeyedOutcome<T>> {
    const store = this.#userStore;
    if (store === undefined) throw new Error("KeyedIdempotency was composed without a user-scoped store");
    return this.#run(
      request,
      () => store.find(scope, request.userId, request.key),
      (record) => store.insert(scope, { ...record, userId: request.userId }),
    );
  }

  async runBusinessScoped<T>(
    scope: TransactionScope,
    request: KeyedRequest<T> & { readonly businessId: BusinessId; readonly actor: IdempotencyActor },
  ): Promise<KeyedOutcome<T>> {
    const store = this.#businessStore;
    if (store === undefined) throw new Error("KeyedIdempotency was composed without a business-scoped store");
    return this.#run(
      request,
      () => store.find(scope, request.businessId, request.actor, request.key),
      (record) => store.insert(scope, { ...record, businessId: request.businessId, actor: request.actor }),
    );
  }

  async #run<T>(
    request: KeyedRequest<T>,
    find: () => Promise<StoredCommand | undefined>,
    insert: (record: NewRecord) => Promise<"inserted" | "duplicate">,
  ): Promise<KeyedOutcome<T>> {
    const existing = await find();
    if (existing !== undefined) return this.#replay(existing, request);

    const planned = await request.plan();
    const createdAt = this.#clock.now();
    const record: NewRecord = Object.freeze({
      id: this.#ids.newId("IdempotencyRecord"),
      operation: request.command.operation,
      idempotencyKey: request.key,
      fingerprint: request.fingerprint,
      result: request.codec.encode(planned.result),
      resourceType: request.resourceType,
      resourceId: planned.resourceId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.#retentionMs),
    });
    if ((await insert(record)) === "duplicate") {
      const committed = await find();
      if (committed === undefined) {
        throw new Error("idempotency store reported a duplicate key but returned no record");
      }
      return this.#replay(committed, request);
    }
    await planned.apply();
    return { result: planned.result, replayed: false };
  }

  #replay<T>(record: StoredCommand, request: KeyedRequest<T>): KeyedOutcome<T> {
    if (record.operation !== request.command.operation || !sameFingerprint(record.fingerprint, request.fingerprint)) {
      throw new IdempotencyKeyReusedError();
    }
    return { result: request.codec.decode(record.result), replayed: true };
  }
}
