import type { Id } from "@tali/domain/kernel";
import { parseId } from "@tali/domain/kernel";
import { v7 } from "uuid";

/** Thrown instead of ever generating an identifier from insecure randomness (ADR-002 section 14). */
export class SecureRandomUnavailableError extends Error {
  constructor() {
    super("crypto.getRandomValues is unavailable; refusing to generate a UUIDv7 without a secure random source");
    this.name = "SecureRandomUnavailableError";
  }
}

/**
 * UUIDv7 via uuid@14 `v7()` in its default mode, the same library and
 * semantics as web and Node.js: module-level monotonic state (RFC 9562 method
 * 1) over `crypto.getRandomValues`, installed from expo-crypto on Hermes by
 * `installSecureRandom`. Options are never passed, because passing any option
 * bypasses the monotonic state. The embedded timestamp is ordering metadata
 * only, never business time.
 */
export function newUuidV7(): string {
  const webCrypto = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof webCrypto?.getRandomValues !== "function") {
    throw new SecureRandomUnavailableError();
  }
  return v7();
}

/** Client-side record identities (e.g. future offline capture); structurally the application IdGenerator port. */
export const uuidV7IdGenerator = {
  newId<Entity extends string>(entity: Entity): Id<Entity> {
    return parseId(entity, newUuidV7());
  },
};
