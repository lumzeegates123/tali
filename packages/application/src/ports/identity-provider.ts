/**
 * An authenticated identity as verified by the identity provider. It carries
 * no tenant or permission information: BusinessContext is resolved from Tali's
 * database, never from provider claims alone.
 */
export interface VerifiedIdentity {
  /** Provider name, e.g. "cognito", "local" or "fake". */
  readonly provider: string;
  /** Stable subject identifier issued by the provider. */
  readonly subject: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface IdentityProvider {
  /**
   * Verifies an access token (signature, issuer, audience, expiry) and returns
   * the identity. Rejects with AuthenticationError when the token is invalid.
   */
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}
