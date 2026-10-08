import type { AuditFields } from "./audit-payload.js";
import { AuditPayloadError, validateAuditFields } from "./audit-payload.js";

/**
 * Which audit stream an action belongs to (ADR-004 section 8.1): business
 * events carry a business; platform events concern a user's platform
 * identity and carry no business.
 */
export type AuditStream = "business" | "platform";

export type AuditEntityType =
  | "user"
  | "external_identity"
  | "business"
  | "location"
  | "membership"
  | "invitation"
  | "device"
  | "product"
  | "product_category"
  | "product_pack"
  | "inventory_opening_batch"
  | "goods_receipt"
  | "inventory_adjustment"
  | "inventory_stock_threshold";

export interface AuditActionDefinition<
  Stream extends AuditStream = AuditStream,
  Fields extends AuditFields = AuditFields,
> {
  readonly name: string;
  readonly stream: Stream;
  readonly entityType: AuditEntityType;
  readonly payloadSchemaVersion: number;
  readonly fields: Fields;
}

const ACTION_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** Defines one audit action with its bounded payload (ADR-004 section 8.3 as amended by ADR-006). */
export function defineAuditAction<const Stream extends AuditStream, const Fields extends AuditFields>(definition: {
  readonly name: string;
  readonly stream: Stream;
  readonly entityType: AuditEntityType;
  readonly payloadSchemaVersion: number;
  readonly fields: Fields;
}): AuditActionDefinition<Stream, Fields> {
  if (!ACTION_NAME.test(definition.name)) {
    throw new AuditPayloadError(`audit action "${definition.name}" must look like "entity.event"`);
  }
  if (!Number.isSafeInteger(definition.payloadSchemaVersion) || definition.payloadSchemaVersion < 1) {
    throw new AuditPayloadError(`audit action "${definition.name}" needs a positive payloadSchemaVersion`);
  }
  validateAuditFields(definition.fields);
  return Object.freeze({ ...definition, fields: Object.freeze({ ...definition.fields }) });
}

/** The code-defined registry of approved audit actions. */
export interface AuditRegistry {
  readonly actions: readonly AuditActionDefinition[];
  /** True only for this exact registered definition. */
  has(action: AuditActionDefinition): boolean;
}

export function defineAuditRegistry(actions: readonly AuditActionDefinition[]): AuditRegistry {
  const byName = new Map<string, AuditActionDefinition>();
  for (const action of actions) {
    if (byName.has(action.name)) throw new AuditPayloadError(`audit action "${action.name}" is registered twice`);
    byName.set(action.name, action);
  }
  const frozen = Object.freeze([...actions]);
  return Object.freeze({
    actions: frozen,
    has: (action: AuditActionDefinition) => byName.get(action.name) === action,
  });
}
