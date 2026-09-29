import type { UserId, Uuid } from "@tali/domain";
import { IdempotencyKeyReusedError } from "../errors/application-error.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { JsonValue } from "../ports/queue-provider.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { CanonicalCommand } from "./canonical-command.js";
import type { CommandFingerprint } from "./fingerprint-hasher.js";
import { sameFingerprint } from "./fingerprint-hasher.js";
import type { IdempotencyKey } from "./idempotency-key.js";
import type { UserIdempotencyRecord, UserIdempotencyStore } from "./user-idempotency-store.js";

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
  readonly result: T;
  readonly resourceId: Uuid;
  /** Performs the writes and audit records. Runs only after the key has been claimed. */
  apply(): Promise<void>;
}

export interface KeyedOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}

/**
 * Keyed idempotency for user-scoped mutations (ADR-004 section 4). Runs
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
  readonly #store: UserIdempotencyStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #retentionMs: number;

  constructor(dependencies: {
    readonly store: UserIdempotencyStore;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly retentionDays?: number;
  }) {
    const retentionDays = dependencies.retentionDays ?? MIN_IDEMPOTENCY_RETENTION_DAYS;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < MIN_IDEMPOTENCY_RETENTION_DAYS) {
      throw new Error(`idempotency retention must be at least ${MIN_IDEMPOTENCY_RETENTION_DAYS} days`);
    }
    this.#store = dependencies.store;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#retentionMs = retentionDays * MS_PER_DAY;
  }

  async runUserScoped<T>(
    scope: TransactionScope,
    request: {
      readonly userId: UserId;
      readonly key: IdempotencyKey;
      readonly command: CanonicalCommand;
      readonly fingerprint: CommandFingerprint;
      readonly resourceType: string;
      readonly codec: IdempotentResultCodec<T>;
      readonly plan: () => Promise<PlannedMutation<T>>;
    },
  ): Promise<KeyedOutcome<T>> {
    const existing = await this.#store.find(scope, request.userId, request.key);
    if (existing !== undefined) return this.#replay(existing, request);

    const planned = await request.plan();
    const createdAt = this.#clock.now();
    const record: UserIdempotencyRecord = Object.freeze({
      id: this.#ids.newId("IdempotencyRecord"),
      userId: request.userId,
      operation: request.command.operation,
      idempotencyKey: request.key,
      fingerprint: request.fingerprint,
      result: request.codec.encode(planned.result),
      resourceType: request.resourceType,
      resourceId: planned.resourceId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.#retentionMs),
    });
    if ((await this.#store.insert(scope, record)) === "duplicate") {
      const committed = await this.#store.find(scope, request.userId, request.key);
      if (committed === undefined) {
        throw new Error("idempotency store reported a duplicate key but returned no record");
      }
      return this.#replay(committed, request);
    }
    await planned.apply();
    return { result: planned.result, replayed: false };
  }

  #replay<T>(
    record: UserIdempotencyRecord,
    request: {
      readonly command: CanonicalCommand;
      readonly fingerprint: CommandFingerprint;
      readonly codec: IdempotentResultCodec<T>;
    },
  ): KeyedOutcome<T> {
    if (record.operation !== request.command.operation || !sameFingerprint(record.fingerprint, request.fingerprint)) {
      throw new IdempotencyKeyReusedError();
    }
    return { result: request.codec.decode(record.result), replayed: true };
  }
}
