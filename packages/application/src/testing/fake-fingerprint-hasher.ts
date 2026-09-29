import type { CanonicalCommand } from "../idempotency/canonical-command.js";
import { canonicalCommandsEqual } from "../idempotency/canonical-command.js";
import type { CommandFingerprint, FingerprintHasher } from "../idempotency/fingerprint-hasher.js";

const DIGEST_LENGTH = 32;
const MARKER = [0x46, 0x41, 0x4b, 0x45];

/**
 * A deterministic, non-cryptographic FingerprintHasher for tests. It assigns
 * each semantically distinct canonical command a sequence number, so equal
 * commands (including sets in a different order) get equal fingerprints and
 * different commands get different ones. The digest is a 32-byte marker
 * pattern, not a hash; the real SHA-256 adapter lives in packages/integrations.
 */
export class FakeFingerprintHasher implements FingerprintHasher {
  readonly calls: CanonicalCommand[] = [];
  readonly #seen: CanonicalCommand[] = [];

  async fingerprint(command: CanonicalCommand): Promise<CommandFingerprint> {
    this.calls.push(command);
    let index = this.#seen.findIndex((seen) => canonicalCommandsEqual(seen, command));
    if (index === -1) {
      this.#seen.push(command);
      index = this.#seen.length - 1;
    }
    const digest = new Uint8Array(DIGEST_LENGTH);
    digest.set(MARKER, 0);
    digest[DIGEST_LENGTH - 4] = (index >>> 24) & 0xff;
    digest[DIGEST_LENGTH - 3] = (index >>> 16) & 0xff;
    digest[DIGEST_LENGTH - 2] = (index >>> 8) & 0xff;
    digest[DIGEST_LENGTH - 1] = index & 0xff;
    return { version: command.fingerprintVersion, digest };
  }
}
