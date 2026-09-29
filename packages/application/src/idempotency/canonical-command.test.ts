import { BusinessDate } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { FakeFingerprintHasher } from "../testing/fake-fingerprint-hasher.js";
import type { CommandObject } from "./canonical-command.js";
import {
  CanonicalEncodingError,
  canonicalCommandEncoding,
  canonicalCommandsEqual,
  canonicalEnum,
  canonicalSet,
} from "./canonical-command.js";
import { sameFingerprint } from "./fingerprint-hasher.js";

const encode = (command: CommandObject, operation = "example.do.v1", commandSchemaVersion = 1) =>
  canonicalCommandEncoding({ operation, commandSchemaVersion, command });

const equal = (a: CommandObject, b: CommandObject) => canonicalCommandsEqual(encode(a), encode(b));

describe("canonical command representation", () => {
  it("heads the representation with the fingerprint version, operation and schema version", () => {
    const encoded = encode({ a: 1 });
    expect(encoded).toMatchObject({ fingerprintVersion: 1, operation: "example.do.v1", commandSchemaVersion: 1 });
  });

  it("orders object keys by code point, independent of insertion order", () => {
    expect(encode({ b: 1, a: 2, B: 3 }).command.entries.map((e) => e.key)).toEqual(["B", "a", "b"]);
    expect(equal({ b: 1, a: 2 }, { a: 2, b: 1 })).toBe(true);
  });

  it("orders keys outside the BMP by code point, not UTF-16 code unit", () => {
    // U+FF61 sorts before U+1F600 by code point, but after it by UTF-16 code unit.
    expect(encode({ "\u{1F600}": 1, "\uFF61": 2 }).command.entries.map((e) => e.key)).toEqual(["\uFF61", "\u{1F600}"]);
  });

  it("normalizes strings and keys to NFC", () => {
    expect(equal({ name: "Cafe\u0301" }, { name: "Café" })).toBe(true);
    expect(equal({ ["e\u0301"]: 1 }, { ["é"]: 1 })).toBe(true);
  });

  it("rejects keys that collide after NFC", () => {
    expect(() => encode({ ["e\u0301"]: 1, ["é"]: 2 })).toThrow(CanonicalEncodingError);
  });

  it("distinguishes an absent field from null", () => {
    expect(equal({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(equal({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  });

  it("keeps array order significant", () => {
    expect(equal({ list: [1, 2] }, { list: [2, 1] })).toBe(false);
    expect(encode({ list: [2, 1] }).command.entries[0]?.value).toEqual({
      kind: "array",
      items: [
        { kind: "integer", type: "safe-integer", digits: "2" },
        { kind: "integer", type: "safe-integer", digits: "1" },
      ],
    });
  });

  it("treats declared sets as unordered without sorting them", () => {
    expect(equal({ roles: canonicalSet(["b", "a"]) }, { roles: canonicalSet(["a", "b"]) })).toBe(true);
    const items = encode({ roles: canonicalSet(["b", "a"]) }).command.entries[0]?.value;
    expect(items).toMatchObject({ kind: "set", items: [{ value: "b" }, { value: "a" }] });
  });

  it("keeps a set distinct from an array with the same elements", () => {
    expect(equal({ roles: canonicalSet(["a"]) }, { roles: ["a"] })).toBe(false);
  });

  it("rejects duplicate set elements, including after NFC", () => {
    expect(() => encode({ roles: canonicalSet(["a", "a"]) })).toThrow(CanonicalEncodingError);
    expect(() => encode({ roles: canonicalSet(["Café", "Cafe\u0301"]) })).toThrow(CanonicalEncodingError);
  });

  it("distinguishes strings, enums, integers and bigints", () => {
    expect(equal({ v: "1" }, { v: 1 })).toBe(false);
    expect(equal({ v: 1 }, { v: 1n })).toBe(false);
    expect(equal({ v: "OWNER" }, { v: canonicalEnum("OWNER") })).toBe(false);
    expect(encode({ v: 12345678901234567890n }).command.entries[0]?.value).toEqual({
      kind: "integer",
      type: "bigint",
      digits: "12345678901234567890",
    });
  });

  it("encodes instants as UTC milliseconds and business dates as dates", () => {
    const encoded = encode({ at: new Date("2026-09-29T09:00:00+01:00"), on: BusinessDate.parse("2026-09-29") });
    expect(encoded.command.entries.map((e) => e.value)).toEqual([
      { kind: "instant", value: "2026-09-29T08:00:00.000Z" },
      { kind: "business-date", value: "2026-09-29" },
    ]);
  });

  it.each([
    ["a fractional number", { v: 1.5 }],
    ["negative zero", { v: -0 }],
    ["an unsafe integer", { v: 2 ** 53 }],
    ["an invalid date", { v: new Date(Number.NaN) }],
    ["a year beyond 9999", { v: new Date("+010000-01-01T00:00:00.000Z") }],
    ["a lone surrogate", { v: "\uD800" }],
    ["a class instance", { v: new Map() as unknown as CommandObject }],
  ])("rejects %s", (_name, command) => {
    expect(() => encode(command as CommandObject)).toThrow(CanonicalEncodingError);
  });

  it("rejects unversioned operations and invalid schema versions", () => {
    expect(() => encode({}, "example.do")).toThrow(CanonicalEncodingError);
    expect(() => encode({}, "example.do.v1", 0)).toThrow(CanonicalEncodingError);
  });

  it("separates operations and schema versions", () => {
    expect(canonicalCommandsEqual(encode({ a: 1 }, "example.do.v1"), encode({ a: 1 }, "example.do.v2"))).toBe(false);
    expect(canonicalCommandsEqual(encode({ a: 1 }, "example.do.v1", 1), encode({ a: 1 }, "example.do.v1", 2))).toBe(
      false,
    );
  });

  it("rejects enum literals that are not tokens", () => {
    expect(() => canonicalEnum("has space")).toThrow(CanonicalEncodingError);
  });
});

describe("FakeFingerprintHasher", () => {
  it("gives equal commands equal fingerprints and different commands different ones", async () => {
    const hasher = new FakeFingerprintHasher();
    const a = await hasher.fingerprint(encode({ roles: canonicalSet(["x", "y"]) }));
    const b = await hasher.fingerprint(encode({ roles: canonicalSet(["y", "x"]) }));
    const c = await hasher.fingerprint(encode({ roles: ["x", "y"] }));
    expect(a.digest).toHaveLength(32);
    expect(a.version).toBe(1);
    expect(sameFingerprint(a, b)).toBe(true);
    expect(sameFingerprint(a, c)).toBe(false);
    expect(hasher.calls).toHaveLength(3);
  });

  it("is deterministic across instances for the same sequence of commands", async () => {
    const first = await new FakeFingerprintHasher().fingerprint(encode({ a: 1 }));
    const second = await new FakeFingerprintHasher().fingerprint(encode({ a: 1 }));
    expect(sameFingerprint(first, second)).toBe(true);
  });
});
