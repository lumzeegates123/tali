/**
 * One-time bearer secrets: invitation tokens and device credentials (ADR-005
 * sections 14 and 15.2). The application owns the printable format; the
 * random source and the digest live behind these ports, implemented with
 * platform cryptography in packages/integrations. Plaintext secrets are never
 * persisted, logged, audited or stored in idempotency results.
 */
export type OneTimeSecretKind = "invitation" | "device";

/**
 * Fixed, non-secret, recognizable prefixes so secret scanners can find leaked
 * values. They add no secrecy and never reduce the random material.
 */
export const ONE_TIME_SECRET_PREFIXES: Readonly<Record<OneTimeSecretKind, string>> = Object.freeze({
  invitation: "tali_inv_",
  device: "tali_dev_",
});

/** 256 bits of random material, encoded as unpadded base64url (43 characters). */
export const ONE_TIME_SECRET_RANDOM_BYTES = 32;
export const ONE_TIME_SECRET_ENCODED_LENGTH = 43;

declare const oneTimeSecretBrand: unique symbol;
export type OneTimeSecret = string & { readonly [oneTimeSecretBrand]: true };

declare const secretDigestBrand: unique symbol;
/** The 32-byte SHA-256 digest of a secret's UTF-8 text; the only form ever stored. */
export type SecretDigest = Uint8Array & { readonly [secretDigestBrand]: true };

/** The last character of 32 bytes in unpadded base64url carries 2 zero bits; only these are canonical. */
const ENCODED = `[A-Za-z0-9_-]{${ONE_TIME_SECRET_ENCODED_LENGTH - 1}}[AEIMQUYcgkosw048]`;
const FORMATS: Readonly<Record<OneTimeSecretKind, RegExp>> = Object.freeze({
  invitation: new RegExp(`^${ONE_TIME_SECRET_PREFIXES.invitation}${ENCODED}$`),
  device: new RegExp(`^${ONE_TIME_SECRET_PREFIXES.device}${ENCODED}$`),
});

/** The secret when `value` has exactly the format of `kind`, otherwise undefined. Never throws with the value. */
export function parseOneTimeSecret(kind: OneTimeSecretKind, value: string): OneTimeSecret | undefined {
  return FORMATS[kind].test(value) ? (value as OneTimeSecret) : undefined;
}

export interface OneTimeSecretGenerator {
  /** A new secret of the given kind: its prefix followed by 32 bytes from a cryptographically secure source. */
  generate(kind: OneTimeSecretKind): OneTimeSecret;
}

export interface SecretHasher {
  /** SHA-256 of the secret's UTF-8 text. A keyed hash is not needed: the secret has 256 bits of entropy. */
  digest(secret: OneTimeSecret): SecretDigest;
  /**
   * Whether the secret's digest equals `stored`, compared in constant time
   * over equal-length digests (the device credential verifier of ADR-005
   * section 15.3).
   */
  matches(secret: OneTimeSecret, stored: SecretDigest): boolean;
}
