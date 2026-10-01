import { AuthenticationError, type Clock } from "@tali/application";
import { beforeEach, describe, expect, it } from "vitest";
import { CognitoIdentityProvider, COGNITO_CLOCK_SKEW_SECONDS, cognitoIssuer } from "./cognito-identity-provider.js";
import {
  SYNTHETIC_MOBILE_CLIENT_ID,
  SYNTHETIC_REGION,
  SYNTHETIC_USER_POOL_ID,
  SYNTHETIC_WEB_CLIENT_ID,
  SyntheticCognitoPool,
} from "./testing.js";

const SUB = "6b1f6a2e-3c1d-4f7a-9a51-0c1f2e3d4a5b";

class MovableClock implements Clock {
  #now: Date;
  constructor(iso: string) {
    this.#now = new Date(iso);
  }
  now(): Date {
    return new Date(this.#now.getTime());
  }
  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("CognitoIdentityProvider", () => {
  let pool: SyntheticCognitoPool;
  let clock: MovableClock;
  let provider: CognitoIdentityProvider;

  beforeEach(async () => {
    pool = await SyntheticCognitoPool.create();
    clock = new MovableClock("2026-09-30T12:00:00Z");
    provider = new CognitoIdentityProvider({
      region: pool.region,
      userPoolId: pool.userPoolId,
      clientIds: pool.clientIds,
      clock,
      fetch: pool.fetch,
    });
  });

  const token = (claims: Record<string, unknown> = {}, options = {}) =>
    pool.accessToken(SUB, clock.now(), claims, options);

  async function rejects(value: string | Promise<string>): Promise<void> {
    await expect(provider.verifyAccessToken(await value)).rejects.toBeInstanceOf(AuthenticationError);
  }

  it("verifies a valid access token and maps sub, iat, exp and auth_time", async () => {
    const authTime = Math.floor(clock.now().getTime() / 1000) - 600;
    const identity = await provider.verifyAccessToken(await token({ auth_time: authTime }));
    expect(identity).toEqual({
      provider: "COGNITO",
      subject: SUB,
      issuedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 900_000),
      authTime: new Date(authTime * 1000),
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("accepts every allowlisted public client and refuses others", async () => {
    for (const clientId of [SYNTHETIC_WEB_CLIENT_ID, SYNTHETIC_MOBILE_CLIENT_ID]) {
      await expect(provider.verifyAccessToken(await token({ client_id: clientId }))).resolves.toMatchObject({
        subject: SUB,
      });
    }
    await rejects(token({ client_id: "unknownthirdclient00000003" }));
    await rejects(token({ client_id: undefined }));
    await rejects(token({ client_id: 42 }));
    // `aud` is never a substitute for client_id.
    await rejects(token({ client_id: undefined, aud: SYNTHETIC_WEB_CLIENT_ID }));
  });

  it("accepts access tokens only", async () => {
    await rejects(token({ token_use: "id", aud: SYNTHETIC_WEB_CLIENT_ID }));
    await rejects(token({ token_use: undefined }));
    await rejects(token({ token_use: "refresh" }));
    await rejects("eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIiwiYWxnIjoiUlNBLU9BRVAifQ.a.b.c.d");
  });

  it("requires the exact configured issuer", async () => {
    await rejects(token({ iss: cognitoIssuer("eu-west-2", "eu-west-2_SyntheticPool1") }));
    await rejects(token({ iss: cognitoIssuer(SYNTHETIC_REGION, "eu-west-1_OtherPool9") }));
    await rejects(token({ iss: `${pool.issuer}/` }));
    await rejects(token({ iss: undefined }));
  });

  it("never fetches from the token: only the configured JWKS URL is requested", async () => {
    await provider.verifyAccessToken(
      await token({ iss: pool.issuer }, { header: { jku: "https://attacker.example/jwks.json", x5u: "https://x" } }),
    );
    await rejects(
      token({ iss: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Attacker1" }, { kid: undefined }),
    );
    expect(new Set(pool.requestedUrls)).toEqual(
      new Set([
        `https://cognito-idp.${SYNTHETIC_REGION}.amazonaws.com/${SYNTHETIC_USER_POOL_ID}/.well-known/jwks.json`,
      ]),
    );
  });

  it("validates exp, iat and auth_time with a bounded skew", async () => {
    const now = Math.floor(clock.now().getTime() / 1000);
    const skew = COGNITO_CLOCK_SKEW_SECONDS;
    await rejects(token({ iat: now - 1000, auth_time: now - 1000, exp: now - skew - 1 }));
    await expect(
      provider.verifyAccessToken(await token({ iat: now - 900, auth_time: now - 900, exp: now - skew + 5 })),
    ).resolves.toBeDefined();
    await rejects(token({ iat: now + skew + 1, auth_time: now, exp: now + 900 }));
    await expect(
      provider.verifyAccessToken(await token({ iat: now + skew, auth_time: now, exp: now + 900 })),
    ).resolves.toBeDefined();
    await rejects(token({ auth_time: now + 1 }));
    await rejects(token({ auth_time: undefined }));
    await rejects(token({ iat: undefined }));
    await rejects(token({ exp: undefined }));
    await rejects(token({ exp: now }));
    await rejects(token({ exp: now + 2 * 86_400 }));
    await rejects(token({ auth_time: "yesterday" }));
    expect(skew).toBeLessThanOrEqual(60);
  });

  it("refuses alg none, HS256, other RSA and ECDSA algorithms, and a missing kid", async () => {
    const now = clock.now();
    const claims = b64(pool.accessClaims(SUB, now));
    await rejects(`${b64({ alg: "none", kid: pool.currentKid })}.${claims}.`);
    await rejects(`${b64({ alg: "HS256", kid: pool.currentKid })}.${claims}.c2lnbmF0dXJl`);
    await rejects(`${b64({ alg: "RS512", kid: pool.currentKid })}.${claims}.c2lnbmF0dXJl`);
    await rejects(`${b64({ alg: "PS256", kid: pool.currentKid })}.${claims}.c2lnbmF0dXJl`);
    await rejects(`${b64({ alg: "ES256", kid: pool.currentKid })}.${claims}.c2lnbmF0dXJl`);
    await rejects(token({}, { header: { kid: undefined } }));
    await rejects(token({}, { header: { kid: "" } }));
  });

  it("refuses a tampered signature or payload, malformed tokens and a bad subject", async () => {
    const valid = await token();
    const [header, payload, signature] = valid.split(".") as [string, string, string];
    const forged = b64({ ...pool.accessClaims(SUB, clock.now()), sub: "00000000-0000-4000-8000-000000000000" });
    await rejects(`${header}.${forged}.${signature}`);
    await rejects(`${header}.${payload}.${signature.slice(0, -4)}AAAA`);
    await rejects(`${header}.${payload}`);
    for (const malformed of ["", "abc", "a.b.c", "....", `${header}..${signature}`]) await rejects(malformed);
    await rejects(token({ sub: undefined }));
    await rejects(token({ sub: "" }));
    await rejects(token({ sub: "not-a-uuid" }));
    await rejects(token({ sub: SUB.toUpperCase() }));
  });

  it("refuses a token signed by a key the pool never published", async () => {
    await rejects(token({}, { unpublishedKey: true }));
  });

  it("returns only identity fields: groups, scopes, username, email and custom claims are ignored", async () => {
    const identity = await provider.verifyAccessToken(
      await token({
        "cognito:groups": ["OWNER", "ADMIN"],
        "custom:role": "OWNER",
        "custom:businessId": "0191a1b2-0000-7000-8000-00000000000a",
        scope: "admin",
        email: "owner@example.test",
        phone_number: "+2340000000000",
        username: "owner",
      }),
    );
    expect(Object.keys(identity).sort()).toEqual(["authTime", "expiresAt", "issuedAt", "provider", "subject"]);
    expect(JSON.stringify(identity)).not.toMatch(/OWNER|ADMIN|example\.test|businessId|admin|\+234/);
  });

  it("errors carry no token, claim or reason", async () => {
    const valid = await token({ client_id: "unknownthirdclient00000003" });
    const error = await provider.verifyAccessToken(valid).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe("Invalid access token");
    expect(JSON.stringify(error)).not.toContain(valid);
  });

  it("refuses inconsistent or invalid configuration", () => {
    const base = { region: "eu-west-1", userPoolId: "eu-west-1_Pool1", clientIds: ["abc"], clock };
    expect(() => new CognitoIdentityProvider({ ...base, region: "eu-west-2" })).toThrow(/do not match/);
    expect(() => new CognitoIdentityProvider({ ...base, userPoolId: "pool" })).toThrow();
    expect(() => new CognitoIdentityProvider({ ...base, region: "https://evil" })).toThrow();
    expect(() => new CognitoIdentityProvider({ ...base, clientIds: [] })).toThrow(/client IDs/);
    expect(() => new CognitoIdentityProvider({ ...base, clientIds: ["bad id"] })).toThrow(/client IDs/);
    expect(new CognitoIdentityProvider(base)).toBeInstanceOf(CognitoIdentityProvider);
  });

  it("does not contact the JWKS when constructed", () => {
    expect(pool.fetchCount).toBe(0);
  });
});

describe("Cognito JWKS cache through the provider", () => {
  let pool: SyntheticCognitoPool;
  let clock: MovableClock;
  let provider: CognitoIdentityProvider;

  beforeEach(async () => {
    pool = await SyntheticCognitoPool.create();
    clock = new MovableClock("2026-09-30T12:00:00Z");
    provider = new CognitoIdentityProvider({
      region: pool.region,
      userPoolId: pool.userPoolId,
      clientIds: pool.clientIds,
      clock,
      fetch: pool.fetch,
      jwksTimeoutMs: 50,
    });
  });

  const verify = async (options = {}) =>
    provider.verifyAccessToken(await pool.accessToken(SUB, clock.now(), {}, options));
  const forgedKid = async (kid: string) =>
    provider
      .verifyAccessToken(await pool.accessToken(SUB, clock.now(), {}, { unpublishedKey: true, header: { kid } }))
      .catch((error: unknown) => error);

  it("fetches once, then serves a known kid from memory", async () => {
    await verify();
    await verify();
    await verify();
    expect(pool.fetchCount).toBe(1);
  });

  it("shares one fetch between concurrent first requests", async () => {
    await Promise.all([verify(), verify(), verify(), verify()]);
    expect(pool.fetchCount).toBe(1);
  });

  it("handles key rotation with one controlled refresh, then caches the new key", async () => {
    await verify();
    clock.advance(61_000);
    const newKid = await pool.rotate();
    await expect(verify({ kid: newKid })).resolves.toMatchObject({ provider: "COGNITO" });
    expect(pool.fetchCount).toBe(2);
    for (let index = 0; index < 5; index += 1) await verify({ kid: newKid });
    await verify({ kid: "synthetic-kid-1" });
    expect(pool.fetchCount).toBe(2);
  });

  it("a rotated key inside the refresh window waits for the window (no storm), then succeeds", async () => {
    await verify();
    const newKid = await pool.rotate();
    await expect(verify({ kid: newKid })).rejects.toBeInstanceOf(AuthenticationError);
    expect(pool.fetchCount).toBe(1);
    clock.advance(60_000);
    await expect(verify({ kid: newKid })).resolves.toBeDefined();
    expect(pool.fetchCount).toBe(2);
  });

  it("rate-limits repeated unknown kids to one fetch per window and never caches them", async () => {
    await verify();
    for (let index = 0; index < 200; index += 1) {
      expect(await forgedKid(`forged-${String(index)}`)).toBeInstanceOf(AuthenticationError);
    }
    expect(pool.fetchCount).toBe(1);
    clock.advance(60_000);
    await Promise.all(Array.from({ length: 50 }, (_, index) => forgedKid(`burst-${String(index)}`)));
    expect(pool.fetchCount).toBe(2);
    await verify();
    expect(pool.fetchCount).toBe(2);
  });

  for (const [name, reply] of [
    ["HTTP failure", { kind: "status", status: 500 }],
    ["HTTP 404", { kind: "status", status: 404 }],
    ["malformed JSON", { kind: "body", body: "{not json" }],
    ["malformed JWKS", { kind: "body", body: JSON.stringify({ keys: "nope" }) }],
    ["empty JWKS", { kind: "body", body: JSON.stringify({ keys: [] }) }],
    [
      "unsupported keys only",
      {
        kind: "body",
        body: JSON.stringify({
          keys: [
            { kid: "synthetic-kid-1", kty: "EC", crv: "P-256", x: "AA", y: "AA" },
            { kid: "oct", kty: "oct", k: "c2VjcmV0" },
          ],
        }),
      },
    ],
    ["oversized JWKS", { kind: "body", body: JSON.stringify({ keys: [], pad: "x".repeat(70_000) }) }],
    ["timeout", { kind: "hang" }],
  ] as const) {
    it(`fails closed on ${name}, backs off, and recovers after the window`, async () => {
      pool.replyWith(reply);
      await expect(verify()).rejects.toBeInstanceOf(AuthenticationError);
      await expect(verify()).rejects.toBeInstanceOf(AuthenticationError);
      expect(pool.fetchCount).toBe(1);
      pool.replyWith({ kind: "keys" });
      clock.advance(5_000);
      await expect(verify()).resolves.toMatchObject({ subject: SUB });
      expect(pool.fetchCount).toBe(2);
    });
  }

  it("keeps the previous keys when a refresh fails", async () => {
    await verify();
    clock.advance(61_000);
    pool.replyWith({ kind: "status", status: 503 });
    expect(await forgedKid("forged-after-success")).toBeInstanceOf(AuthenticationError);
    expect(pool.fetchCount).toBe(2);
    await expect(verify()).resolves.toBeDefined();
  });
});
