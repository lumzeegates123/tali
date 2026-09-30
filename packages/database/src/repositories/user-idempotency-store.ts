import type { IdempotencyKey, JsonValue, UserIdempotencyRecord, UserIdempotencyStore } from "@tali/application";
import { IdempotencyInProgressError } from "@tali/application";
import { parseId, parseUserId, parseUuid } from "@tali/domain";
import { isLockNotAvailable } from "../errors/postgres-errors.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

/** ADR-004 section 13: stored idempotency result size limit (16 KiB). */
export const IDEMPOTENCY_RESULT_MAX_BYTES = 16_384;

/**
 * The result as stored: compact JSON in a `json` column, which keeps the
 * exact text, so this byte count is what the database CHECK measures.
 */
export function encodedIdempotencyResult(result: JsonValue): string {
  const encoded = JSON.stringify(result);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > IDEMPOTENCY_RESULT_MAX_BYTES) {
    throw new Error(`idempotency result is ${bytes} bytes; the limit is ${IDEMPOTENCY_RESULT_MAX_BYTES}`);
  }
  return encoded;
}

/**
 * User-scoped keyed idempotency (ADR-004 sections 4.2 and 4.3), unique on
 * (user_id, idempotency_key). There is no in-progress row: the record is
 * inserted inside the mutation's transaction.
 *
 * `insert` claims the key with INSERT ... ON CONFLICT DO NOTHING on that
 * unique key. A concurrent transaction holding the same key makes it wait;
 * when that transaction commits the insert affects no row and returns
 * "duplicate" (this transaction stays usable for the replay read); when it
 * rolls back the insert proceeds. A wait beyond lock_timeout is
 * IDEMPOTENCY_IN_PROGRESS. The result size is checked before anything is sent.
 */
export function createUserIdempotencyStore(): UserIdempotencyStore {
  return {
    async find(scope, userId, key) {
      const row = await transactionClient(scope).userIdempotencyRecord.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      });
      if (row === null) return undefined;
      if (row.actorType !== "user" || row.actorId !== row.userId) {
        throw new Error("user idempotency record has an actor other than its user");
      }
      return Object.freeze({
        id: parseId("IdempotencyRecord", row.id),
        userId: parseUserId(row.userId),
        operation: row.operation,
        idempotencyKey: parseUuid(row.idempotencyKey) as IdempotencyKey,
        fingerprint: { version: row.fingerprintVersion, digest: new Uint8Array(row.fingerprint) },
        result: row.result as JsonValue,
        resourceType: row.resourceType,
        resourceId: parseUuid(row.resourceId),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      } satisfies UserIdempotencyRecord);
    },

    async insert(scope, record) {
      const result = encodedIdempotencyResult(record.result);
      try {
        const inserted = await transactionClient(scope).$executeRaw`
          INSERT INTO user_idempotency_records (
            user_id, id, actor_type, actor_id, operation, idempotency_key, fingerprint, fingerprint_version,
            result, resource_type, resource_id, created_at, expires_at)
          VALUES (
            ${record.userId}::uuid, ${record.id}::uuid, 'user', ${record.userId}, ${record.operation},
            ${record.idempotencyKey}::uuid, ${record.fingerprint.digest}, ${record.fingerprint.version},
            ${result}::json, ${record.resourceType}, ${record.resourceId}::uuid,
            ${record.createdAt.toISOString()}::timestamptz, ${record.expiresAt.toISOString()}::timestamptz)
          ON CONFLICT (user_id, idempotency_key) DO NOTHING`;
        return inserted === 1 ? "inserted" : "duplicate";
      } catch (error) {
        if (isLockNotAvailable(error)) throw new IdempotencyInProgressError(undefined, { cause: error });
        throw error;
      }
    },
  };
}
