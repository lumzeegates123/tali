import type { ExternalIdentityProvider } from "@tali/domain";
import { AuthenticationError } from "../errors/application-error.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityProvider, VerifiedIdentity } from "../ports/identity-provider.js";

/**
 * An identity provider for tests: tokens are opaque handles registered in
 * memory. It reports a real persisted provider category ("LOCAL" by default,
 * or "COGNITO" for Cognito-shaped tests) and never one of its own
 * (ADR-005 section 3).
 */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #clock: Clock;
  readonly #provider: ExternalIdentityProvider;
  readonly #tokens = new Map<string, VerifiedIdentity>();
  #counter = 0;

  constructor(clock: Clock, options: { provider?: ExternalIdentityProvider } = {}) {
    this.#clock = clock;
    this.#provider = options.provider ?? "LOCAL";
  }

  issueToken(subject: string, options: { ttlSeconds?: number; authTime?: Date } = {}): string {
    const issuedAt = this.#clock.now();
    const expiresAt = new Date(issuedAt.getTime() + (options.ttlSeconds ?? 3600) * 1000);
    const authTime = new Date((options.authTime ?? issuedAt).getTime());
    this.#counter += 1;
    const token = `fake-access-token-${this.#counter}`;
    this.#tokens.set(token, Object.freeze({ provider: this.#provider, subject, issuedAt, expiresAt, authTime }));
    return token;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    const identity = this.#tokens.get(token);
    if (identity === undefined) {
      throw new AuthenticationError("Invalid access token");
    }
    if (this.#clock.now().getTime() >= identity.expiresAt.getTime()) {
      throw new AuthenticationError("Access token expired");
    }
    return identity;
  }
}
