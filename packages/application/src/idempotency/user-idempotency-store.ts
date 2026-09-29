import type { Id, UserId, Uuid } from "@tali/domain";
import type { JsonValue } from "../ports/queue-provider.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { CommandFingerprint } from "./fingerprint-hasher.js";
import type { IdempotencyKey } from "./idempotency-key.js";

export type IdempotencyRecordId = Id<"IdempotencyRecord">;

/**
 * A completed user-scoped keyed mutation (`user_idempotency_records`, ADR-004
 * section 4.2). The actor is always the user. Immutable once committed.
 */
export interface UserIdempotencyRecord {
  readonly id: IdempotencyRecordId;
  readonly userId: UserId;
  readonly operation: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly fingerprint: CommandFingerprint;
  /** The use case result, encoded by its per-operation codec. Never contains one-time secrets. */
  readonly result: JsonValue;
  readonly resourceType: string;
  readonly resourceId: Uuid;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * Storage for user-scoped keyed idempotency, unique on (userId,
 * idempotencyKey). Adapter obligations (Slice 2): the insert waits for a
 * concurrent transaction holding the same key and returns "duplicate" when
 * that one committed, leaving this transaction usable (INSERT ... ON CONFLICT
 * DO NOTHING); a lock-wait timeout raises the ADR-004 in-progress error; the
 * 16 KiB result limit is enforced on the encoded result.
 */
export interface UserIdempotencyStore {
  find(scope: TransactionScope, userId: UserId, key: IdempotencyKey): Promise<UserIdempotencyRecord | undefined>;
  insert(scope: TransactionScope, record: UserIdempotencyRecord): Promise<"inserted" | "duplicate">;
}
