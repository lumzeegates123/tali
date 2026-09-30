import type { CanonicalCommand } from "@tali/application";
import { BusinessDate } from "@tali/domain";

/**
 * Fingerprint framing version 1: the byte encoding of a canonical command
 * that is hashed with SHA-256. Normative specification and test vectors:
 * packages/application/src/idempotency/fingerprint-framing-v1.md.
 *
 * frame  = "TFP" 0x01, string(operation), safe-integer(commandSchemaVersion), object(command)
 * value  = tag byte, then its payload; every length and count is an unsigned 32-bit big-endian integer
 * text   = UTF-8 bytes of NFC text, preceded by their byte length
 * object = count, then per entry: key text, value; keys strictly increasing in UTF-8 byte order
 * set    = count, then the element encodings sorted by unsigned byte order
 */
export const FINGERPRINT_FRAMING_VERSION = 1;

const MAGIC = [0x54, 0x46, 0x50] as const;

const TAG = {
  null: 0x4e,
  boolean: 0x42,
  enum: 0x45,
  string: 0x53,
  safeInteger: 0x49,
  bigint: 0x47,
  instant: 0x44,
  businessDate: 0x59,
  array: 0x41,
  set: 0x55,
  object: 0x4f,
} as const;

const MAX_DEPTH = 32;
const MAX_U32 = 0xffff_ffff;
const MAX_BIGINT_DIGITS = 1024;
const INTEGER_DIGITS = /^(0|-?[1-9][0-9]*)$/;
const ENUM_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A canonical command the version 1 framing does not define. It indicates a programming error. */
export class FingerprintFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FingerprintFramingError";
  }
}

const utf8 = new TextEncoder();

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new FingerprintFramingError("length or count exceeds the 32-bit frame limit");
  }
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Unsigned lexicographic byte order; a proper prefix sorts first. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function textBytes(value: unknown, where: string): Uint8Array {
  if (typeof value !== "string") throw new FingerprintFramingError(`${where} must be text`);
  if (LONE_SURROGATE.test(value)) throw new FingerprintFramingError(`${where} is not well-formed Unicode`);
  if (value.normalize("NFC") !== value) throw new FingerprintFramingError(`${where} is not NFC`);
  const bytes = utf8.encode(value);
  return concat([u32(bytes.length), bytes]);
}

function asciiBytes(value: string): Uint8Array {
  const bytes = utf8.encode(value);
  return concat([u32(bytes.length), bytes]);
}

function tagged(tag: number, payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), payload]);
}

function integerDigits(value: unknown, type: unknown, where: string): Uint8Array {
  if (typeof value !== "string" || !INTEGER_DIGITS.test(value)) {
    throw new FingerprintFramingError(`${where} has malformed integer digits`);
  }
  if (type === "safe-integer") {
    if (!Number.isSafeInteger(Number(value))) throw new FingerprintFramingError(`${where} is not a safe integer`);
    return tagged(TAG.safeInteger, asciiBytes(value));
  }
  if (type === "bigint") {
    if (value.length > MAX_BIGINT_DIGITS) throw new FingerprintFramingError(`${where} has too many digits`);
    return tagged(TAG.bigint, asciiBytes(value));
  }
  throw new FingerprintFramingError(`${where} has an unknown integer type`);
}

function businessDate(value: unknown, where: string): Uint8Array {
  const valid = typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && isCalendarDate(value);
  if (!valid) throw new FingerprintFramingError(`${where} is not a business date`);
  return tagged(TAG.businessDate, asciiBytes(value));
}

function isCalendarDate(value: string): boolean {
  try {
    return BusinessDate.parse(value).toString() === value;
  } catch {
    return false;
  }
}

/**
 * The typed canonical model is not trusted at runtime: every field is read as
 * `unknown` and checked, so a value the framing does not define can never be
 * hashed by accident.
 */
type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(value: unknown, where: string): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FingerprintFramingError(`${where} is not a value`);
  }
  return value as Fields;
}

function list(items: unknown, where: string, depth: number): Uint8Array[] {
  if (!Array.isArray(items)) throw new FingerprintFramingError(`${where} must list its items`);
  return (items as readonly unknown[]).map((item, index) => encodeValue(item, `${where}[${index}]`, depth + 1));
}

function encodeObject(value: Fields, where: string, depth: number): Uint8Array {
  const entries: unknown = value["entries"];
  if (!Array.isArray(entries)) throw new FingerprintFramingError(`${where} must list its entries`);
  const parts: Uint8Array[] = [Uint8Array.of(TAG.object), u32(entries.length)];
  let previous: Uint8Array | undefined;
  for (const rawEntry of entries as readonly unknown[]) {
    const entry = fieldsOf(rawEntry, `${where} entry`);
    const key = textBytes(entry["key"], `${where} key`);
    const raw = key.subarray(4);
    if (previous !== undefined && compareBytes(previous, raw) >= 0) {
      throw new FingerprintFramingError(`${where} keys must be unique and in UTF-8 byte order`);
    }
    previous = raw;
    parts.push(key, encodeValue(entry["value"], `${where}.${String(entry["key"])}`, depth + 1));
  }
  return concat(parts);
}

function encodeValue(raw: unknown, where: string, depth: number): Uint8Array {
  if (depth > MAX_DEPTH) throw new FingerprintFramingError(`${where} is nested too deeply`);
  const value = fieldsOf(raw, where);
  const inner = value["value"];
  switch (value["kind"]) {
    case "null":
      return Uint8Array.of(TAG.null);
    case "boolean":
      if (typeof inner !== "boolean") throw new FingerprintFramingError(`${where} is not a boolean`);
      return Uint8Array.of(TAG.boolean, inner ? 0x01 : 0x00);
    case "enum":
      if (typeof inner !== "string" || !ENUM_TOKEN.test(inner)) {
        throw new FingerprintFramingError(`${where} is not a literal token`);
      }
      return tagged(TAG.enum, asciiBytes(inner));
    case "string":
      return tagged(TAG.string, textBytes(inner, where));
    case "integer":
      return integerDigits(value["digits"], value["type"], where);
    case "instant":
      if (typeof inner !== "string" || !INSTANT.test(inner)) {
        throw new FingerprintFramingError(`${where} is not a UTC instant`);
      }
      return tagged(TAG.instant, asciiBytes(inner));
    case "business-date":
      return businessDate(inner, where);
    case "array": {
      const items = list(value["items"], where, depth);
      return concat([Uint8Array.of(TAG.array), u32(items.length), ...items]);
    }
    case "set": {
      const items = list(value["items"], where, depth).sort(compareBytes);
      for (let index = 1; index < items.length; index += 1) {
        const [before, current] = [items[index - 1], items[index]];
        if (before !== undefined && current !== undefined && compareBytes(before, current) === 0) {
          throw new FingerprintFramingError(`${where} is a set with a duplicate element`);
        }
      }
      return concat([Uint8Array.of(TAG.set), u32(items.length), ...items]);
    }
    case "object":
      return encodeObject(value, where, depth);
    default:
      throw new FingerprintFramingError(`${where} has a kind the framing does not define`);
  }
}

/** The version 1 frame of a canonical command: the exact SHA-256 input. */
export function frameCanonicalCommandV1(command: CanonicalCommand): Uint8Array {
  const fields = fieldsOf(command, "command");
  if (fields["fingerprintVersion"] !== FINGERPRINT_FRAMING_VERSION) {
    throw new FingerprintFramingError("unsupported fingerprint version");
  }
  const schemaVersion = fields["commandSchemaVersion"];
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new FingerprintFramingError("commandSchemaVersion must be a positive integer");
  }
  const body = fieldsOf(fields["command"], "command");
  if (body["kind"] !== "object") throw new FingerprintFramingError("command must be an object");
  return concat([
    Uint8Array.of(...MAGIC, FINGERPRINT_FRAMING_VERSION),
    tagged(TAG.string, textBytes(fields["operation"], "operation")),
    tagged(TAG.safeInteger, asciiBytes(String(schemaVersion))),
    encodeObject(body, "command", 1),
  ]);
}
