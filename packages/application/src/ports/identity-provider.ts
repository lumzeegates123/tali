import type { ExternalIdentityProvider } from "@tali/domain";

/**
 * An authenticated identity as verified by the identity provider. It carries
 * no tenant or permission information: BusinessContext is resolved from Tali's
 * database, never from provider claims alone.
 */
export interface VerifiedIdentity {
  /**
   * The persisted provider category (ADR-005 section 3): "COGNITO" or "LOCAL".
   * Adapters report the category of the mode they implement; test adapters
   * report one of these and never a category of their own.
   */
  readonly provider: ExternalIdentityProvider;
  /** Stable subject identifier issued by the provider. */
  readonly subject: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** When the user last actively authenticated; kept for later step-up checks (ADR-005 section 9). */
  readonly authTime: Date;
}

export interface IdentityProvider {
  /**
   * Verifies an access token (signature, issuer, audience, expiry) and returns
   * the identity. Rejects with AuthenticationError when the token is invalid.
   */
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}
