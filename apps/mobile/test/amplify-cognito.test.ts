import type * as CognitoDevice from "./support/cognito-device";
import type { AccessTokenResult, AuthSession } from "../src/auth/auth-session";
import type * as AuthModule from "../src/auth/cognito/amplify-cognito-auth";
import type { AmplifyCognitoAuth } from "../src/auth/cognito/amplify-cognito-auth";
import type { CognitoSignInResult } from "../src/auth/cognito-types";
import { createSecureDeviceCredentialStore, deviceRegistrationKey } from "../src/devices/device-credential-store";
import { asyncStorageWrites, device, installNativeSrpDouble, resetDevice } from "./support/cognito-device";
import {
  FAKE_COGNITO_CLIENT_ID,
  FAKE_COGNITO_REGION,
  FAKE_COGNITO_SECOND_SUB,
  FAKE_COGNITO_SUB,
  FAKE_COGNITO_USER_POOL_ID,
  FAKE_CHALLENGE_SESSION,
  FakeCognito,
} from "./support/fake-cognito";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").secureStoreMock(),
);
jest.mock("expo-crypto", () => jest.requireActual<typeof CognitoDevice>("./support/cognito-device").expoCryptoMock());
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").asyncStorageMock(),
);

const CONFIG = { region: FAKE_COGNITO_REGION, userPoolId: FAKE_COGNITO_USER_POOL_ID, clientId: FAKE_COGNITO_CLIENT_ID };
const EMAIL = "pilot.owner@example.test";
const SECOND_EMAIL = "pilot.staff@example.test";
const PASSWORD = "Passpass-1111";
const BUSINESS_ID = "0191a1b2-0000-7000-8000-0000000000b1";
const SIGN_OUT_TIMEOUT_MS = 300;

let cognito: FakeCognito;

/** Loads and configures the boundary module in the current module registry (one JavaScript runtime). */
function boot(): AmplifyCognitoAuth {
  installNativeSrpDouble();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AmplifyCognitoAuth: Auth } = require("../src/auth/cognito/amplify-cognito-auth") as typeof AuthModule;
  return Auth.configure(CONFIG, { signOutTimeoutMs: SIGN_OUT_TIMEOUT_MS });
}

/** A fresh JavaScript runtime over the same device: every module, Amplify included, starts again. */
function restart(): AmplifyCognitoAuth {
  jest.resetModules();
  return boot();
}

const cognitoItems = () => [...device().secure.entries()].filter(([key]) => key.startsWith("tali.cognito.v1."));
/** Everything stored in the Cognito namespace, chunks concatenated in no particular order (for searching). */
const storedText = () =>
  cognitoItems()
    .map(([key, value]) => `${key}\n${value}`)
    .join("\n");

async function signedIn(auth: AmplifyCognitoAuth, email = EMAIL): Promise<AuthSession> {
  const result = await auth.signIn(email, PASSWORD);
  if (result.status !== "signedIn") throw new Error(`expected signedIn, got ${result.status}`);
  return result.session;
}

async function tokenOf(session: AuthSession): Promise<string> {
  const result = await session.accessToken();
  if (!result.ok) throw new Error(`expected a token, got ${result.reason}`);
  return result.token;
}

/** The `sub` claim of a synthetic token. */
function subOf(token: string): unknown {
  const payload = (token.split(".")[1] ?? "").replace(/-/gu, "+").replace(/_/gu, "/");
  return (JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))) as { sub?: unknown }).sub;
}

/** Lets every pending continuation (Amplify's included) run to completion. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function untilHeld(op: string): Promise<void> {
  for (let i = 0; i < 400 && !cognito.isHeld(op); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(cognito.isHeld(op)).toBe(true);
}

beforeEach(() => {
  resetDevice();
  jest.resetModules();
  cognito = new FakeCognito();
  globalThis.fetch = cognito.fetch;
});

afterEach(() => {
  // ADR-007 section 6.2: nothing is ever written to AsyncStorage. Not even a read happens in these flows.
  expect(asyncStorageWrites()).toEqual([]);
  expect(device().asyncStorageCalls).toEqual([]);
  expect(cognito.refusedHosts).toEqual([]);
});

describe("sign-up and confirmation", () => {
  it("signs up, confirms and resends without storing anything", async () => {
    const auth = boot();
    expect(await auth.signUp(EMAIL, PASSWORD)).toEqual({ status: "confirmationRequired" });
    expect(await auth.confirmSignUp(EMAIL, "000000")).toEqual({ status: "failed", reason: "invalidCode" });
    expect(await auth.resendSignUpCode(EMAIL)).toEqual({ status: "sent" });
    expect(await auth.confirmSignUp(EMAIL, "123456")).toEqual({ status: "confirmed" });
    expect(cognito.ops()).toEqual(["SignUp", "ConfirmSignUp", "ResendConfirmationCode", "ConfirmSignUp"]);
    expect(cognitoItems()).toEqual([]);
  });
});

describe("sign-in and persistence", () => {
  it("signs in with USER_SRP_AUTH and persists the session only in the Tali namespace", async () => {
    const session = await signedIn(boot());
    expect(cognito.ops()).toEqual(["InitiateAuth", "RespondToAuthChallenge"]);
    expect(cognito.calls[0]?.body["AuthFlow"]).toBe("USER_SRP_AUTH");
    expect(await tokenOf(session)).toBe(cognito.issued.access[0]);
    // Every key is in the namespace, opaque; values are chunked (the refresh token spans two chunks).
    expect(cognitoItems().length).toBeGreaterThan(0);
    for (const [key] of cognitoItems()) {
      expect(key).toMatch(/^tali\.cognito\.v1\.(index|m\.\d+|c\.\d+\.[01]\.\d+)$/u);
      expect(key).not.toContain(FAKE_COGNITO_SUB);
    }
    const refresh = cognito.issued.refresh[0] ?? "";
    expect(storedText()).not.toContain(refresh);
    expect(storedText()).toContain(refresh.slice(0, 512));
  });

  it("restores the session in a fresh runtime from SecureStore alone, without contacting Cognito", async () => {
    await signedIn(boot());
    const before = cognito.calls.length;
    const restored = await restart().restore();
    expect(restored.status).toBe("signedIn");
    if (restored.status !== "signedIn") return;
    expect(await tokenOf(restored.session)).toBe(cognito.issued.access[0]);
    expect(cognito.calls.length).toBe(before);
  });

  it("restores nothing on a device with no stored session", async () => {
    expect(await boot().restore()).toEqual({ status: "none" });
    expect(cognito.calls).toEqual([]);
  });

  it("never stores, sends or exposes the password", async () => {
    const auth = boot();
    await auth.signUp(EMAIL, PASSWORD);
    await signedIn(auth);
    expect(storedText()).not.toContain(PASSWORD);
    expect([...device().secure.keys()].join("\n")).not.toContain(PASSWORD);
    for (const call of cognito.calls) expect(JSON.stringify(call.body).includes(PASSWORD)).toBe(call.op === "SignUp");
  });

  it("keeps nothing of an unsupported further challenge", async () => {
    cognito.options.furtherChallenge = "NEW_PASSWORD_REQUIRED";
    const result = await boot().signIn(EMAIL, PASSWORD);
    expect(result).toEqual({ status: "unsupportedStep" });
    expect(JSON.stringify(result)).not.toContain(FAKE_CHALLENGE_SESSION);
    expect(storedText()).not.toContain(FAKE_CHALLENGE_SESSION);
    expect(cognitoItems()).toEqual([]);
  });

  it("maps a failed sign-in to a bounded reason and stores nothing", async () => {
    cognito.options.signInError = "NotAuthorizedException";
    expect(await boot().signIn(EMAIL, PASSWORD)).toEqual({ status: "failed", reason: "invalidCredentials" });
    expect(cognitoItems()).toEqual([]);
  });
});

describe("refresh", () => {
  it("rotates through GetTokensFromRefreshToken, stores the new refresh token and drops the old", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    const session = await signedIn(boot());
    const before = cognito.ops().filter((op) => op === "GetTokensFromRefreshToken").length;
    const token = await tokenOf(session);
    expect(token).toBe(cognito.issued.access.at(-1));
    expect(cognito.ops().filter((op) => op === "GetTokensFromRefreshToken")).toHaveLength(before + 1);
    expect(cognito.ops().filter((op) => op !== "GetTokensFromRefreshToken")).toEqual([
      "InitiateAuth",
      "RespondToAuthChallenge",
    ]);
    expect(cognito.calls.some((call) => call.body["AuthFlow"] === "REFRESH_TOKEN_AUTH")).toBe(false);
    const latest = cognito.issued.refresh.at(-1) ?? "";
    expect(cognito.issued.refresh.length).toBeGreaterThan(1);
    expect(storedText()).toContain(latest.slice(0, 512));
    // Earlier refresh tokens are not retained (each carries a distinct sequence prefix).
    for (const earlier of cognito.issued.refresh.slice(0, -1)) expect(storedText()).not.toContain(earlier.slice(0, 22));
    // The rotated session is what a restart restores and refreshes with.
    const restored = await restart().restore();
    expect(restored.status).toBe("signedIn");
    expect(cognito.calls.at(-1)?.body["RefreshToken"]).toBe(latest);
  });

  it("shares one refresh between concurrent callers", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    cognito.options.refreshDelayMs = 50;
    const session = await signedIn(boot());
    const before = cognito.ops().filter((op) => op === "GetTokensFromRefreshToken").length;
    const results = await Promise.all(Array.from({ length: 5 }, () => session.accessToken()));
    expect(cognito.ops().filter((op) => op === "GetTokensFromRefreshToken")).toHaveLength(before + 1);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => (result.ok ? result.token : result.reason))).size).toBe(1);
  });

  it("a refused refresh ends the session and clears the namespace; device registrations stay", async () => {
    await createSecureDeviceCredentialStore().save(BUSINESS_ID, {
      deviceId: "0191a1b2-0000-7000-8000-0000000000d1",
      credential: "synthetic-device-credential",
    });
    cognito.options.accessLifetimeSeconds = 1;
    const session = await signedIn(boot());
    cognito.options.refreshError = "NotAuthorizedException";
    expect(await session.accessToken()).toEqual<AccessTokenResult>({ ok: false, reason: "ended" });
    expect(cognitoItems()).toEqual([]);
    expect([...device().secure.keys()]).toEqual([deviceRegistrationKey(BUSINESS_ID)]);
    expect(await session.accessToken()).toEqual({ ok: false, reason: "ended" });
    expect(await restart().restore()).toEqual({ status: "none" });
  });

  it("an unreachable Cognito is retryable: the session and its stored state are kept", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    const session = await signedIn(boot());
    const stored = storedText();
    cognito.options.offline = true;
    expect(await session.accessToken()).toEqual({ ok: false, reason: "unavailable" });
    expect(storedText()).toBe(stored);
    cognito.options.offline = false;
    expect((await session.accessToken()).ok).toBe(true);
  });

  it("restoration while Cognito is unreachable keeps the stored session, and can be abandoned", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    await signedIn(boot());
    cognito.options.offline = true;
    const auth = restart();
    expect(await auth.restore()).toEqual({ status: "unavailable" });
    expect(cognitoItems().length).toBeGreaterThan(0);
    await auth.forgetStoredSession();
    expect(cognitoItems()).toEqual([]);
  });
});

describe("sign-out", () => {
  it("revokes the refresh token and clears the namespace", async () => {
    const auth = boot();
    const session = await signedIn(auth);
    await session.end({ everywhere: false });
    expect(cognito.ops()).toContain("RevokeToken");
    expect(cognito.ops()).not.toContain("GlobalSignOut");
    expect(cognitoItems()).toEqual([]);
    expect(await session.accessToken()).toEqual({ ok: false, reason: "ended" });
    expect(await restart().restore()).toEqual({ status: "none" });
  });

  it("signs out on all devices with GlobalSignOut", async () => {
    const session = await signedIn(boot());
    await session.end({ everywhere: true });
    expect(cognito.ops()).toContain("GlobalSignOut");
    expect(cognitoItems()).toEqual([]);
  });

  it("clears local state when Cognito cannot be reached", async () => {
    const session = await signedIn(boot());
    cognito.options.offline = true;
    await session.end({ everywhere: false });
    expect(cognitoItems()).toEqual([]);
  });

  it("is bounded when revocation never answers", async () => {
    const session = await signedIn(boot());
    cognito.options.revocationHangs = true;
    const started = Date.now();
    await session.end({ everywhere: true });
    expect(Date.now() - started).toBeLessThan(SIGN_OUT_TIMEOUT_MS * 10);
    expect(cognitoItems()).toEqual([]);
  });

  it("keeps device registrations", async () => {
    const store = createSecureDeviceCredentialStore();
    await store.save(BUSINESS_ID, {
      deviceId: "0191a1b2-0000-7000-8000-0000000000d1",
      credential: "synthetic-device-credential",
    });
    const session = await signedIn(boot());
    await session.end({ everywhere: true });
    expect(await store.read(BUSINESS_ID)).toEqual({
      deviceId: "0191a1b2-0000-7000-8000-0000000000d1",
      credential: "synthetic-device-credential",
    });
  });
});

describe("staff switching", () => {
  it("the next staff member's session holds nothing of the previous one", async () => {
    const auth = boot();
    const first = await signedIn(auth, EMAIL);
    const firstToken = await tokenOf(first);
    await first.end({ everywhere: false });
    cognito.options.sub = FAKE_COGNITO_SECOND_SUB;
    const second = await signedIn(auth, SECOND_EMAIL);
    expect(await tokenOf(second)).not.toBe(firstToken);
    expect(await first.accessToken()).toEqual({ ok: false, reason: "ended" });
    const firstRefresh = cognito.issued.refresh[0] ?? "";
    expect(storedText()).not.toContain(firstRefresh.slice(0, 40));
    expect(storedText()).not.toContain((cognito.issued.access[0] ?? "").slice(0, 200));
  });

  it("a sign-in over a leftover stored session revokes and clears it first, then signs in", async () => {
    await signedIn(boot(), EMAIL);
    const auth = restart();
    cognito.options.sub = FAKE_COGNITO_SECOND_SUB;
    const result: CognitoSignInResult = await auth.signIn(SECOND_EMAIL, PASSWORD);
    expect(result.status).toBe("signedIn");
    expect(cognito.ops().filter((op) => op === "RevokeToken")).toHaveLength(1);
    expect(storedText()).not.toContain((cognito.issued.refresh[0] ?? "").slice(0, 40));
  });
});

describe("session ownership: a stale operation never touches a later session", () => {
  const DEVICE = { deviceId: "0191a1b2-0000-7000-8000-0000000000d1", credential: "synthetic-device-credential" };

  for (const [op, everywhere] of [
    ["RevokeToken", false],
    ["GlobalSignOut", true],
  ] as const) {
    for (const outcome of ["answer", "fail"] as const) {
      it(`${op} of staff A that outlasts the local bound and then ${outcome === "answer" ? "succeeds" : "fails"} leaves staff B signed in`, async () => {
        const devices = createSecureDeviceCredentialStore();
        await devices.save(BUSINESS_ID, DEVICE);
        const auth = boot();
        const staffA = await signedIn(auth, EMAIL);
        cognito.holdNext(op);
        const started = Date.now();
        await staffA.end({ everywhere });
        expect(Date.now() - started).toBeLessThan(SIGN_OUT_TIMEOUT_MS * 10);
        expect(cognito.isHeld(op)).toBe(true);
        expect(cognitoItems()).toEqual([]);
        expect(await devices.read(BUSINESS_ID)).toEqual(DEVICE);

        cognito.options.sub = FAKE_COGNITO_SECOND_SUB;
        const staffB = await signedIn(auth, SECOND_EMAIL);
        const stored = storedText();
        cognito.held(op)[outcome]();
        await settled();

        expect(storedText()).toBe(stored);
        expect(subOf(await tokenOf(staffB))).toBe(FAKE_COGNITO_SECOND_SUB);
        expect(await staffA.accessToken()).toEqual({ ok: false, reason: "ended" });
        expect(await devices.read(BUSINESS_ID)).toEqual(DEVICE);
        const restored = await restart().restore();
        expect(restored.status).toBe("signedIn");
        if (restored.status === "signedIn")
          expect(subOf(await tokenOf(restored.session))).toBe(FAKE_COGNITO_SECOND_SUB);
        expect(await devices.read(BUSINESS_ID)).toEqual(DEVICE);
      });
    }
  }

  for (const outcome of ["succeeds", "fails on the network", "is refused"] as const) {
    it(`a refresh of staff A still in flight at sign-out that later ${outcome} leaves staff B's session untouched`, async () => {
      const devices = createSecureDeviceCredentialStore();
      await devices.save(BUSINESS_ID, DEVICE);
      cognito.options.accessLifetimeSeconds = 1;
      const auth = boot();
      const staffA = await signedIn(auth, EMAIL);
      cognito.holdNext("GetTokensFromRefreshToken");
      const reading = staffA.accessToken();
      await untilHeld("GetTokensFromRefreshToken");
      await staffA.end({ everywhere: false });
      expect(cognitoItems()).toEqual([]);

      cognito.options.sub = FAKE_COGNITO_SECOND_SUB;
      const staffB = await signedIn(auth, SECOND_EMAIL);
      const stored = storedText();
      if (outcome === "is refused") cognito.options.refreshError = "NotAuthorizedException";
      if (outcome === "fails on the network") cognito.held("GetTokensFromRefreshToken").fail();
      else cognito.held("GetTokensFromRefreshToken").answer();
      expect(await reading).toEqual({ ok: false, reason: "ended" });
      await settled();
      cognito.options.refreshError = undefined;

      expect(storedText()).toBe(stored);
      expect(subOf(await tokenOf(staffB))).toBe(FAKE_COGNITO_SECOND_SUB);
      expect(await devices.read(BUSINESS_ID)).toEqual(DEVICE);
    });
  }

  it("a restoration still in flight when the stored session is forgotten stores nothing once it completes", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    await signedIn(boot(), EMAIL);
    const auth = restart();
    cognito.holdNext("GetTokensFromRefreshToken");
    const restoring = auth.restore();
    await untilHeld("GetTokensFromRefreshToken");
    await auth.forgetStoredSession();
    expect(cognitoItems()).toEqual([]);

    cognito.options.sub = FAKE_COGNITO_SECOND_SUB;
    const staffB = await signedIn(auth, SECOND_EMAIL);
    const stored = storedText();
    cognito.held("GetTokensFromRefreshToken").answer();
    expect(await restoring).toEqual({ status: "none" });
    await settled();

    expect(storedText()).toBe(stored);
    expect(subOf(await tokenOf(staffB))).toBe(FAKE_COGNITO_SECOND_SUB);
  });
});
