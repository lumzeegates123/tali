import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  OneTimeSecret,
  OneTimeSecretGenerator,
  OneTimeSecretKind,
  SecretDigest,
  SecretHasher,
} from "@tali/application";
import { ONE_TIME_SECRET_PREFIXES, ONE_TIME_SECRET_RANDOM_BYTES, parseOneTimeSecret } from "@tali/application";
import { sha256 } from "./sha256-fingerprint-hasher.js";

const DIGEST_BYTES = 32;

/**
 * One-time bearer secrets from node:crypto `randomBytes` (a CSPRNG that
 * throws rather than return weak output): the kind's prefix followed by 32
 * random bytes as unpadded base64url.
 */
export const nodeOneTimeSecretGenerator: OneTimeSecretGenerator = {
  generate(kind: OneTimeSecretKind): OneTimeSecret {
    const text = ONE_TIME_SECRET_PREFIXES[kind] + randomBytes(ONE_TIME_SECRET_RANDOM_BYTES).toString("base64url");
    const secret = parseOneTimeSecret(kind, text);
    if (secret === undefined) throw new Error("generated one-time secret does not match its format");
    return secret;
  },
};

/** SHA-256 digests of one-time secrets, verified with `timingSafeEqual`. */
export const sha256SecretHasher: SecretHasher = {
  digest(secret: OneTimeSecret): SecretDigest {
    return sha256(new TextEncoder().encode(secret)) as SecretDigest;
  },

  matches(secret: OneTimeSecret, stored: SecretDigest): boolean {
    const candidate = sha256(new TextEncoder().encode(secret));
    if (stored.byteLength !== DIGEST_BYTES) return false;
    return timingSafeEqual(candidate, stored);
  },
};
