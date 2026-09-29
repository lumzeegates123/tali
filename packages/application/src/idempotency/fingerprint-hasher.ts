import type { CanonicalCommand } from "./canonical-command.js";

/** The stored command fingerprint: SHA-256 (32 bytes) with its fingerprint version (ADR-004 section 5). */
export interface CommandFingerprint {
  readonly version: number;
  readonly digest: Uint8Array;
}

/**
 * Computes the command fingerprint from the semantic canonical representation.
 * The real adapter (packages/integrations, plan 003 section 13.3) frames the
 * representation as UTF-8 with explicit byte lengths, orders set elements by
 * their encoded bytes and computes SHA-256. The application layer never
 * encodes bytes or hashes.
 */
export interface FingerprintHasher {
  fingerprint(command: CanonicalCommand): Promise<CommandFingerprint>;
}

export function sameFingerprint(a: CommandFingerprint, b: CommandFingerprint): boolean {
  if (a.version !== b.version || a.digest.length !== b.digest.length) return false;
  return a.digest.every((byte, index) => byte === b.digest[index]);
}
