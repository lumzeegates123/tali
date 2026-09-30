import type { Clock, IdentityProvider, VerifiedIdentity } from "@tali/application";
import { AuthenticationError, ValidationError } from "@tali/application";
import type { CryptoKey, JWTPayload } from "jose";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";

/**
 * Local development identity (ADR-005 section 16). Composition allows it only
 * when TALI_ENV=local; it is never part of a deployed environment.
 *
 * - A fresh ES256 key pair is generated when the instance is created (once per
 *   API process). The private key is non-extractable, held in memory only,
 *   never persisted and never loaded from the repository. Restarting the
 *   process invalidates every token it issued.
 * - One instance both issues and verifies; tokens from another instance or an
 *   earlier process fail verification.
 * - Tokens are 1-hour access tokens with issuer, audience, subject, issued-at,
 *   expiry and auth_time. There are no refresh tokens and no sessions.
 * - The token carries no roles, memberships or businesses; those are Tali
 *   database state resolved per request (ADR-005 section 8).
 */
export const LOCAL_TOKEN_TTL_SECONDS = 3600;
export const LOCAL_ISSUER = "tali-local";
export const LOCAL_AUDIENCE = "tali-api-local";

/** Local subjects: 1 to 64 ASCII letters, digits, ".", "_" or "-", starting with a letter or digit. */
export const LOCAL_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const ALGORITHM = "ES256";
const TOKEN_TYPE = "at+jwt";

export interface LocalAccessToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

function epochSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function identityFrom(payload: JWTPayload): VerifiedIdentity | undefined {
  const issuedAt = epochSeconds(payload.iat);
  const expiresAt = epochSeconds(payload.exp);
  const authTime = epochSeconds(payload["auth_time"]);
  const subject = payload.sub;
  if (issuedAt === undefined || expiresAt === undefined || authTime === undefined) return undefined;
  if (typeof subject !== "string" || !LOCAL_SUBJECT_PATTERN.test(subject)) return undefined;
  if (authTime > issuedAt || expiresAt - issuedAt !== LOCAL_TOKEN_TTL_SECONDS) return undefined;
  return Object.freeze({
    provider: "LOCAL",
    subject,
    issuedAt: new Date(issuedAt * 1000),
    expiresAt: new Date(expiresAt * 1000),
    authTime: new Date(authTime * 1000),
  });
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly #clock: Clock;
  readonly #privateKey: CryptoKey;
  readonly #publicKey: CryptoKey;

  private constructor(clock: Clock, keys: { readonly privateKey: CryptoKey; readonly publicKey: CryptoKey }) {
    this.#clock = clock;
    this.#privateKey = keys.privateKey;
    this.#publicKey = keys.publicKey;
  }

  /** Generates the process's signing key pair. */
  static async create(options: { readonly clock: Clock }): Promise<LocalIdentityProvider> {
    const keys = await generateKeyPair(ALGORITHM, { extractable: false });
    return new LocalIdentityProvider(options.clock, keys);
  }

  /** Signs a 1-hour access token for a local subject. Creates no user, business or membership. */
  async issueAccessToken(subject: string): Promise<LocalAccessToken> {
    if (!LOCAL_SUBJECT_PATTERN.test(subject)) {
      throw new ValidationError("Invalid local subject", [{ path: ["subject"], message: "Invalid local subject" }]);
    }
    const issuedAt = Math.floor(this.#clock.now().getTime() / 1000);
    const expiresAt = issuedAt + LOCAL_TOKEN_TTL_SECONDS;
    const accessToken = await new SignJWT({ auth_time: issuedAt })
      .setProtectedHeader({ alg: ALGORITHM, typ: TOKEN_TYPE })
      .setIssuer(LOCAL_ISSUER)
      .setAudience(LOCAL_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.#privateKey);
    return { accessToken, expiresAt: new Date(expiresAt * 1000) };
  }

  /**
   * Verifies signature, algorithm, token type, issuer, audience, issued-at,
   * expiry and auth_time against the injected clock. Every failure is the
   * same AuthenticationError; the jose error (and the token) is never exposed.
   */
  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    let identity: VerifiedIdentity | undefined;
    try {
      const { payload } = await jwtVerify(token, this.#publicKey, {
        algorithms: [ALGORITHM],
        typ: TOKEN_TYPE,
        issuer: LOCAL_ISSUER,
        audience: LOCAL_AUDIENCE,
        currentDate: this.#clock.now(),
        maxTokenAge: LOCAL_TOKEN_TTL_SECONDS,
        requiredClaims: ["sub", "iat", "exp", "auth_time"],
      });
      identity = identityFrom(payload);
    } catch {
      identity = undefined;
    }
    if (identity === undefined) throw new AuthenticationError("Invalid access token");
    return identity;
  }
}
