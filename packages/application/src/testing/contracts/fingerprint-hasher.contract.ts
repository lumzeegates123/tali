import { describe, expect, it } from "vitest";
import type { CanonicalCommand, CanonicalObject, CanonicalValue } from "../../idempotency/canonical-command.js";
import { canonicalCommandEncoding, canonicalSet } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { sameFingerprint } from "../../idempotency/fingerprint-hasher.js";
import { FINGERPRINT_V1_VECTORS } from "./fingerprint-vectors.js";

export interface FingerprintHasherContractSetup {
  readonly hasher: FingerprintHasher;
  /** The adapter's version 1 byte frame for a canonical command (the SHA-256 input). */
  readonly frame: (command: CanonicalCommand) => Uint8Array;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A hand-built canonical command, bypassing the semantic encoder, to prove the adapter's own checks. */
function raw(command: CanonicalObject, overrides: Partial<CanonicalCommand> = {}): CanonicalCommand {
  return { fingerprintVersion: 1, operation: "test.vector.v1", commandSchemaVersion: 1, command, ...overrides };
}

const single = (value: CanonicalValue): CanonicalObject => ({ kind: "object", entries: [{ key: "v", value }] });

/**
 * The FingerprintHasher contract (ADR-004 section 5; plan 003 section 13.3):
 * version 1 framing and SHA-256 must reproduce the application-owned vectors
 * byte for byte, and inputs the framing does not define are rejected.
 */
export function describeFingerprintHasherContract(name: string, setup: () => FingerprintHasherContractSetup): void {
  describe(`FingerprintHasher contract: ${name}`, () => {
    describe.each(FINGERPRINT_V1_VECTORS)("vector: $name", (entry) => {
      it("frames the command to the specified bytes", () => {
        expect(hex(setup().frame(entry.command()))).toBe(entry.frameHex);
      });

      it("fingerprints it to the specified SHA-256 digest with version 1", async () => {
        const fingerprint = await setup().hasher.fingerprint(entry.command());
        expect(fingerprint.version).toBe(1);
        expect(fingerprint.digest).toBeInstanceOf(Uint8Array);
        expect(fingerprint.digest).toHaveLength(32);
        expect(hex(fingerprint.digest)).toBe(entry.digestHex);
      });
    });

    it("gives equal fingerprints to semantically equal commands", async () => {
      const { hasher } = setup();
      const encode = (command: Parameters<typeof canonicalCommandEncoding>[0]["command"]) =>
        hasher.fingerprint(canonicalCommandEncoding({ operation: "test.vector.v1", commandSchemaVersion: 1, command }));
      expect(sameFingerprint(await encode({ a: "1", b: "2" }), await encode({ b: "2", a: "1" }))).toBe(true);
      expect(sameFingerprint(await encode({ s: "\u00E9" }), await encode({ s: "e\u0301" }))).toBe(true);
      expect(
        sameFingerprint(await encode({ s: canonicalSet(["A", "B"]) }), await encode({ s: canonicalSet(["B", "A"]) })),
      ).toBe(true);
      expect(sameFingerprint(await encode({}), await encode({ a: undefined }))).toBe(true);
    });

    it("distinguishes commands that differ in type, order, nullness, version or operation", async () => {
      const { hasher } = setup();
      const base = { operation: "test.vector.v1", commandSchemaVersion: 1 };
      const digests = await Promise.all(
        [
          canonicalCommandEncoding({ ...base, command: {} }),
          canonicalCommandEncoding({ ...base, command: { a: null } }),
          canonicalCommandEncoding({ ...base, command: { a: "1" } }),
          canonicalCommandEncoding({ ...base, command: { a: 1 } }),
          canonicalCommandEncoding({ ...base, command: { a: 1n } }),
          canonicalCommandEncoding({ ...base, command: { a: ["A", "B"] } }),
          canonicalCommandEncoding({ ...base, command: { a: ["B", "A"] } }),
          canonicalCommandEncoding({ ...base, command: { a: canonicalSet(["A", "B"]) } }),
          canonicalCommandEncoding({ ...base, commandSchemaVersion: 2, command: {} }),
          canonicalCommandEncoding({ ...base, operation: "test.other.v1", command: {} }),
        ].map(async (command) => hex((await hasher.fingerprint(command)).digest)),
      );
      expect(new Set(digests).size).toBe(digests.length);
    });

    it("returns a fresh digest that callers cannot use to corrupt later results", async () => {
      const { hasher } = setup();
      const command = FINGERPRINT_V1_VECTORS[0]?.command();
      if (command === undefined) throw new Error("missing vector");
      const first = await hasher.fingerprint(command);
      first.digest.fill(0);
      expect(hex((await hasher.fingerprint(command)).digest)).toBe(FINGERPRINT_V1_VECTORS[0]?.digestHex);
    });

    it.each([
      ["an unsupported fingerprint version", raw(single({ kind: "null" }), { fingerprintVersion: 2 as 1 })],
      ["a lone surrogate", raw(single({ kind: "string", value: "\uD800" }))],
      ["a string that is not NFC", raw(single({ kind: "string", value: "e\u0301" }))],
      ["a key that is not NFC", raw({ kind: "object", entries: [{ key: "e\u0301", value: { kind: "null" } }] })],
      [
        "object keys out of byte order",
        raw({
          kind: "object",
          entries: [
            { key: "b", value: { kind: "null" } },
            { key: "a", value: { kind: "null" } },
          ],
        }),
      ],
      [
        "a duplicate object key",
        raw({
          kind: "object",
          entries: [
            { key: "a", value: { kind: "null" } },
            { key: "a", value: { kind: "null" } },
          ],
        }),
      ],
      [
        "a duplicate set element",
        raw(
          single({
            kind: "set",
            items: [
              { kind: "string", value: "A" },
              { kind: "string", value: "A" },
            ],
          }),
        ),
      ],
      ["integer digits with a leading zero", raw(single({ kind: "integer", type: "safe-integer", digits: "01" }))],
      ["negative zero digits", raw(single({ kind: "integer", type: "bigint", digits: "-0" }))],
      ["non-integer digits", raw(single({ kind: "integer", type: "safe-integer", digits: "1.5" }))],
      [
        "a safe integer beyond 2^53 - 1",
        raw(single({ kind: "integer", type: "safe-integer", digits: "9007199254740992" })),
      ],
      ["a malformed instant", raw(single({ kind: "instant", value: "2026-09-29T08:00:00Z" }))],
      ["a malformed business date", raw(single({ kind: "business-date", value: "2026-9-29" }))],
      ["a malformed enum literal", raw(single({ kind: "enum", value: "not a token" }))],
      ["a malformed boolean", raw(single({ kind: "boolean", value: "yes" as unknown as boolean }))],
      ["an unknown value kind", raw(single({ kind: "float" } as unknown as CanonicalValue))],
      ["a non-positive command schema version", raw({ kind: "object", entries: [] }, { commandSchemaVersion: 0 })],
    ])("rejects %s", async (_label, command) => {
      const { hasher, frame } = setup();
      expect(() => frame(command)).toThrow();
      await expect(hasher.fingerprint(command)).rejects.toThrow();
    });
  });
}
