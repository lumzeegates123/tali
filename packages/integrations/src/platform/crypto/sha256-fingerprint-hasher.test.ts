import { canonicalCommandEncoding } from "@tali/application";
import { describeFingerprintHasherContract } from "@tali/application/testing/contracts";
import { describe, expect, it } from "vitest";
import { FingerprintFramingError, frameCanonicalCommandV1 } from "./fingerprint-framing.js";
import { Sha256FingerprintHasher, sha256 } from "./sha256-fingerprint-hasher.js";

describeFingerprintHasherContract("Sha256FingerprintHasher", () => ({
  hasher: new Sha256FingerprintHasher(),
  frame: frameCanonicalCommandV1,
}));

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const ascii = (text: string) => new TextEncoder().encode(text);

describe("SHA-256 (FIPS 180-2 known-answer vectors)", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ])("hashes %j", (input, digest) => {
    expect(hex(sha256(ascii(input)))).toBe(digest);
  });
});

describe("fingerprint framing version 1", () => {
  it("rejects nesting beyond the depth bound", () => {
    let value: Record<string, unknown> = {};
    for (let depth = 0; depth < 40; depth += 1) value = { v: value };
    const command = canonicalCommandEncoding({
      operation: "test.vector.v1",
      commandSchemaVersion: 1,
      command: value as never,
    });
    expect(() => frameCanonicalCommandV1(command)).toThrow(FingerprintFramingError);
  });

  it("never serialises through JSON", () => {
    const stringify = JSON.stringify;
    JSON.stringify = () => {
      throw new Error("JSON.stringify must not be used for fingerprints");
    };
    try {
      const command = canonicalCommandEncoding({
        operation: "test.vector.v1",
        commandSchemaVersion: 1,
        command: { a: 1 },
      });
      expect(frameCanonicalCommandV1(command).length).toBeGreaterThan(0);
    } finally {
      JSON.stringify = stringify;
    }
  });
});
