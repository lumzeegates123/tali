import type { BusinessId, DeviceId } from "@tali/domain";
import type { Actor, BusinessContext, CorrelationId, SourceChannel } from "../context/business-context.js";
import type { IdempotencyKey } from "../idempotency/idempotency-key.js";

export interface BusinessAuditEnvelope {
  readonly businessId: BusinessId;
  readonly actor: Actor;
  readonly sourceChannel: SourceChannel;
  readonly correlationId: CorrelationId;
  readonly deviceId?: DeviceId;
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * The audit envelope fields a business-scoped use case takes from its
 * context. The device appears only when the request's device headers were
 * verified (ADR-005 section 15.3); it is evidence, never the actor.
 */
export function businessAuditEnvelope(
  context: BusinessContext,
  idempotencyKey?: IdempotencyKey,
): BusinessAuditEnvelope {
  return {
    businessId: context.businessId,
    actor: context.actor,
    sourceChannel: context.sourceChannel,
    correlationId: context.correlationId,
    ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}
