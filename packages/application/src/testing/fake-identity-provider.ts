import { AuthenticationError } from "../errors/application-error.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityProvider, VerifiedIdentity } from "../ports/identity-provider.js";

/** An identity provider for tests: tokens are opaque handles registered in memory. */
export class FakeIdentityProvider implements IdentityProvider {
  readonly #clock: Clock;
  readonly #tokens = new Map<string, VerifiedIdentity>();
  #counter = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  issueToken(subject: string, options: { ttlSeconds?: number } = {}): string {
    const issuedAt = this.#clock.now();
    const expiresAt = new Date(issuedAt.getTime() + (options.ttlSeconds ?? 3600) * 1000);
    this.#counter += 1;
    const token = `fake-access-token-${this.#counter}`;
    this.#tokens.set(token, Object.freeze({ provider: "fake", subject, issuedAt, expiresAt }));
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
