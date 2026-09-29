import { BusinessDate } from "@tali/domain";

/**
 * The semantic canonical representation of a validated command (ADR-004
 * section 5, version 1). This layer owns the semantic rules: type tags, key
 * order, absent versus null, exact integers, instants, business dates, array
 * order, declared sets and NFC. It does not encode bytes: UTF-8 framing with
 * explicit byte lengths, byte-order sorting of set elements and SHA-256 are
 * done by the FingerprintHasher adapter (plan 003 sections 13.2 and 13.3).
 */
export const CANONICAL_FINGERPRINT_VERSION = 1;

export type CanonicalValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "enum"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "integer"; readonly type: "safe-integer" | "bigint"; readonly digits: string }
  | { readonly kind: "instant"; readonly value: string }
  | { readonly kind: "business-date"; readonly value: string }
  /** Order is significant and preserved. */
  | { readonly kind: "array"; readonly items: readonly CanonicalValue[] }
  /** Unordered: the items are listed in input order, and the adapter orders them by encoded bytes. */
  | { readonly kind: "set"; readonly items: readonly CanonicalValue[] }
  | CanonicalObject;

export interface CanonicalObject {
  readonly kind: "object";
  /** Sorted by Unicode code point of the key; absent keys omitted. */
  readonly entries: readonly { readonly key: string; readonly value: CanonicalValue }[];
}

export interface CanonicalCommand {
  readonly fingerprintVersion: typeof CANONICAL_FINGERPRINT_VERSION;
  readonly operation: string;
  readonly commandSchemaVersion: number;
  readonly command: CanonicalObject;
}

/** Thrown for a command value the encoding rules do not allow. It indicates a programming error. */
export class CanonicalEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalEncodingError";
  }
}

class EnumLiteral {
  constructor(readonly value: string) {
    Object.freeze(this);
  }
}

class SetValue {
  constructor(readonly items: readonly CommandValue[]) {
    Object.freeze(this);
  }
}

/** A command value accepted by the encoder: validated, normalized application values only. */
export type CommandValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | Date
  | BusinessDate
  | EnumLiteral
  | SetValue
  | readonly CommandValue[]
  | { readonly [key: string]: CommandValue | undefined };

export type CommandObject = { readonly [key: string]: CommandValue | undefined };

const LITERAL_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const OPERATION = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*\.v[1-9][0-9]*$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Marks an enum value, encoded as a literal token (rule 8). */
export function canonicalEnum(value: string): EnumLiteral {
  if (!LITERAL_TOKEN.test(value)) throw new CanonicalEncodingError(`"${value}" is not a literal token`);
  return new EnumLiteral(value);
}

/** Marks a field whose schema declares set semantics (rule 9). Duplicate elements are rejected. */
export function canonicalSet(items: readonly CommandValue[]): SetValue {
  return new SetValue(Object.freeze([...items]));
}

function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function text(value: string, where: string): string {
  if (LONE_SURROGATE.test(value)) throw new CanonicalEncodingError(`${where} is not well-formed Unicode`);
  return value.normalize("NFC");
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeObject(value: CommandObject, where: string): CanonicalObject {
  const entries = new Map<string, CanonicalValue>();
  for (const [rawKey, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    const key = text(rawKey, `${where} key`);
    if (entries.has(key)) throw new CanonicalEncodingError(`${where} has duplicate key "${key}" after NFC`);
    entries.set(key, encodeValue(raw, `${where}.${key}`));
  }
  const sorted = [...entries.entries()].sort(([a], [b]) => compareCodePoints(a, b));
  return Object.freeze({
    kind: "object",
    entries: Object.freeze(sorted.map(([key, item]) => Object.freeze({ key, value: item }))),
  });
}

function encodeValue(value: CommandValue, where: string): CanonicalValue {
  if (value === null) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (typeof value === "string") return { kind: "string", value: text(value, where) };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new CanonicalEncodingError(`${where} must be a safe integer (not -0, not fractional)`);
    }
    return { kind: "integer", type: "safe-integer", digits: String(value) };
  }
  if (typeof value === "bigint") return { kind: "integer", type: "bigint", digits: value.toString() };
  if (value instanceof Date) {
    const iso = Number.isNaN(value.getTime()) ? "" : value.toISOString();
    if (!INSTANT.test(iso)) throw new CanonicalEncodingError(`${where} is not a representable instant`);
    return { kind: "instant", value: iso };
  }
  if (value instanceof BusinessDate) return { kind: "business-date", value: value.toString() };
  if (value instanceof EnumLiteral) return { kind: "enum", value: value.value };
  if (value instanceof SetValue) {
    const items: CanonicalValue[] = [];
    for (const [index, item] of value.items.entries()) {
      const encoded = encodeValue(item, `${where}[${index}]`);
      if (items.some((existing) => canonicalValuesEqual(existing, encoded))) {
        throw new CanonicalEncodingError(`${where} is a set with a duplicate element`);
      }
      items.push(encoded);
    }
    return Object.freeze({ kind: "set", items: Object.freeze(items) });
  }
  if (Array.isArray(value)) {
    const list = value as readonly CommandValue[];
    return Object.freeze({
      kind: "array",
      items: Object.freeze(list.map((item, index) => encodeValue(item, `${where}[${index}]`))),
    });
  }
  if (typeof value === "object" && isPlainObject(value)) {
    return encodeObject(value as CommandObject, where);
  }
  throw new CanonicalEncodingError(`${where} has a type the canonical encoding does not allow`);
}

/**
 * Builds the canonical representation of a validated, normalized command.
 * `operation` (versioned, e.g. "business.create.v1") and
 * `commandSchemaVersion` head the representation. Correlation IDs, the
 * idempotency key and transport metadata are never part of `command`.
 */
export function canonicalCommandEncoding(input: {
  readonly operation: string;
  readonly commandSchemaVersion: number;
  readonly command: CommandObject;
}): CanonicalCommand {
  if (!OPERATION.test(input.operation)) {
    throw new CanonicalEncodingError(`operation "${input.operation}" must be versioned, e.g. "business.create.v1"`);
  }
  if (!Number.isSafeInteger(input.commandSchemaVersion) || input.commandSchemaVersion < 1) {
    throw new CanonicalEncodingError("commandSchemaVersion must be a positive integer");
  }
  if (typeof input.command !== "object" || Array.isArray(input.command) || !isPlainObject(input.command)) {
    throw new CanonicalEncodingError("command must be a plain object");
  }
  return Object.freeze({
    fingerprintVersion: CANONICAL_FINGERPRINT_VERSION,
    operation: input.operation,
    commandSchemaVersion: input.commandSchemaVersion,
    command: encodeObject(input.command, "command"),
  });
}

/** Semantic equality: arrays compare in order, sets regardless of order. */
export function canonicalValuesEqual(a: CanonicalValue, b: CanonicalValue): boolean {
  switch (a.kind) {
    case "null":
      return b.kind === "null";
    case "boolean":
    case "enum":
    case "string":
    case "instant":
    case "business-date":
      return b.kind === a.kind && b.value === a.value;
    case "integer":
      return b.kind === "integer" && b.type === a.type && b.digits === a.digits;
    case "array":
      return (
        b.kind === "array" &&
        b.items.length === a.items.length &&
        a.items.every((item, index) => {
          const other = b.items[index];
          return other !== undefined && canonicalValuesEqual(item, other);
        })
      );
    case "set": {
      if (b.kind !== "set" || b.items.length !== a.items.length) return false;
      const unmatched = [...b.items];
      for (const item of a.items) {
        const index = unmatched.findIndex((candidate) => canonicalValuesEqual(item, candidate));
        if (index === -1) return false;
        unmatched.splice(index, 1);
      }
      return true;
    }
    case "object":
      return (
        b.kind === "object" &&
        b.entries.length === a.entries.length &&
        a.entries.every((entry, index) => {
          const other = b.entries[index];
          return other !== undefined && other.key === entry.key && canonicalValuesEqual(entry.value, other.value);
        })
      );
  }
}

export function canonicalCommandsEqual(a: CanonicalCommand, b: CanonicalCommand): boolean {
  return (
    a.operation === b.operation &&
    a.commandSchemaVersion === b.commandSchemaVersion &&
    canonicalValuesEqual(a.command, b.command)
  );
}
