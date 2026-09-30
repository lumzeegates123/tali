import { createHash } from "node:crypto";
import type { SecretDigest } from "@tali/application";
import { parseOneTimeSecret } from "@tali/application";
import { describe, expect, it } from "vitest";
import { nodeOneTimeSecretGenerator, sha256SecretHasher } from "./node-one-time-secrets.js";

describe("nodeOneTimeSecretGenerator", () => {
  it.each([
    ["invitation", /^tali_inv_[A-Za-z0-9_-]{43}$/],
    ["device", /^tali_dev_[A-Za-z0-9_-]{43}$/],
  ] as const)("generates %s secrets in the canonical format", (kind, format) => {
    const secret = nodeOneTimeSecretGenerator.generate(kind);
    expect(secret).toMatch(format);
    expect(parseOneTimeSecret(kind, secret)).toBe(secret);
  });

  it("decodes to exactly 32 random bytes and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const secret = nodeOneTimeSecretGenerator.generate("device");
      expect(Buffer.from(secret.slice("tali_dev_".length), "base64url")).toHaveLength(32);
      seen.add(secret);
    }
    expect(seen.size).toBe(500);
  });
});

describe("sha256SecretHasher", () => {
  const secret = nodeOneTimeSecretGenerator.generate("invitation");

  it("digests the UTF-8 secret text with SHA-256", () => {
    const expected = createHash("sha256").update(secret, "utf8").digest();
    const digest = sha256SecretHasher.digest(secret);
    expect(digest).toHaveLength(32);
    expect(Buffer.from(digest).equals(expected)).toBe(true);
    expect(Buffer.from(digest).toString("latin1")).not.toContain(secret);
  });

  it("matches only the original secret", () => {
    const stored = sha256SecretHasher.digest(secret);
    expect(sha256SecretHasher.matches(secret, stored)).toBe(true);
    expect(sha256SecretHasher.matches(nodeOneTimeSecretGenerator.generate("invitation"), stored)).toBe(false);
  });

  it("returns false instead of throwing for a stored digest of the wrong length", () => {
    const short = new Uint8Array(31) as SecretDigest;
    const long = new Uint8Array(33) as SecretDigest;
    expect(sha256SecretHasher.matches(secret, short)).toBe(false);
    expect(sha256SecretHasher.matches(secret, long)).toBe(false);
  });
});
