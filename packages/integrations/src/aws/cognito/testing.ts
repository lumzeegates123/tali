import type { CryptoKey, JWK, JWTPayload } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JwksFetch } from "./cognito-jwks.js";
import { cognitoIssuer, cognitoJwksUrl } from "./cognito-identity-provider.js";

/**
 * TEST ONLY: a synthetic Cognito user pool. RSA key pairs are generated in
 * memory per fixture (private keys non-extractable, never written anywhere),
 * and the JWKS is served through an injected fetch, so no test reaches
 * Cognito, AWS or the internet. Never composed into a running API.
 */

export const SYNTHETIC_REGION = "eu-west-1";
export const SYNTHETIC_USER_POOL_ID = "eu-west-1_SyntheticPool1";
export const SYNTHETIC_WEB_CLIENT_ID = "syntheticwebclient0000000001";
export const SYNTHETIC_MOBILE_CLIENT_ID = "syntheticmobileclient000002";

interface FixtureKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JWK;
}

export type JwksReply =
  | { readonly kind: "keys" }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "body"; readonly body: string }
  | { readonly kind: "hang" };

export interface SignOptions {
  /** Signing key ID; defaults to the current key. */
  readonly kid?: string;
  /** Header overrides, for example a different `alg` or no `kid`. */
  readonly header?: Record<string, unknown>;
  /** Sign with a key the JWKS never publishes. */
  readonly unpublishedKey?: boolean;
}

export class SyntheticCognitoPool {
  readonly region = SYNTHETIC_REGION;
  readonly userPoolId = SYNTHETIC_USER_POOL_ID;
  readonly issuer = cognitoIssuer(SYNTHETIC_REGION, SYNTHETIC_USER_POOL_ID);
  readonly jwksUrl = cognitoJwksUrl(SYNTHETIC_REGION, SYNTHETIC_USER_POOL_ID);
  readonly clientIds = [SYNTHETIC_WEB_CLIENT_ID, SYNTHETIC_MOBILE_CLIENT_ID] as const;
  readonly requestedUrls: string[] = [];
  #published: FixtureKey[] = [];
  #current: FixtureKey;
  #unpublished: FixtureKey;
  #reply: JwksReply = { kind: "keys" };
  #counter = 0;

  private constructor(current: FixtureKey, unpublished: FixtureKey) {
    this.#current = current;
    this.#unpublished = unpublished;
    this.#published = [current];
  }

  static async create(): Promise<SyntheticCognitoPool> {
    return new SyntheticCognitoPool(await newKey("synthetic-kid-1"), await newKey("synthetic-unpublished"));
  }

  /** How many times the JWKS was requested. */
  get fetchCount(): number {
    return this.requestedUrls.length;
  }

  get currentKid(): string {
    return this.#current.kid;
  }

  /** Cognito starts signing with a new key and publishes it next to the old one. */
  async rotate(): Promise<string> {
    this.#counter += 1;
    const key = await newKey(`synthetic-kid-rotated-${String(this.#counter)}`);
    this.#published = [...this.#published, key];
    this.#current = key;
    return key.kid;
  }

  /** What the next JWKS requests answer. */
  replyWith(reply: JwksReply): void {
    this.#reply = reply;
  }

  readonly fetch: JwksFetch = async (url, init) => {
    this.requestedUrls.push(url);
    const reply = this.#reply;
    switch (reply.kind) {
      case "keys":
        return new Response(JSON.stringify({ keys: this.#published.map((key) => key.jwk) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      case "status":
        return new Response("{}", { status: reply.status });
      case "body":
        return new Response(reply.body, { status: 200, headers: { "content-type": "application/json" } });
      case "hang":
        return new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
    }
  };

  /** Standard access-token claims for `sub`, valid at `now`, merged with `claims` (undefined removes a claim). */
  accessClaims(sub: string, now: Date, claims: Record<string, unknown> = {}): JWTPayload {
    const seconds = Math.floor(now.getTime() / 1000);
    const base: Record<string, unknown> = {
      sub,
      iss: this.issuer,
      client_id: SYNTHETIC_WEB_CLIENT_ID,
      origin_jti: "synthetic-origin",
      event_id: "synthetic-event",
      token_use: "access",
      scope: "aws.cognito.signin.user.admin",
      auth_time: seconds,
      iat: seconds,
      exp: seconds + 900,
      jti: `synthetic-jti-${String(seconds)}`,
      username: sub,
    };
    return Object.fromEntries(Object.entries({ ...base, ...claims }).filter(([, value]) => value !== undefined));
  }

  async sign(payload: JWTPayload, options: SignOptions = {}): Promise<string> {
    const key = options.unpublishedKey === true ? this.#unpublished : this.#keyFor(options.kid);
    const header = { alg: "RS256", kid: key.kid, ...options.header };
    return new SignJWT(payload).setProtectedHeader(header).sign(key.privateKey);
  }

  /** A signed access token for `sub` at `now`. */
  async accessToken(sub: string, now: Date, claims: Record<string, unknown> = {}, options: SignOptions = {}) {
    return this.sign(this.accessClaims(sub, now, claims), options);
  }

  #keyFor(kid: string | undefined): FixtureKey {
    if (kid === undefined) return this.#current;
    const key = this.#published.find((candidate) => candidate.kid === kid);
    if (key === undefined) throw new Error(`unknown fixture kid ${kid}`);
    return key;
  }
}

async function newKey(kid: string): Promise<FixtureKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: false });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, privateKey, jwk };
}
