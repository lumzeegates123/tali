import { parseUuid } from "@tali/domain";

/**
 * The bounded, dependency-free audit payload definitions of ADR-006. They
 * check shape and bounds only: flat records of the field kinds below, with
 * no transforms, defaults or coercion. They are not a general validation
 * library and are used only for audit payloads.
 */

/** ADR-004 section 13: audit payload size limit. */
export const AUDIT_PAYLOAD_MAX_BYTES = 8192;

/** ADR-004 section 8.3: field names that could carry secrets are never allowed. */
export const SENSITIVE_FIELD_NAME = /token|secret|credential|password|hash|jwt/i;

const FIELD_NAME = /^[a-z][a-zA-Z0-9]{0,63}$/;
const ENUM_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const MAX_STRING_LENGTH = 1000;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

interface FieldBase {
  readonly optional: boolean;
}

export type AuditField =
  | (FieldBase & { readonly kind: "id" })
  | (FieldBase & { readonly kind: "string"; readonly maxLength: number })
  | (FieldBase & { readonly kind: "boolean" })
  | (FieldBase & { readonly kind: "enum"; readonly values: readonly string[] })
  | (FieldBase & { readonly kind: "integer"; readonly min: number; readonly max: number })
  | (FieldBase & { readonly kind: "instant" });

export type AuditFields = Readonly<Record<string, AuditField>>;

/** Thrown for invalid definitions and payloads. It fails the mutation; nothing is written. */
export class AuditPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditPayloadError";
  }
}

type RequiredField<F> = F & { readonly optional: false };

function definitionError(message: string): never {
  throw new AuditPayloadError(message);
}

/** Field kinds (ADR-006 section 3.1). */
export const auditField = {
  /** A UUID in lowercase canonical form, as typed IDs already are. */
  id: (): RequiredField<{ readonly kind: "id" }> => ({ kind: "id", optional: false }),
  /** A well-formed string of at most `maxLength` code points. */
  string: (maxLength: number): RequiredField<{ readonly kind: "string"; readonly maxLength: number }> => {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > MAX_STRING_LENGTH) {
      definitionError(`string maxLength must be 1 to ${MAX_STRING_LENGTH}`);
    }
    return { kind: "string", maxLength, optional: false };
  },
  boolean: (): RequiredField<{ readonly kind: "boolean" }> => ({ kind: "boolean", optional: false }),
  /** One of a closed list of literal values. */
  enumeration: <const V extends string>(
    values: readonly V[],
  ): RequiredField<{ readonly kind: "enum"; readonly values: readonly V[] }> => {
    if (values.length === 0 || new Set(values).size !== values.length || !values.every((v) => ENUM_VALUE.test(v))) {
      definitionError("enum values must be a non-empty list of distinct literal tokens");
    }
    return { kind: "enum", values: Object.freeze([...values]), optional: false };
  },
  /** A JavaScript safe integer within [min, max]. */
  integer: (
    min: number,
    max: number,
  ): RequiredField<{ readonly kind: "integer"; readonly min: number; readonly max: number }> => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      definitionError("integer bounds must be safe integers with min <= max");
    }
    return { kind: "integer", min, max, optional: false };
  },
  /** An ISO 8601 UTC instant with milliseconds and a Z suffix. */
  instant: (): RequiredField<{ readonly kind: "instant" }> => ({ kind: "instant", optional: false }),
  /** Marks a field as optional: it may be absent (never null). */
  optional: <F extends AuditField>(field: F): F & { readonly optional: true } => ({ ...field, optional: true }),
} as const;

type ValueOf<F> = F extends { readonly kind: "enum"; readonly values: readonly (infer V)[] }
  ? V
  : F extends { readonly kind: "boolean" }
    ? boolean
    : F extends { readonly kind: "integer" }
      ? number
      : string;

type OptionalKeys<Fields> = {
  [K in keyof Fields]: Fields[K] extends { readonly optional: true } ? K : never;
}[keyof Fields];
type RequiredKeys<Fields> = Exclude<keyof Fields, OptionalKeys<Fields>>;

/** The payload type a set of field definitions accepts. */
export type AuditPayloadOf<Fields> = { readonly [K in RequiredKeys<Fields>]: ValueOf<Fields[K]> } & {
  readonly [K in OptionalKeys<Fields>]?: ValueOf<Fields[K]>;
};

export type AuditPayloadValue = string | number | boolean;
export type AuditPayload = Readonly<Record<string, AuditPayloadValue>>;

/** Worst-case JSON-encoded UTF-8 size of a value, from declared bounds only (no encoding is performed). */
function worstCaseValueBytes(field: AuditField): number {
  switch (field.kind) {
    case "id":
      return 38;
    case "string":
      // Each code point is at most 6 bytes once JSON-escaped (\u00XX); plus quotes.
      return field.maxLength * 6 + 2;
    case "boolean":
      return 5;
    case "enum":
      return Math.max(...field.values.map((value) => value.length)) + 2;
    case "integer":
      return Math.max(String(field.min).length, String(field.max).length);
    case "instant":
      return 26;
  }
}

/** Validates field definitions and their worst-case size (ADR-006 section 3.2). */
export function validateAuditFields(fields: AuditFields): void {
  let worstCase = 2;
  for (const [name, field] of Object.entries(fields)) {
    if (!FIELD_NAME.test(name)) definitionError(`audit field "${name}" must be a camelCase identifier`);
    if (SENSITIVE_FIELD_NAME.test(name)) definitionError(`audit field "${name}" matches a sensitive-name pattern`);
    // "name": value, (ASCII field names)
    worstCase += name.length + 4 + worstCaseValueBytes(field);
  }
  if (worstCase > AUDIT_PAYLOAD_MAX_BYTES) {
    definitionError(`audit payload can exceed ${AUDIT_PAYLOAD_MAX_BYTES} bytes (worst case ${worstCase})`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalUuid(value: string): boolean {
  try {
    return parseUuid(value) === value;
  } catch {
    return false;
  }
}

function isValidInstant(value: string): boolean {
  if (!INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function checkValue(name: string, field: AuditField, value: unknown): AuditPayloadValue {
  const reject = (reason: string): never => {
    throw new AuditPayloadError(`audit field "${name}" ${reason}`);
  };
  switch (field.kind) {
    case "id":
      return typeof value === "string" && isCanonicalUuid(value) ? value : reject("must be a canonical UUID");
    case "string":
      if (typeof value !== "string" || LONE_SURROGATE.test(value)) return reject("must be well-formed text");
      return Array.from(value).length <= field.maxLength
        ? value
        : reject(`must be at most ${field.maxLength} characters`);
    case "boolean":
      return typeof value === "boolean" ? value : reject("must be a boolean");
    case "enum":
      return typeof value === "string" && field.values.includes(value) ? value : reject("is not an allowed value");
    case "integer":
      return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        !Object.is(value, -0) &&
        value >= field.min &&
        value <= field.max
        ? value
        : reject(`must be an integer from ${field.min} to ${field.max}`);
    case "instant":
      return typeof value === "string" && isValidInstant(value) ? value : reject("must be an ISO 8601 UTC instant");
  }
}

/**
 * Validates a payload against its fields at runtime: unknown fields,
 * missing required fields and out-of-bounds values are rejected. Values are
 * returned unchanged in a frozen copy.
 */
export function validateAuditPayload(fields: AuditFields, payload: unknown): AuditPayload {
  if (!isPlainObject(payload)) throw new AuditPayloadError("audit payload must be a plain object");
  for (const name of Object.keys(payload)) {
    if (!Object.hasOwn(fields, name)) throw new AuditPayloadError(`audit field "${name}" is not declared`);
  }
  const result: Record<string, AuditPayloadValue> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (!Object.hasOwn(payload, name)) {
      if (!field.optional) throw new AuditPayloadError(`audit field "${name}" is required`);
      continue;
    }
    result[name] = checkValue(name, field, payload[name]);
  }
  return Object.freeze(result);
}
