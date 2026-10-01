import type * as NodeCrypto from "node:crypto";
import type { MobilePublicConfig } from "@tali/config/public";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { IDEMPOTENCY_KEY_HEADER } from "../src/api/tali-api-client";
import { createSessionStore, SessionProvider } from "../src/auth/session-context";
import type { SessionStore } from "../src/auth/session-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import {
  apiError,
  BUSINESS_A,
  BUSINESS_B,
  createdBusinessBody,
  deferred,
  type FakeTaliApi,
  json,
  MEMBERSHIP_A,
  networkError,
  registeredUserApi,
  TOKEN,
  USER,
} from "./support/fake-tali-api";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

// Each flow drives several screens through the React Native renderer, which exceeds Jest's 5 s default on slow CI hosts.
jest.setTimeout(30_000);

const LOCAL: MobilePublicConfig = { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" };
const originalFetch = globalThis.fetch;

beforeAll(() => {
  installSecureRandom();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function renderWith(api: FakeTaliApi, config: MobilePublicConfig = LOCAL): Promise<SessionStore> {
  globalThis.fetch = api.fetch;
  const store = createSessionStore(config);
  await render(
    <SessionProvider store={store}>
      <OnboardingApp config={config} />
    </SessionProvider>,
  );
  return store;
}

async function signIn(subject = "local-user-ada") {
  await fireEvent.changeText(screen.getByLabelText("Local subject"), subject);
  await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
}

describe("mobile signed-out view", () => {
  it("offers clearly marked local development sign-in when TALI_ENV=local", async () => {
    await renderWith(registeredUserApi());
    expect(screen.getByRole("header", { name: "Local development sign-in" })).toBeTruthy();
    expect(screen.getByText(/not a production sign-in method/u)).toBeTruthy();
  });

  it.each(["test", "development", "staging", "production"] as const)(
    "offers no sign-in and calls nothing when TALI_ENV=%s",
    async (env) => {
      const api = registeredUserApi();
      await renderWith(api, { env, apiBaseUrl: "https://api.example.test", authMode: "unavailable" });
      expect(screen.getByTestId("sign-in-unavailable")).toBeTruthy();
      expect(screen.queryByLabelText("Local subject")).toBeNull();
      expect(api.requests).toHaveLength(0);
    },
  );

  it("validates the subject with the shared contract before calling the API", async () => {
    const api = registeredUserApi();
    await renderWith(api);
    await signIn("bad subject!");
    expect(screen.getByText(/The subject must be 1 to 64 letters/u)).toBeTruthy();
    expect(api.requests).toHaveLength(0);
  });
});

describe("mobile onboarding flow", () => {
  it("signs in, registers, creates the first business, shows the overview and signs out", async () => {
    const api = registeredUserApi([])
      .on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"))
      .on("POST /v1/me/registration", json(201, USER))
      .on("POST /v1/businesses", json(201, createdBusinessBody()))
      .on(
        "GET /v1/me/businesses",
        json(200, { items: [], nextCursor: null }),
        json(200, { items: [{ business: BUSINESS_A, membership: MEMBERSHIP_A }], nextCursor: null }),
      );
    const store = await renderWith(api);
    await signIn();

    expect(await screen.findByRole("header", { name: "Set up your profile" })).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Your name"), "Ada Obi");
    await fireEvent.press(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("header", { name: "Create your first business" })).toBeTruthy();
    expect(screen.getByText("Signed in as Ada Obi")).toBeTruthy();
    expect(screen.getByText("Currency: NGN")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Business name"), "Ada Provisions");
    await fireEvent.changeText(screen.getByLabelText("Time zone"), "Africa/Lagos");
    await fireEvent.press(screen.getByRole("button", { name: "Create business" }));

    expect(await screen.findByRole("header", { name: "Ada Provisions" })).toBeTruthy();
    expect(screen.getByTestId("overview-currency").props["children"]).toEqual(["Currency: ", "NGN"]);
    expect(screen.getByTestId("overview-time-zone").props["children"]).toEqual(["Time zone: ", "Africa/Lagos"]);
    expect(screen.getByTestId("overview-default-location").props["children"]).toEqual([
      "Default location: ",
      "Ada Provisions",
    ]);
    expect(screen.queryByText(/Members/u)).toBeNull();
    expect(screen.queryByText(new RegExp(TOKEN, "u"))).toBeNull();
    expect(api.to("POST /v1/businesses")[0]?.body).toEqual({
      name: "Ada Provisions",
      currencyCode: "NGN",
      timeZone: "Africa/Lagos",
    });

    await fireEvent.press(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("header", { name: "Local development sign-in" })).toBeTruthy();
    expect(screen.getByText("You have signed out.")).toBeTruthy();
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", user: undefined, selectedBusinessId: undefined });
  });

  it("shows the picker for several businesses and opens the selected one", async () => {
    await renderWith(registeredUserApi([BUSINESS_A, BUSINESS_B]));
    await signIn();
    expect(await screen.findByRole("header", { name: "Choose a business" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Obi General Store" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Open Ada Provisions" }));
    expect(await screen.findByRole("header", { name: "Ada Provisions" })).toBeTruthy();
    expect(screen.getByText("Your role: Owner")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Switch business" }));
    expect(await screen.findByRole("header", { name: "Choose a business" })).toBeTruthy();
  });

  it("returns to the picker with generic wording when the selected business answers NOT_FOUND", async () => {
    await renderWith(
      registeredUserApi([BUSINESS_A, BUSINESS_B]).on(
        `GET /v1/businesses/${BUSINESS_A.id}`,
        apiError(404, "NOT_FOUND", "Business not found"),
      ),
    );
    await signIn();
    await fireEvent.press(await screen.findByRole("button", { name: "Open Ada Provisions" }));
    expect(await screen.findByText("That business is no longer available to you.")).toBeTruthy();
    expect(await screen.findByRole("header", { name: "Choose a business" })).toBeTruthy();
  });

  it("returns to sign-in when the token is rejected", async () => {
    await renderWith(registeredUserApi().on("GET /v1/me/businesses", apiError(401, "UNAUTHENTICATED")));
    await signIn();
    expect(await screen.findByText("Your session has ended. Sign in again.")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Local development sign-in" })).toBeTruthy();
  });
});

describe("mobile CreateBusiness submission safety", () => {
  async function toCreateForm(api: FakeTaliApi) {
    await renderWith(api);
    await signIn();
    await fireEvent.changeText(await screen.findByLabelText("Business name"), "Ada Provisions");
    await fireEvent.changeText(screen.getByLabelText("Time zone"), "Africa/Lagos");
  }

  it("sends one request for repeated presses while the first is in flight", async () => {
    const pending = deferred();
    const api = registeredUserApi([]).on("POST /v1/businesses", pending.reply);
    await toCreateForm(api);
    await fireEvent.press(screen.getByRole("button", { name: "Create business" }));
    const busy = await screen.findByRole("button", { name: "Creating business…" });
    expect(busy.props["accessibilityState"]).toMatchObject({ disabled: true, busy: true });
    await fireEvent.press(busy);
    await act(async () => {
      pending.resolve(201, createdBusinessBody());
      await Promise.resolve();
    });
    expect(await screen.findByRole("header", { name: "Ada Provisions" })).toBeTruthy();
    expect(api.to("POST /v1/businesses")).toHaveLength(1);
  });

  it("retries a network failure with the same Idempotency-Key", async () => {
    const api = registeredUserApi([]).on("POST /v1/businesses", networkError, json(201, createdBusinessBody()));
    await toCreateForm(api);
    await fireEvent.press(screen.getByRole("button", { name: "Create business" }));
    expect(await screen.findByText(/Tali could not be reached/u)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Try again with the same details" }));
    expect(await screen.findByRole("header", { name: "Ada Provisions" })).toBeTruthy();
    const keys = api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("a local development session is memory only", () => {
  it("a new session (an app restart) starts signed out", async () => {
    const api = registeredUserApi();
    globalThis.fetch = api.fetch;
    const first = createSessionStore(LOCAL);
    await first.signInLocal("local-user-ada");
    expect(first.getSnapshot().phase).toBe("choosingBusiness");
    expect(createSessionStore(LOCAL).getSnapshot().phase).toBe("signedOut");
  });
});
