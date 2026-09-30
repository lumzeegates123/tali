import type { Actor, AuditWriter, BusinessAuditRecord, PlatformAuditRecord } from "@tali/application";
import { AUDIT_PAYLOAD_MAX_BYTES } from "@tali/application";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

interface ActorColumns {
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly actorMembershipId: string | null;
  readonly actorName: string | null;
}

function actorColumns(actor: Actor): ActorColumns {
  switch (actor.type) {
    case "user":
      return { actorType: "user", actorUserId: actor.userId, actorMembershipId: actor.membershipId, actorName: null };
    case "system":
      return { actorType: "system", actorUserId: null, actorMembershipId: null, actorName: actor.process };
    case "integration":
      return { actorType: "integration", actorUserId: null, actorMembershipId: null, actorName: actor.provider };
  }
}

function platformActorColumns(actor: PlatformAuditRecord["actor"]): Omit<ActorColumns, "actorMembershipId"> {
  return actor.type === "user"
    ? { actorType: "user", actorUserId: actor.userId, actorName: null }
    : { actorType: "system", actorUserId: null, actorName: actor.process };
}

/**
 * The payload as stored: compact JSON in a `json` column, which keeps the
 * exact text, so this byte count is what the database CHECK measures.
 */
function encodedPayload(record: BusinessAuditRecord | PlatformAuditRecord): string {
  const encoded = JSON.stringify(record.payload);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > AUDIT_PAYLOAD_MAX_BYTES) {
    throw new Error(`audit payload for ${record.action} is ${bytes} bytes; the limit is ${AUDIT_PAYLOAD_MAX_BYTES}`);
  }
  return encoded;
}

/**
 * Writes validated audit records (AuditRecorder validates them first) into
 * the current transaction (ADR-004 section 8.1): business events go to
 * `business_audit_records`, platform events to `platform_audit_records`.
 * Insert-only: the application role has no UPDATE or DELETE on either table.
 */
export function createAuditWriter(): AuditWriter {
  return {
    async recordBusinessEvent(scope, record) {
      const payload = encodedPayload(record);
      const actor = actorColumns(record.actor);
      await transactionClient(scope).$executeRaw`
        INSERT INTO business_audit_records (
          business_id, id, occurred_at, action, entity_type, entity_id,
          actor_type, actor_user_id, actor_membership_id, actor_name, device_id, location_id,
          source_channel, correlation_id, idempotency_key, reason, payload, payload_schema_version)
        VALUES (
          ${record.businessId}::uuid, ${record.id}::uuid, ${record.occurredAt.toISOString()}::timestamptz,
          ${record.action}, ${record.entityType}, ${record.entityId}::uuid,
          ${actor.actorType}, ${actor.actorUserId}::uuid, ${actor.actorMembershipId}::uuid, ${actor.actorName},
          ${record.deviceId ?? null}::uuid, ${record.locationId ?? null}::uuid,
          ${record.sourceChannel}, ${record.correlationId}, ${record.idempotencyKey ?? null}::uuid,
          ${record.reason ?? null}, ${payload}::json, ${record.payloadSchemaVersion})`;
    },

    async recordPlatformEvent(scope, record) {
      const payload = encodedPayload(record);
      const actor = platformActorColumns(record.actor);
      await transactionClient(scope).$executeRaw`
        INSERT INTO platform_audit_records (
          id, occurred_at, action, entity_type, entity_id, subject_user_id,
          actor_type, actor_user_id, actor_name,
          source_channel, correlation_id, idempotency_key, reason, payload, payload_schema_version)
        VALUES (
          ${record.id}::uuid, ${record.occurredAt.toISOString()}::timestamptz,
          ${record.action}, ${record.entityType}, ${record.entityId}::uuid, ${record.subjectUserId}::uuid,
          ${actor.actorType}, ${actor.actorUserId}::uuid, ${actor.actorName},
          ${record.sourceChannel}, ${record.correlationId}, ${record.idempotencyKey ?? null}::uuid,
          ${record.reason ?? null}, ${payload}::json, ${record.payloadSchemaVersion})`;
    },
  };
}
