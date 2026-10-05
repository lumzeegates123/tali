import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../src/lib/auth/auth-session";
import { AmplifyCognitoAuth } from "../src/lib/auth/cognito/amplify-cognito-auth";
import {
  FAKE_CHALLENGE_SESSION,
  FAKE_COGNITO_CLIENT_ID,
  FAKE_COGNITO_HOST,
  FAKE_COGNITO_REGION,
  FAKE_COGNITO_USER_POOL_ID,
  FakeCognito,
} from "./support/fake-cognito";

/*
 * The real aws-amplify 6.22.1 against a fake Cognito endpoint (no network):
 * proves SRP, GetTokensFromRefreshToken with rotation, single-flight refresh,
 * RevokeToken / GlobalSignOut, and that tokens never reach browser storage.
 */

const EMAIL = "pilot.owner@example.test";
const PASSWORD = "Passpass-1111";

let cognito: FakeCognito;
let auth: AmplifyCognitoAuth;
const sessions: AuthSession[] = [];

function browserState(): string {
  const entries = (storage: Storage) =>
    Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index) ?? "";
      return `${key}=${storage.getItem(key) ?? ""}`;
    });
  return JSON.stringify([entries(window.localStorage), entries(window.sessionStorage), document.cookie]);
}

function expectNoAuthMaterialInBrowser() {
  const state = browserState();
  for (const value of [...cognito.issued.access, ...cognito.issued.id, ...cognito.issued.refresh, PASSWORD]) {
    expect(state).not.toContain(value);
  }
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
}

async function signedIn(): Promise<AuthSession> {
  const result = await auth.signIn(EMAIL, PASSWORD);
  if (result.status !== "signedIn") throw new Error(`expected signedIn, got ${result.status}`);
  sessions.push(result.session);
  return result.session;
}

beforeAll(() => {
  auth = AmplifyCognitoAuth.configure({
    region: FAKE_COGNITO_REGION,
    userPoolId: FAKE_COGNITO_USER_POOL_ID,
    clientId: FAKE_COGNITO_CLIENT_ID,
  });
});

beforeEach(() => {
  cognito = new FakeCognito();
  vi.stubGlobal("fetch", cognito.fetch);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.end({ everywhere: false });
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("Amplify Cognito sign-in (SRP)", () => {
  it("signs in with USER_SRP_AUTH, never sends the password, and hands out the access token only", async () => {
    const session = await signedIn();
    const initiate = cognito.calls.find((call) => call.op === "InitiateAuth");
    expect(initiate?.body["AuthFlow"]).toBe("USER_SRP_AUTH");
    expect(cognito.ops()).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    for (const call of cognito.calls) expect(JSON.stringify(call.body)).not.toContain(PASSWORD);

    const token = await session.accessToken();
    expect(token).toEqual({ ok: true, token: cognito.issued.access.at(-1) });
    expect(cognito.issued.id).not.toContain(token.ok ? token.token : "");
    expectNoAuthMaterialInBrowser();
  });

  it("maps a wrong password to bounded wording and keeps nothing", async () => {
    cognito.options.signInError = "NotAuthorizedException";
    expect(await auth.signIn(EMAIL, PASSWORD)).toEqual({ status: "failed", reason: "invalidCredentials" });
    expectNoAuthMaterialInBrowser();
  });

  it("reports an unconfirmed account as needing confirmation", async () => {
    cognito.options.signInError = "UserNotConfirmedException";
    expect(await auth.signIn(EMAIL, PASSWORD)).toEqual({ status: "confirmationRequired" });
  });

  it("fails safely on an unsupported further challenge without exposing it", async () => {
    cognito.options.furtherChallenge = "NEW_PASSWORD_REQUIRED";
    const result = await auth.signIn(EMAIL, PASSWORD);
    expect(result).toEqual({ status: "unsupportedStep" });
    expect(JSON.stringify(result)).not.toContain(FAKE_CHALLENGE_SESSION);
    // Amplify may keep its own transient challenge state in sessionStorage until it expires; Tali never reads it.
    expect(window.localStorage.length).toBe(0);
    expect(browserState()).not.toContain(PASSWORD);
  });

  it("signs up, confirms with a code and resends a code through Cognito only", async () => {
    expect(await auth.signUp(EMAIL, PASSWORD)).toEqual({ status: "confirmationRequired" });
    expect(await auth.confirmSignUp(EMAIL, "000000")).toEqual({ status: "failed", reason: "invalidCode" });
    expect(await auth.confirmSignUp(EMAIL, "123456")).toEqual({ status: "confirmed" });
    expect(await auth.resendSignUpCode(EMAIL)).toEqual({ status: "sent" });
    expect(cognito.ops()).toEqual(["SignUp", "ConfirmSignUp", "ConfirmSignUp", "ResendConfirmationCode"]);
    expectNoAuthMaterialInBrowser();
  });
});

describe("refresh with rotation", () => {
  it("refreshes with GetTokensFromRefreshToken, shares one refresh between concurrent callers, and rotates", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    cognito.options.refreshDelayMs = 20;
    const session = await signedIn();
    const refreshes = () => cognito.calls.filter((call) => call.op === "GetTokensFromRefreshToken");
    const before = refreshes().length;

    const concurrent = await Promise.all(Array.from({ length: 5 }, () => session.accessToken()));
    expect(refreshes()).toHaveLength(before + 1);
    expect(new Set(concurrent.map((result) => (result.ok ? result.token : "")))).toEqual(
      new Set([cognito.issued.access.at(-1)]),
    );

    await session.accessToken();
    expect(refreshes()).toHaveLength(before + 2);
    // Each refresh presents the refresh token issued by the previous exchange: rotation is honoured.
    refreshes().forEach((call, index) => {
      expect(call.body["RefreshToken"]).toBe(cognito.issued.refresh[index]);
    });
    expect(cognito.calls.some((call) => call.body["AuthFlow"] === "REFRESH_TOKEN_AUTH")).toBe(false);
    expect(cognito.calls.every((call) => call.op !== "InitiateAuth" || call.body["AuthFlow"] === "USER_SRP_AUTH")).toBe(
      true,
    );
    expectNoAuthMaterialInBrowser();
  });

  it("ends the session when Cognito refuses the refresh token", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    const session = await signedIn();
    cognito.options.refreshError = "NotAuthorizedException";
    expect(await session.accessToken()).toEqual({ ok: false, reason: "ended" });
    expectNoAuthMaterialInBrowser();
  });

  it("reports the provider unavailable, not ended, when the refresh cannot reach Cognito", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    const session = await signedIn();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await session.accessToken()).toEqual({ ok: false, reason: "unavailable" });
    vi.stubGlobal("fetch", cognito.fetch);
    expect((await session.accessToken()).ok).toBe(true);
  });
});

describe("sign-out", () => {
  it("revokes the current (rotated) refresh token and forgets every token", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    const session = await signedIn();
    await session.accessToken();
    await session.end({ everywhere: false });
    const revoke = cognito.calls.find((call) => call.op === "RevokeToken");
    expect(revoke?.body["Token"]).toBe(cognito.issued.refresh.at(-1));
    expect(cognito.ops()).not.toContain("GlobalSignOut");
    expect(await session.accessToken()).toEqual({ ok: false, reason: "ended" });
    expectNoAuthMaterialInBrowser();
  });

  it("signs out on all devices with GlobalSignOut", async () => {
    const session = await signedIn();
    await session.end({ everywhere: true });
    const global = cognito.calls.find((call) => call.op === "GlobalSignOut");
    expect(global?.body["AccessToken"]).toBe(cognito.issued.access.at(-1));
    expect(await session.accessToken()).toEqual({ ok: false, reason: "ended" });
    expectNoAuthMaterialInBrowser();
  });

  it("clears local tokens even when revocation cannot reach Cognito", async () => {
    const session = await signedIn();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await session.end({ everywhere: false });
    vi.stubGlobal("fetch", cognito.fetch);
    expect(await session.accessToken()).toEqual({ ok: false, reason: "ended" });
    const next = await signedIn();
    expect((await next.accessToken()).ok).toBe(true);
  });

  it("an older session's end never signs out a newer session", async () => {
    const older = await signedIn();
    await older.end({ everywhere: false });
    const newer = await signedIn();
    await older.end({ everywhere: true });
    expect(cognito.ops()).not.toContain("GlobalSignOut");
    expect((await newer.accessToken()).ok).toBe(true);
  });

  it("contacts only the configured user pool endpoint", async () => {
    const session = await signedIn();
    await session.accessToken();
    await session.end({ everywhere: false });
    expect(cognito.calls.length).toBeGreaterThan(0);
    expect(cognito.refusedHosts).toEqual([]);
    expect(FAKE_COGNITO_HOST).toBe("cognito-idp.eu-west-1.amazonaws.com");
  });
});
