import type {
  OneTimeSecret,
  OneTimeSecretGenerator,
  OneTimeSecretKind,
  SecretDigest,
  SecretHasher,
} from "../ports/one-time-secret.js";
import {
  ONE_TIME_SECRET_ENCODED_LENGTH,
  ONE_TIME_SECRET_PREFIXES,
  ONE_TIME_SECRET_RANDOM_BYTES,
  parseOneTimeSecret,
} from "../ports/one-time-secret.js";

/**
 * Deterministic one-time secrets for tests: the right format, predictable
 * content (a sequence number), never random. Every value it issues is kept in
 * `issued`, so tests can assert that no plaintext reached storage, audit
 * records, idempotency results or logs.
 */
export class FakeOneTimeSecretGenerator implements OneTimeSecretGenerator {
  readonly issued: OneTimeSecret[] = [];
  #sequence = 0;

  generate(kind: OneTimeSecretKind): OneTimeSecret {
    this.#sequence += 1;
    const body = `fake${this.#sequence.toString(36)}`.padEnd(ONE_TIME_SECRET_ENCODED_LENGTH - 1, "x");
    const secret = parseOneTimeSecret(kind, `${ONE_TIME_SECRET_PREFIXES[kind]}${body}A`);
    if (secret === undefined) throw new Error("fake secret has an invalid format");
    this.issued.push(secret);
    return secret;
  }
}

/**
 * A deterministic, non-cryptographic SecretHasher for tests (FNV-1a lanes over
 * the text). Never use outside tests; the SHA-256 adapter with constant-time
 * comparison lives in packages/integrations.
 */
export class FakeSecretHasher implements SecretHasher {
  digest(secret: OneTimeSecret): SecretDigest {
    const digest = new Uint8Array(ONE_TIME_SECRET_RANDOM_BYTES);
    for (let lane = 0; lane < ONE_TIME_SECRET_RANDOM_BYTES / 4; lane += 1) {
      let hash = (0x811c9dc5 ^ lane) >>> 0;
      for (let index = 0; index < secret.length; index += 1) {
        hash = Math.imul(hash ^ secret.charCodeAt(index), 0x01000193) >>> 0;
      }
      digest[lane * 4] = hash >>> 24;
      digest[lane * 4 + 1] = (hash >>> 16) & 0xff;
      digest[lane * 4 + 2] = (hash >>> 8) & 0xff;
      digest[lane * 4 + 3] = hash & 0xff;
    }
    return digest as SecretDigest;
  }

  matches(secret: OneTimeSecret, stored: SecretDigest): boolean {
    const computed = this.digest(secret);
    return computed.length === stored.length && computed.every((byte, index) => byte === stored[index]);
  }
}
