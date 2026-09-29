import type { Business, BusinessLocation } from "@tali/domain";
import { createDefaultLocation } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import type { Actor, CorrelationId, SourceChannel } from "../../context/business-context.js";
import type { IdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import { locationCreated } from "./audit-actions.js";
import type { LocationRepository } from "./ports.js";

export interface LocationAuditContext {
  readonly actor: Actor;
  readonly sourceChannel: SourceChannel;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * The location module's step in business creation (ADR-005 section 5): it
 * creates the business's single ACTIVE default location inside the caller's
 * transaction. It is not a standalone use case; Build 1 has no other way to
 * create locations.
 */
export interface DefaultLocationCreation {
  /** Decides the default location (pure; nothing is written). */
  prepare(business: Business, now: Date): BusinessLocation;
  insert(scope: TransactionScope, location: BusinessLocation): Promise<void>;
  recordCreated(scope: TransactionScope, location: BusinessLocation, audit: LocationAuditContext): Promise<void>;
}

export function createDefaultLocationCreation(dependencies: {
  readonly locations: LocationRepository;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
}): DefaultLocationCreation {
  return {
    prepare(business, now) {
      return createDefaultLocation({ id: dependencies.ids.newId("Location"), business, now });
    },
    async insert(scope, location) {
      await dependencies.locations.insert(scope, location);
    },
    async recordCreated(scope, location, audit) {
      await dependencies.audit.recordBusinessEvent(scope, locationCreated, {
        businessId: location.businessId,
        locationId: location.id,
        entityId: location.id,
        actor: audit.actor,
        sourceChannel: audit.sourceChannel,
        correlationId: audit.correlationId,
        ...(audit.idempotencyKey === undefined ? {} : { idempotencyKey: audit.idempotencyKey }),
        payload: { isDefault: location.isDefault, status: location.status },
      });
    },
  };
}
