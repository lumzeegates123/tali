import type { WebPublicConfig } from "@tali/config/public";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessToken } from "../src/lib/api-client/tali-api-client";
import { TaliApiClient } from "../src/lib/api-client/tali-api-client";
import type { AccessTokenResult, AuthSession } from "../src/lib/auth/auth-session";
import type {
  CognitoAuth,
  CognitoConfirmResult,
  CognitoResendResult,
  CognitoSignInResult,
  CognitoSignUpResult,
} from "../src/lib/auth/cognito-auth";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { UNSUPPORTED_STEP_TEXT } from "../src/onboarding/cognito-sign-in";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { apiError, type FakeTaliApi, json, registeredUserApi, settle, USER } from "./support/fake-tali-api";

const COGNITO_CONFIG: WebPublicConfig = {
  env: "staging",
  apiBaseUrl: "https://api.example.test",
  authMode: "cognito",
  cognito: { region: "eu-west-1", userPoolId: "eu-west-1_SyntheticPool1", clientId: "syntheticwebclient0000000001" },
};
const EMAIL = "pilot.owner@example.test";
const PASSWORD = "Passpass-1111";

/** An auth session whose tokens rotate per read, recording how it ends. */
class FakeAuthSession implements AuthSession {
  readonly ends: { everywhere: boolean }[] = [];
  readonly handedOut: string[] = [];
  next: AccessTokenResult["ok"] | "ended" | "unavailable" = true;
  #count = 0;

  async accessToken(): Promise<AccessTokenResult> {
    if (this.ends.length > 0 || this.next === "ended") return { ok: false, reason: "ended" };
    if (this.next === "unavailable") return { ok: false, reason: "unavailable" };
    this.#count += 1;
    const token = `cognito-access-${String(this.#count)}.payload.signature`;
    this.handedOut.push(token);
    return { ok: true, token: token as AccessToken };
  }

  async end(options: { readonly everywhere: boolean }): Promise<void> {
    this.ends.push({ everywhere: options.everywhere });
  }
}

class FakeCognitoAuth implements CognitoAuth {
  readonly passwordsSeen: string[] = [];
  readonly sessions: FakeAuthSession[] = [];
  signInResult: CognitoSignInResult["status"] | "failed" = "signedIn";
  confirmed = false;

  async signUp(_email: string, password: string): Promise<CognitoSignUpResult> {
    this.passwordsSeen.push(password);
    return { status: "confirmationRequired" };
  }

  async confirmSignUp(_email: string, code: string): Promise<CognitoConfirmResult> {
    if (code !== "123456") return { status: "failed", reason: "invalidCode" };
    this.confirmed = true;
    return { status: "confirmed" };
  }

  async resendSignUpCode(): Promise<CognitoResendResult> {
    return { status: "sent" };
  }

  async signIn(_email: string, password: string): Promise<CognitoSignInResult> {
    this.passwordsSeen.push(password);
    switch (this.signInResult) {
      case "signedIn": {
        const session = new FakeAuthSession();
        this.sessions.push(session);
        return { status: "signedIn", session };
      }
      case "confirmationRequired":
        return { status: "confirmationRequired" };
      case "unsupportedStep":
        return { status: "unsupportedStep" };
      case "failed":
        return { status: "failed", reason: "invalidCredentials" };
    }
  }
}

function storeFor(api: FakeTaliApi): SessionStore {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  return new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
}

function renderCognito(api: FakeTaliApi, cognito = new FakeCognitoAuth()) {
  vi.stubGlobal("fetch", api.fetch);
  render(<OnboardingApp config={COGNITO_CONFIG} cognito={cognito} />);
  return cognito;
}

async function fillAndSubmit(fields: Record<string, string>, button: string) {
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
    await settle();
  });
}

function expectPasswordNowhere(api: FakeTaliApi) {
  expect(JSON.stringify(api.requests)).not.toContain(PASSWORD);
  expect(window.location.href).not.toContain(PASSWORD);
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
  expect(document.body.innerHTML).not.toContain(PASSWORD);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session store with a refreshing auth session", () => {
  it("asks the auth session for a current token on every API call and never keeps one", async () => {
    const api = registeredUserApi();
    const store = storeFor(api);
    const session = new FakeAuthSession();
    await store.beginSession(session);
    expect(store.getSnapshot().phase).toBe("choosingBusiness");
    const sent = api.requests.map((request) => request.headers.get("authorization"));
    expect(sent).toEqual(session.handedOut.map((token) => `Bearer ${token}`));
    expect(new Set(sent).size).toBe(sent.length);
    expect(JSON.stringify(store.getSnapshot())).not.toContain("cognito-access");
  });

  it("a session that can no longer refresh ends like a 401: signed out, nothing kept", async () => {
    const api = registeredUserApi();
    const store = storeFor(api);
    const session = new FakeAuthSession();
    await store.beginSession(session);
    session.next = "ended";
    await store.loadMembers("0191a1b2-0000-7000-8000-0000000000b1");
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", notice: "sessionEnded", user: undefined });
    expect(session.ends).toEqual([{ everywhere: false }]);
  });

  it("an unreachable identity provider is a retryable network failure, not a sign-out", async () => {
    const api = registeredUserApi();
    const store = storeFor(api);
    const session = new FakeAuthSession();
    session.next = "unavailable";
    await store.beginSession(session);
    expect(store.getSnapshot()).toMatchObject({ phase: "error", error: { action: "checkUser" } });
    expect(session.ends).toEqual([]);
    session.next = true;
    await store.retry();
    expect(store.getSnapshot().phase).toBe("choosingBusiness");
  });

  it("an API 401 ends the auth session (revocation) and signs out", async () => {
    const api = registeredUserApi().on("GET /v1/me/businesses", apiError(401, "UNAUTHENTICATED"));
    const store = storeFor(api);
    const session = new FakeAuthSession();
    await store.beginSession(session);
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", notice: "sessionEnded" });
    expect(session.ends).toEqual([{ everywhere: false }]);
  });

  it("sign-out revokes; sign-out everywhere uses the global sign-out", async () => {
    const store = storeFor(registeredUserApi());
    const first = new FakeAuthSession();
    await store.beginSession(first);
    store.signOut();
    expect(first.ends).toEqual([{ everywhere: false }]);
    const second = new FakeAuthSession();
    await store.beginSession(second);
    store.signOut({ everywhere: true });
    expect(second.ends).toEqual([{ everywhere: true }]);
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", notice: "signedOut" });
  });

  it("refuses a second session while one is active, and ends the refused one", async () => {
    const store = storeFor(registeredUserApi());
    await store.beginSession(new FakeAuthSession());
    const extra = new FakeAuthSession();
    await store.beginSession(extra);
    expect(extra.ends).toEqual([{ everywhere: false }]);
    expect(store.getSnapshot().phase).toBe("choosingBusiness");
  });

  it("a DISABLED user's session is ended", async () => {
    const api = registeredUserApi().on("GET /v1/me", apiError(403, "USER_DISABLED"));
    const store = storeFor(api);
    const session = new FakeAuthSession();
    await store.beginSession(session);
    expect(store.getSnapshot()).toMatchObject({ phase: "error" });
    expect(session.ends).toEqual([{ everywhere: false }]);
  });
});

describe("Cognito sign-in screens", () => {
  it("offers email + password sign-in, never the local subject form", () => {
    renderCognito(registeredUserApi());
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
    expect(screen.queryByLabelText("Local subject")).toBeNull();
    expect(screen.queryByText(/local development/iu)).toBeNull();
    expect(screen.getByLabelText("Password").getAttribute("type")).toBe("password");
  });

  it("signs in, then follows the existing registration handoff; the password reaches only Cognito", async () => {
    const api = registeredUserApi()
      .on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"))
      .on("POST /v1/me/registration", json(201, USER));
    const cognito = renderCognito(api);
    await fillAndSubmit({ "Email address": EMAIL, Password: PASSWORD }, "Sign in");

    expect(cognito.passwordsSeen).toEqual([PASSWORD]);
    expect(await screen.findByLabelText("Your name")).toBeDefined();
    const [session] = cognito.sessions;
    expect(api.to("GET /v1/me")[0]?.headers.get("authorization")).toBe(`Bearer ${session?.handedOut[0] ?? ""}`);
    expectPasswordNowhere(api);

    await fillAndSubmit({ "Your name": "Ada Obi" }, "Continue");
    expect(api.to("POST /v1/me/registration")[0]?.body).toEqual({ displayName: "Ada Obi" });
    expect(JSON.stringify(api.requests)).not.toContain(EMAIL);
    expectPasswordNowhere(api);
  });

  it("clears the password field after a failed sign-in and shows bounded wording", async () => {
    const cognito = new FakeCognitoAuth();
    cognito.signInResult = "failed";
    const api = registeredUserApi();
    renderCognito(api, cognito);
    await fillAndSubmit({ "Email address": EMAIL, Password: PASSWORD }, "Sign in");
    expect(screen.getByTestId("cognito-message").textContent).toBe("The email or password is not correct.");
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("");
    expect(api.requests).toHaveLength(0);
    expectPasswordNowhere(api);
  });

  it("an unsupported extra Cognito step fails safely with fixed wording", async () => {
    const cognito = new FakeCognitoAuth();
    cognito.signInResult = "unsupportedStep";
    const api = registeredUserApi();
    renderCognito(api, cognito);
    await fillAndSubmit({ "Email address": EMAIL, Password: PASSWORD }, "Sign in");
    expect(screen.getByRole("alert").textContent).toBe(UNSUPPORTED_STEP_TEXT);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
    expect(api.requests).toHaveLength(0);
    expectPasswordNowhere(api);
  });

  it("signs up, confirms the email with a code (and resends), then signs in", async () => {
    const api = registeredUserApi();
    const cognito = renderCognito(api);
    fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
    await fillAndSubmit({ "Email address": EMAIL, Password: PASSWORD }, "Create account");
    expect(screen.getByRole("heading", { name: "Confirm your email" })).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
      await settle();
    });
    expect(screen.getByTestId("cognito-message").textContent).toBe("We sent a new code to your email address.");
    await fillAndSubmit({ "Confirmation code": "000000" }, "Confirm email");
    expect(screen.getByTestId("cognito-message").textContent).toBe("That code is not correct. Check it and try again.");
    await fillAndSubmit({ "Confirmation code": "123456" }, "Confirm email");
    expect(cognito.confirmed).toBe(true);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
    await fillAndSubmit({ Password: PASSWORD }, "Sign in");
    expect(await screen.findByRole("heading", { name: "Choose a business" })).toBeDefined();
    expectPasswordNowhere(api);
  });

  it("an unconfirmed account is taken to email confirmation", async () => {
    const cognito = new FakeCognitoAuth();
    cognito.signInResult = "confirmationRequired";
    renderCognito(registeredUserApi(), cognito);
    await fillAndSubmit({ "Email address": EMAIL, Password: PASSWORD }, "Sign in");
    expect(screen.getByRole("heading", { name: "Confirm your email" })).toBeDefined();
  });

  it("offers sign-out on all devices, which ends the session globally", async () => {
    const cognito = renderCognito(registeredUserApi());
    await fillAndSubmit({ "Email address": EMAIL, Password: PASSWORD }, "Sign in");
    await screen.findByRole("heading", { name: "Choose a business" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out on all devices" }));
    expect(cognito.sessions[0]?.ends).toEqual([{ everywhere: true }]);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
    expect(screen.getByText("You have signed out.")).toBeDefined();
  });

  it("validates the email locally before contacting Cognito", async () => {
    const cognito = renderCognito(registeredUserApi());
    await fillAndSubmit({ "Email address": "not-an-email", Password: PASSWORD }, "Sign in");
    expect(cognito.passwordsSeen).toEqual([]);
    expect(screen.getByText("Error: Enter a valid email address.")).toBeDefined();
  });
});
