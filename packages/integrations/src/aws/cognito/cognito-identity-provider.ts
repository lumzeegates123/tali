import type { Clock, IdentityProvider, VerifiedIdentity } from "@tali/application";
import { AuthenticationError } from "@tali/application";
import type { JWTPayload } from "jose";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { COGNITO_SIGNING_ALGORITHM, CognitoJwksCache, type JwksFetch } from "./cognito-jwks.js";

/** Accepted clock skew for exp, iat and auth_time (ADR-003 section 15: at most 60 s, 30 s recommended). */
export const COGNITO_CLOCK_SKEW_SECONDS = 30;
/** Cognito access tokens live at most one day; anything longer is not a Cognito access token. */
const MAX_TOKEN_LIFETIME_SECONDS = 86_400;

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/u;
const USER_POOL_ID = /^([a-z]{2}(-gov)?-[a-z]+-[0-9])_[A-Za-z0-9]+$/u;
const CLIENT_ID = /^[\w+]{1,128}$/u;
/** Cognito `sub` values are lowercase UUIDs; the subject is persisted exactly as issued. */
const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KID = /^[A-Za-z0-9+/=_.-]{1,128}$/u;

export interface CognitoIdentityProviderOptions {
  readonly region: string;
  readonly userPoolId: string;
  /** The public app clients whose access tokens the API accepts (COGNITO_CLIENT_IDS). */
  readonly clientIds: readonly string[];
  readonly clock: Clock;
  /** Test seam: replaces the network fetch of the trusted JWKS URL. */
  readonly fetch?: JwksFetch;
  readonly jwksTimeoutMs?: number;
  readonly jwksMinRefreshIntervalMs?: number;
}

/** `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`, from trusted configuration only. */
export function cognitoIssuer(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

export function cognitoJwksUrl(region: string, userPoolId: string): string {
  return `${cognitoIssuer(region, userPoolId)}/.well-known/jwks.json`;
}

function epochSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Verifies Cognito access tokens locally against the user pool's JWKS
 * (ADR-003 section 15; ADR-005: Cognito authenticates, Tali authorizes).
 *
 * Accepted only when: the header is RS256 with a `kid` (header `jku`, `x5u`,
 * `jwk` and `x5c` are never used); the key comes from the trusted JWKS; the
 * signature verifies; `iss` equals the configured pool issuer exactly;
 * `token_use` is `access`; `client_id` is allowlisted; `exp`, `iat` and
 * `auth_time` are consistent with the injected clock within
 * COGNITO_CLOCK_SKEW_SECONDS; and `sub` is a UUID.
 *
 * The result carries the subject and times only. Groups, scopes, username,
 * email, phone and custom attributes are never read: every authorization
 * decision is made from Tali's database. Every failure is the same
 * AuthenticationError; the reason, token and claims are never exposed.
 */
export class CognitoIdentityProvider implements IdentityProvider {
  readonly #issuer: string;
  readonly #clientIds: ReadonlySet<string>;
  readonly #clock: Clock;
  readonly #jwks: CognitoJwksCache;

  constructor(options: CognitoIdentityProviderOptions) {
    const match = USER_POOL_ID.exec(options.userPoolId);
    if (!REGION.test(options.region) || match === null || match[1] !== options.region) {
      throw new Error("Cognito region and user pool ID are invalid or do not match");
    }
    if (options.clientIds.length === 0 || !options.clientIds.every((id) => CLIENT_ID.test(id))) {
      throw new Error("Cognito client IDs are missing or invalid");
    }
    this.#issuer = cognitoIssuer(options.region, options.userPoolId);
    this.#clientIds = new Set(options.clientIds);
    this.#clock = options.clock;
    this.#jwks = new CognitoJwksCache({
      url: cognitoJwksUrl(options.region, options.userPoolId),
      clock: options.clock,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.jwksTimeoutMs === undefined ? {} : { timeoutMs: options.jwksTimeoutMs }),
      ...(options.jwksMinRefreshIntervalMs === undefined
        ? {}
        : { minRefreshIntervalMs: options.jwksMinRefreshIntervalMs }),
    });
  }

  async verifyAccessToken(token: string): Promise<VerifiedIdentity> {
    let identity: VerifiedIdentity | undefined;
    try {
      identity = await this.#verify(token);
    } catch {
      identity = undefined;
    }
    if (identity === undefined) throw new AuthenticationError("Invalid access token");
    return identity;
  }

  async #verify(token: string): Promise<VerifiedIdentity | undefined> {
    const header = decodeProtectedHeader(token);
    if (header.alg !== COGNITO_SIGNING_ALGORITHM) return undefined;
    if (typeof header.kid !== "string" || !KID.test(header.kid)) return undefined;
    const key = await this.#jwks.keyFor(header.kid);
    if (key === undefined) return undefined;
    const now = this.#clock.now();
    const { payload } = await jwtVerify(token, key, {
      algorithms: [COGNITO_SIGNING_ALGORITHM],
      issuer: this.#issuer,
      currentDate: now,
      clockTolerance: COGNITO_CLOCK_SKEW_SECONDS,
      requiredClaims: ["sub", "iat", "exp", "auth_time", "token_use", "client_id"],
    });
    return this.#identityFrom(payload, Math.floor(now.getTime() / 1000));
  }

  #identityFrom(payload: JWTPayload, nowSeconds: number): VerifiedIdentity | undefined {
    if (payload["token_use"] !== "access") return undefined;
    const clientId = payload["client_id"];
    if (typeof clientId !== "string" || !this.#clientIds.has(clientId)) return undefined;
    const subject = payload.sub;
    if (typeof subject !== "string" || !SUBJECT.test(subject)) return undefined;
    const issuedAt = epochSeconds(payload.iat);
    const expiresAt = epochSeconds(payload.exp);
    const authTime = epochSeconds(payload["auth_time"]);
    if (issuedAt === undefined || expiresAt === undefined || authTime === undefined) return undefined;
    if (issuedAt > nowSeconds + COGNITO_CLOCK_SKEW_SECONDS) return undefined;
    if (expiresAt <= nowSeconds - COGNITO_CLOCK_SKEW_SECONDS) return undefined;
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TOKEN_LIFETIME_SECONDS) return undefined;
    if (authTime > issuedAt) return undefined;
    return Object.freeze({
      provider: "COGNITO",
      subject,
      issuedAt: new Date(issuedAt * 1000),
      expiresAt: new Date(expiresAt * 1000),
      authTime: new Date(authTime * 1000),
    });
  }
}
