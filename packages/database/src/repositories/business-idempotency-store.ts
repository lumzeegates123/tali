import type { BusinessIdempotencyRecord, BusinessIdempotencyStore, IdempotencyKey, JsonValue } from "@tali/application";
import { IdempotencyInProgressError } from "@tali/application";
import { parseBusinessId, parseId, parseUuid } from "@tali/domain";
import { isLockNotAvailable } from "../errors/postgres-errors.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { encodedIdempotencyResult } from "./user-idempotency-store.js";

const ACTOR_TYPES = ["user", "system", "integration"] as const;

function parseActorType(value: string): BusinessIdempotencyRecord["actor"]["type"] {
  const type = ACTOR_TYPES.find((candidate) => candidate === value);
  if (type === undefined) throw new Error("business idempotency record has an unknown actor type");
  return type;
}

/**
 * Business-scoped keyed idempotency (ADR-004 sections 4.2 and 4.3), unique on
 * (business_id, actor_type, actor_id, idempotency_key). Same protocol as the
 * user-scoped store: the record is inserted inside the mutation's transaction
 * with INSERT ... ON CONFLICT DO NOTHING, a committed concurrent holder makes
 * it "duplicate", and a lock wait beyond lock_timeout is
 * IDEMPOTENCY_IN_PROGRESS.
 */
export function createBusinessIdempotencyStore(): BusinessIdempotencyStore {
  return {
    async find(scope, businessId, actor, key) {
      const row = await transactionClient(scope).businessIdempotencyRecord.findUnique({
        where: {
          businessId_actorType_actorId_idempotencyKey: {
            businessId,
            actorType: actor.type,
            actorId: actor.id,
            idempotencyKey: key,
          },
        },
      });
      if (row === null) return undefined;
      return Object.freeze({
        id: parseId("IdempotencyRecord", row.id),
        businessId: parseBusinessId(row.businessId),
        actor: { type: parseActorType(row.actorType), id: row.actorId },
        operation: row.operation,
        idempotencyKey: parseUuid(row.idempotencyKey) as IdempotencyKey,
        fingerprint: { version: row.fingerprintVersion, digest: new Uint8Array(row.fingerprint) },
        result: row.result as JsonValue,
        resourceType: row.resourceType,
        resourceId: parseUuid(row.resourceId),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      } satisfies BusinessIdempotencyRecord);
    },

    async insert(scope, record) {
      const result = encodedIdempotencyResult(record.result);
      try {
        const inserted = await transactionClient(scope).$executeRaw`
          INSERT INTO business_idempotency_records (
            business_id, id, actor_type, actor_id, operation, idempotency_key, fingerprint, fingerprint_version,
            result, resource_type, resource_id, created_at, expires_at)
          VALUES (
            ${record.businessId}::uuid, ${record.id}::uuid, ${record.actor.type}, ${record.actor.id},
            ${record.operation}, ${record.idempotencyKey}::uuid, ${record.fingerprint.digest},
            ${record.fingerprint.version}, ${result}::json, ${record.resourceType}, ${record.resourceId}::uuid,
            ${record.createdAt.toISOString()}::timestamptz, ${record.expiresAt.toISOString()}::timestamptz)
          ON CONFLICT (business_id, actor_type, actor_id, idempotency_key) DO NOTHING`;
        return inserted === 1 ? "inserted" : "duplicate";
      } catch (error) {
        if (isLockNotAvailable(error)) throw new IdempotencyInProgressError(undefined, { cause: error });
        throw error;
      }
    },
  };
}
