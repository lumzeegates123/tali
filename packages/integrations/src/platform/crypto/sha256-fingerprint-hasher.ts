import { createHash } from "node:crypto";
import type { CanonicalCommand, CommandFingerprint, FingerprintHasher } from "@tali/application";
import { FINGERPRINT_FRAMING_VERSION, frameCanonicalCommandV1 } from "./fingerprint-framing.js";

/** SHA-256 from node:crypto; a fresh 32-byte copy per call. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/**
 * The production FingerprintHasher (ADR-004 section 5): SHA-256 over the
 * version 1 frame of the canonical command. Framing rejects any input it does
 * not define, so the promise rejects instead of producing a fingerprint.
 */
export class Sha256FingerprintHasher implements FingerprintHasher {
  async fingerprint(command: CanonicalCommand): Promise<CommandFingerprint> {
    return { version: FINGERPRINT_FRAMING_VERSION, digest: sha256(frameCanonicalCommandV1(command)) };
  }
}
