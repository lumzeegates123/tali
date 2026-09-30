import type { IdGenerator } from "@tali/application";
import type { Id } from "@tali/domain";
import { parseId } from "@tali/domain";
import { v7 } from "uuid";

/** Thrown instead of ever generating an identifier from insecure randomness (ADR-002 section 14). */
export class SecureRandomUnavailableError extends Error {
  constructor() {
    super("crypto.getRandomValues is unavailable; refusing to generate a UUIDv7 without a secure random source");
    this.name = "SecureRandomUnavailableError";
  }
}

/**
 * The server IdGenerator: uuid@14 `v7()` in its default mode, the
 * implementation selected by the UUIDv7 cross-runtime spike
 * (docs/audits/uuidv7-cross-runtime-spike.md). Module-level monotonic state
 * over Web Crypto `getRandomValues`; options are never passed, because any
 * option bypasses the monotonic state. The embedded timestamp is ordering
 * metadata only, never business time.
 */
export const uuidV7IdGenerator: IdGenerator = {
  newId<Entity extends string>(entity: Entity): Id<Entity> {
    const webCrypto = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
    if (typeof webCrypto?.getRandomValues !== "function") throw new SecureRandomUnavailableError();
    return parseId(entity, v7());
  },
};
