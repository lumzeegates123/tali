import type { BusinessId, LocationId, UserId, Uuid } from "@tali/domain";
import type { Actor, CorrelationId, DeviceId, SourceChannel, SystemActor } from "../context/business-context.js";
import type { IdempotencyKey } from "../idempotency/idempotency-key.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { AuditActionDefinition, AuditRegistry } from "./audit-action.js";
import type { AuditFields, AuditPayloadOf } from "./audit-payload.js";
import { AuditPayloadError, validateAuditPayload } from "./audit-payload.js";
import type { AuditWriter, BusinessAuditRecord, PlatformAuditRecord, PlatformUserActor } from "./audit-writer.js";

/** ADR-004 section 13: audit reason length limit. */
export const AUDIT_REASON_MAX_LENGTH = 500;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface EventCommon<Fields extends AuditFields> {
  readonly entityId: Uuid;
  readonly sourceChannel: SourceChannel;
  readonly correlationId: CorrelationId;
  readonly payload: AuditPayloadOf<Fields>;
  readonly idempotencyKey?: IdempotencyKey;
  readonly reason?: string;
}

export interface BusinessAuditEvent<Fields extends AuditFields> extends EventCommon<Fields> {
  readonly businessId: BusinessId;
  readonly actor: Actor;
  readonly deviceId?: DeviceId;
  readonly locationId?: LocationId;
}

export interface PlatformAuditEvent<Fields extends AuditFields> extends EventCommon<Fields> {
  readonly subjectUserId: UserId;
  readonly actor: PlatformUserActor | SystemActor;
}

/**
 * The single audit entry point for use cases. It accepts only registered
 * actions, validates the explicit payload built by the use case (there is no
 * way to pass an entity to be serialized) and routes the record to the
 * business or platform stream declared by the action.
 */
export class AuditRecorder {
  readonly #registry: AuditRegistry;
  readonly #writer: AuditWriter;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(dependencies: {
    readonly registry: AuditRegistry;
    readonly writer: AuditWriter;
    readonly clock: Clock;
    readonly ids: IdGenerator;
  }) {
    this.#registry = dependencies.registry;
    this.#writer = dependencies.writer;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
  }

  async recordBusinessEvent<Fields extends AuditFields>(
    scope: TransactionScope,
    action: AuditActionDefinition<"business", Fields>,
    event: BusinessAuditEvent<Fields>,
  ): Promise<void> {
    this.#requireRegistered(action, "business");
    const record: BusinessAuditRecord = {
      ...this.#envelope(action, event),
      businessId: event.businessId,
      actor: event.actor,
      ...(event.deviceId === undefined ? {} : { deviceId: event.deviceId }),
      ...(event.locationId === undefined ? {} : { locationId: event.locationId }),
    };
    await this.#writer.recordBusinessEvent(scope, Object.freeze(record));
  }

  async recordPlatformEvent<Fields extends AuditFields>(
    scope: TransactionScope,
    action: AuditActionDefinition<"platform", Fields>,
    event: PlatformAuditEvent<Fields>,
  ): Promise<void> {
    this.#requireRegistered(action, "platform");
    const record: PlatformAuditRecord = {
      ...this.#envelope(action, event),
      subjectUserId: event.subjectUserId,
      actor: event.actor,
    };
    await this.#writer.recordPlatformEvent(scope, Object.freeze(record));
  }

  #requireRegistered(action: AuditActionDefinition, stream: "business" | "platform"): void {
    if (!this.#registry.has(action)) {
      throw new AuditPayloadError(`audit action "${action.name}" is not registered`);
    }
    if (action.stream !== stream) {
      throw new AuditPayloadError(`audit action "${action.name}" belongs to the ${action.stream} stream`);
    }
  }

  #envelope<Fields extends AuditFields>(
    action: AuditActionDefinition<"business" | "platform", Fields>,
    event: EventCommon<Fields>,
  ) {
    const payload = validateAuditPayload(action.fields, event.payload);
    if (event.reason !== undefined) {
      const length = Array.from(event.reason).length;
      if (LONE_SURROGATE.test(event.reason) || event.reason.trim().length === 0 || length > AUDIT_REASON_MAX_LENGTH) {
        throw new AuditPayloadError(
          `audit reason must be non-blank text of at most ${AUDIT_REASON_MAX_LENGTH} characters`,
        );
      }
    }
    return {
      id: this.#ids.newId("AuditRecord"),
      occurredAt: this.#clock.now(),
      action: action.name,
      entityType: action.entityType,
      entityId: event.entityId,
      sourceChannel: event.sourceChannel,
      correlationId: event.correlationId,
      ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      payload,
      payloadSchemaVersion: action.payloadSchemaVersion,
    };
  }
}
