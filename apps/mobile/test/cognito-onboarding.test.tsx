import type * as CognitoDevice from "./support/cognito-device";
import type { MobilePublicConfig } from "@tali/config/public";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { createSessionStore, SessionProvider } from "../src/auth/session-context";
import { deviceRegistrationKey } from "../src/devices/device-credential-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { asyncStorageWrites, device, installNativeSrpDouble, resetDevice } from "./support/cognito-device";
import {
  FAKE_COGNITO_CLIENT_ID,
  FAKE_COGNITO_HOST,
  FAKE_COGNITO_REGION,
  FAKE_COGNITO_USER_POOL_ID,
  FakeCognito,
} from "./support/fake-cognito";
import { apiError, BUSINESS_A, type FakeTaliApi, json, registeredUserApi, USER } from "./support/fake-tali-api";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").secureStoreMock(),
);
jest.mock("expo-crypto", () => jest.requireActual<typeof CognitoDevice>("./support/cognito-device").expoCryptoMock());
jest.mock("@react-native-async-storage/async-storage", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").asyncStorageMock(),
);

jest.setTimeout(30_000);

const CONFIG: MobilePublicConfig = {
  env: "staging",
  apiBaseUrl: "https://api.example.test",
  authMode: "cognito",
  cognito: { region: FAKE_COGNITO_REGION, userPoolId: FAKE_COGNITO_USER_POOL_ID, clientId: FAKE_COGNITO_CLIENT_ID },
};
const EMAIL = "pilot.owner@example.test";
const PASSWORD = "Passpass-1111";
const DEVICE_KEY = deviceRegistrationKey(BUSINESS_A.id);
const DEVICE_VALUE = JSON.stringify({
  deviceId: "0191a1b2-0000-7000-8000-0000000000d1",
  credential: "synthetic-device-credential",
});

let cognito: FakeCognito;
let api: FakeTaliApi;
const originalFetch = globalThis.fetch;

const cognitoItems = () => [...device().secure.keys()].filter((key) => key.startsWith("tali.cognito.v1."));

beforeAll(() => {
  installSecureRandom();
  installNativeSrpDouble();
});

beforeEach(() => {
  resetDevice();
  cognito = new FakeCognito();
  api = registeredUserApi();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.host === FAKE_COGNITO_HOST ? cognito.fetch(input, init) : api.fetch(input, init);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  expect(asyncStorageWrites()).toEqual([]);
  expect(device().asyncStorageCalls).toEqual([]);
  // Only an access token ever reaches the Tali API; no password, ID token or refresh token.
  const issued = new Set(cognito.issued.access);
  for (const request of api.requests) {
    const authorization = request.headers.get("authorization");
    if (authorization !== null) expect(issued.has(authorization.replace(/^Bearer /u, ""))).toBe(true);
    const everything = `${request.path}${request.query}${JSON.stringify(request.body ?? null)}${JSON.stringify([...request.headers])}`;
    expect(everything).not.toContain(PASSWORD);
    for (const token of [...cognito.issued.id, ...cognito.issued.refresh]) expect(everything).not.toContain(token);
  }
  expect(api.to("POST /__local/sign-in")).toEqual([]);
});

async function renderApp() {
  const store = createSessionStore(CONFIG, "android");
  const view = await render(
    <SessionProvider store={store}>
      <OnboardingApp config={CONFIG} />
    </SessionProvider>,
  );
  return { store, view };
}

async function signInThroughUi() {
  await screen.findByRole("header", { name: "Sign in" });
  await waitFor(() => {
    expect(screen.queryByLabelText("Restoring your session…")).toBeNull();
  });
  await fireEvent.changeText(screen.getByLabelText("Email address"), EMAIL);
  await fireEvent.changeText(screen.getByLabelText("Password"), PASSWORD);
  await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
}

describe("mobile Cognito onboarding", () => {
  it("signs up, confirms, signs in and continues to registration and the business picker", async () => {
    api.on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"), json(200, USER));
    api.on("POST /v1/me/registration", json(201, USER));
    await renderApp();
    await screen.findByRole("header", { name: "Sign in" });
    await waitFor(() => {
      expect(screen.queryByLabelText("Restoring your session…")).toBeNull();
    });
    await fireEvent.press(screen.getByRole("button", { name: "Create an account" }));
    await fireEvent.changeText(screen.getByLabelText("Email address"), EMAIL);
    await fireEvent.changeText(screen.getByLabelText("New password"), PASSWORD);
    await fireEvent.press(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("We sent a confirmation code to your email address.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByText("We sent a new code to your email address.")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Confirmation code"), "123456");
    await fireEvent.press(screen.getByRole("button", { name: "Confirm email" }));
    expect(await screen.findByText("Your email address is confirmed. Sign in.")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Password"), PASSWORD);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("header", { name: "Set up your profile" })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Your name"), "Ada Obi");
    await fireEvent.press(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    expect(api.to("GET /v1/me")[0]?.headers.get("authorization")).toBe(`Bearer ${cognito.issued.access[0] ?? ""}`);
    expect(cognito.ops()).toEqual([
      "SignUp",
      "ResendConfirmationCode",
      "ConfirmSignUp",
      "InitiateAuth",
      "RespondToAuthChallenge",
    ]);
  });

  it("masks the password field and clears it on submit", async () => {
    await renderApp();
    await screen.findByRole("header", { name: "Sign in" });
    await waitFor(() => {
      expect(screen.queryByLabelText("Restoring your session…")).toBeNull();
    });
    const field = screen.getByLabelText("Password");
    expect(field.props["secureTextEntry"]).toBe(true);
    expect(field.props["autoCorrect"]).toBe(false);
    cognito.options.signInError = "NotAuthorizedException";
    await fireEvent.changeText(screen.getByLabelText("Email address"), EMAIL);
    await fireEvent.changeText(field, PASSWORD);
    await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The email or password is not correct.")).toBeTruthy();
    expect(screen.getByLabelText("Password").props["value"]).toBe("");
    expect(screen.queryByText(/synthetic NotAuthorizedException/u)).toBeNull();
  });

  it("fails safely on an unsupported challenge", async () => {
    cognito.options.furtherChallenge = "SOFTWARE_TOKEN_MFA";
    await renderApp();
    await signInThroughUi();
    expect(await screen.findByText(/needs an extra sign-in step/u)).toBeTruthy();
    expect(cognitoItems()).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it("restores the stored session at the next start without signing in again", async () => {
    const first = await renderApp();
    await signInThroughUi();
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    await first.view.unmount();
    const signIns = cognito.ops().filter((op) => op === "InitiateAuth").length;
    await renderApp();
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    expect(cognito.ops().filter((op) => op === "InitiateAuth")).toHaveLength(signIns);
  });

  it("offers retry or sign-out when Cognito cannot be reached to restore", async () => {
    cognito.options.accessLifetimeSeconds = 1;
    const first = await renderApp();
    await signInThroughUi();
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    await first.view.unmount();
    cognito.options.offline = true;
    await renderApp();
    expect(await screen.findByTestId("restore-unavailable")).toBeTruthy();
    expect(cognitoItems().length).toBeGreaterThan(0);
    cognito.options.offline = false;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
  });

  it("signing out revokes, clears the stored session and keeps the device registration", async () => {
    device().secure.set(DEVICE_KEY, DEVICE_VALUE);
    await renderApp();
    await signInThroughUi();
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("You have signed out.")).toBeTruthy();
    await waitFor(() => {
      expect(cognitoItems()).toEqual([]);
    });
    expect(cognito.ops()).toContain("RevokeToken");
    expect(device().secure.get(DEVICE_KEY)).toBe(DEVICE_VALUE);
  });

  it("signing out on all devices sends GlobalSignOut", async () => {
    await renderApp();
    await signInThroughUi();
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Sign out on all devices" }));
    expect(await screen.findByText("You have signed out.")).toBeTruthy();
    await waitFor(() => {
      expect(cognitoItems()).toEqual([]);
    });
    expect(cognito.ops()).toContain("GlobalSignOut");
  });

  it("a refused refresh ends the session: sign-in again, stored session gone, device registration kept", async () => {
    device().secure.set(DEVICE_KEY, DEVICE_VALUE);
    cognito.options.accessLifetimeSeconds = 1;
    await renderApp();
    await signInThroughUi();
    expect(await screen.findByText(BUSINESS_A.name)).toBeTruthy();
    cognito.options.refreshError = "NotAuthorizedException";
    await fireEvent.press(screen.getByRole("button", { name: `Open ${BUSINESS_A.name}` }));
    expect(await screen.findByText("Your session has ended. Sign in again.")).toBeTruthy();
    await waitFor(() => {
      expect(cognitoItems()).toEqual([]);
    });
    expect(device().secure.get(DEVICE_KEY)).toBe(DEVICE_VALUE);
  });
});
