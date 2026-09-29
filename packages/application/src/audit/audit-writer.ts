import type { BusinessId, Id, LocationId, UserId, Uuid } from "@tali/domain";
import type { Actor, CorrelationId, DeviceId, SourceChannel, SystemActor } from "../context/business-context.js";
import type { IdempotencyKey } from "../idempotency/idempotency-key.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { AuditEntityType } from "./audit-action.js";
import type { AuditPayload } from "./audit-payload.js";

export type AuditRecordId = Id<"AuditRecord">;

/** The envelope shared by both audit tables (ADR-004 section 8.2). */
interface AuditRecordEnvelope {
  readonly id: AuditRecordId;
  readonly occurredAt: Date;
  readonly action: string;
  readonly entityType: AuditEntityType;
  readonly entityId: Uuid;
  readonly sourceChannel: SourceChannel;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly reason?: string;
  readonly payload: AuditPayload;
  readonly payloadSchemaVersion: number;
}

/** A change to a business (`business_audit_records`, non-null business_id). */
export interface BusinessAuditRecord extends AuditRecordEnvelope {
  readonly businessId: BusinessId;
  /** A user actor always carries the membership it acted through. */
  readonly actor: Actor;
  readonly deviceId?: DeviceId;
  readonly locationId?: LocationId;
}

/** A user acting on their own platform identity, before or outside any business. */
export interface PlatformUserActor {
  readonly type: "user";
  readonly userId: UserId;
}

/** A change to a user's platform identity (`platform_audit_records`, no business). */
export interface PlatformAuditRecord extends AuditRecordEnvelope {
  readonly subjectUserId: UserId;
  readonly actor: PlatformUserActor | SystemActor;
}

/**
 * Persists validated audit records inside the current transaction, so they
 * commit or roll back with the mutation (ADR-004 sections 8.1 and 9). Records
 * reach this port only through AuditRecorder, which validates them first.
 */
export interface AuditWriter {
  recordBusinessEvent(scope: TransactionScope, record: BusinessAuditRecord): Promise<void>;
  recordPlatformEvent(scope: TransactionScope, record: PlatformAuditRecord): Promise<void>;
}
