import { AuthenticationError, ValidationError } from "@tali/application";
import { FixedClock } from "@tali/application/testing";
import { describeIdentityProviderContract } from "@tali/application/testing/contracts";
import { decodeJwt, decodeProtectedHeader, SignJWT, UnsecuredJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  LOCAL_AUDIENCE,
  LOCAL_ISSUER,
  LOCAL_TOKEN_TTL_SECONDS,
  LocalIdentityProvider,
} from "./local-identity-provider.js";

const START = "2026-09-29T08:00:00.000Z";

async function setup() {
  const clock = new FixedClock(START);
  const provider = await LocalIdentityProvider.create({ clock });
  return { clock, provider };
}

describeIdentityProviderContract("LocalIdentityProvider", async () => {
  const { clock, provider } = await setup();
  return {
    provider,
    issueValidToken: async (subject) => (await provider.issueAccessToken(subject)).accessToken,
    issueExpiredToken: async (subject) => {
      const now = clock.now();
      clock.set(new Date(now.getTime() - 2 * LOCAL_TOKEN_TTL_SECONDS * 1000));
      const { accessToken } = await provider.issueAccessToken(subject);
      clock.set(now);
      return accessToken;
    },
  };
});

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("LocalIdentityProvider", () => {
  it("signs and verifies a 1-hour LOCAL token for the exact subject with authTime", async () => {
    const { provider } = await setup();
    const issued = await provider.issueAccessToken("local-owner-1");
    expect(issued.expiresAt.toISOString()).toBe("2026-09-29T09:00:00.000Z");
    const identity = await provider.verifyAccessToken(issued.accessToken);
    expect(identity).toEqual({
      provider: "LOCAL",
      subject: "local-owner-1",
      issuedAt: new Date(START),
      expiresAt: new Date("2026-09-29T09:00:00.000Z"),
      authTime: new Date(START),
    });
  });

  it("issues an ES256 access token with only the standard claims and auth_time, never roles or memberships", async () => {
    const { provider } = await setup();
    const { accessToken } = await provider.issueAccessToken("local-owner-1");
    expect(decodeProtectedHeader(accessToken)).toEqual({ alg: "ES256", typ: "at+jwt" });
    const claims = decodeJwt(accessToken);
    expect(Object.keys(claims).sort()).toEqual(["aud", "auth_time", "exp", "iat", "iss", "sub"]);
    expect(claims).toMatchObject({ iss: LOCAL_ISSUER, aud: LOCAL_AUDIENCE, sub: "local-owner-1" });
  });

  it("accepts the token until its expiry and rejects it from the expiry instant", async () => {
    const { clock, provider } = await setup();
    const { accessToken } = await provider.issueAccessToken("local-owner-1");
    clock.advanceBySeconds(LOCAL_TOKEN_TTL_SECONDS - 1);
    await expect(provider.verifyAccessToken(accessToken)).resolves.toMatchObject({ subject: "local-owner-1" });
    clock.advanceBySeconds(1);
    await expect(provider.verifyAccessToken(accessToken)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token issued in the future", async () => {
    const { clock, provider } = await setup();
    clock.advanceBySeconds(600);
    const { accessToken } = await provider.issueAccessToken("local-owner-1");
    clock.set(START);
    await expect(provider.verifyAccessToken(accessToken)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a token whose payload was changed after signing", async () => {
    const { provider } = await setup();
    const { accessToken } = await provider.issueAccessToken("local-owner-1");
    const [header, payload, signature] = accessToken.split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const forged = { ...claims, sub: "local-owner-2" };
    const tampered = `${header}.${base64url(JSON.stringify(forged))}.${signature}`;
    await expect(provider.verifyAccessToken(tampered)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects tokens from another instance, as after a process restart", async () => {
    const first = await setup();
    const second = await setup();
    const { accessToken } = await first.provider.issueAccessToken("local-owner-1");
    await expect(second.provider.verifyAccessToken(accessToken)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects unsigned, symmetric and malformed tokens without exposing the verifier error", async () => {
    const { provider } = await setup();
    const iat = Math.floor(new Date(START).getTime() / 1000);
    const claims = { sub: "local-owner-1", auth_time: iat };
    const unsigned = new UnsecuredJWT(claims)
      .setIssuer(LOCAL_ISSUER)
      .setAudience(LOCAL_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + LOCAL_TOKEN_TTL_SECONDS)
      .encode();
    const symmetric = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(LOCAL_ISSUER)
      .setAudience(LOCAL_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + LOCAL_TOKEN_TTL_SECONDS)
      .sign(crypto.getRandomValues(new Uint8Array(32)));
    for (const token of [unsigned, symmetric, "a.b.c", "....", "x".repeat(5000)]) {
      const failure = await provider.verifyAccessToken(token).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AuthenticationError);
      expect((failure as Error).message).toBe("Invalid access token");
      expect((failure as Error).cause).toBeUndefined();
    }
  });

  it.each(["", "a".repeat(65), "has space", "../escape", "-leading-dash", "caf\u00E9", "a\nb"])(
    "refuses to issue a token for the subject %j",
    async (subject) => {
      const { provider } = await setup();
      await expect(provider.issueAccessToken(subject)).rejects.toBeInstanceOf(ValidationError);
    },
  );
});
