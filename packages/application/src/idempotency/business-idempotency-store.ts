import type { BusinessId, Uuid } from "@tali/domain";
import type { Actor } from "../context/business-context.js";
import type { JsonValue } from "../ports/queue-provider.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { CommandFingerprint } from "./fingerprint-hasher.js";
import type { IdempotencyKey } from "./idempotency-key.js";
import type { IdempotencyRecordId } from "./user-idempotency-store.js";

/**
 * The actor part of the business idempotency scope (ADR-004 section 4.2): a
 * user by user ID, a system process or an integration by name. One actor
 * never replays another actor's result.
 */
export interface IdempotencyActor {
  readonly type: Actor["type"];
  readonly id: string;
}

export function idempotencyActorOf(actor: Actor): IdempotencyActor {
  switch (actor.type) {
    case "user":
      return { type: "user", id: actor.userId };
    case "system":
      return { type: "system", id: actor.process };
    case "integration":
      return { type: "integration", id: actor.provider };
  }
}

/**
 * A completed business-scoped keyed mutation (`business_idempotency_records`).
 * Immutable once committed. The result never contains a one-time secret
 * (ADR-004 section 12).
 */
export interface BusinessIdempotencyRecord {
  readonly id: IdempotencyRecordId;
  readonly businessId: BusinessId;
  readonly actor: IdempotencyActor;
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
 * Storage for business-scoped keyed idempotency, unique on (businessId,
 * actor type, actor ID, idempotencyKey). Same adapter obligations as the
 * user-scoped store: the insert waits for a concurrent holder of the key and
 * returns "duplicate" when it committed (INSERT ... ON CONFLICT DO NOTHING),
 * a lock-wait timeout raises IDEMPOTENCY_IN_PROGRESS, and the 16 KiB result
 * limit is enforced.
 */
export interface BusinessIdempotencyStore {
  find(
    scope: TransactionScope,
    businessId: BusinessId,
    actor: IdempotencyActor,
    key: IdempotencyKey,
  ): Promise<BusinessIdempotencyRecord | undefined>;
  insert(scope: TransactionScope, record: BusinessIdempotencyRecord): Promise<"inserted" | "duplicate">;
}
