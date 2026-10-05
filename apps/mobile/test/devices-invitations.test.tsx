import type * as NodeCrypto from "node:crypto";
import type { MobilePublicConfig } from "@tali/config/public";
import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER } from "@tali/shared";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { createSessionStore, SessionProvider } from "../src/auth/session-context";
import { parseInvitationInput, SessionStore } from "../src/auth/session-store";
import {
  createSecureDeviceCredentialStore,
  deviceRegistrationKey,
  type SecureStoreModule,
} from "../src/devices/device-credential-store";
import { isUuidV7 } from "@tali/domain/kernel";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import {
  apiError,
  BUSINESS_A,
  BUSINESS_B,
  type FakeTaliApi,
  json,
  LOCATION_A,
  MEMBERSHIP_A,
  networkError,
  registeredUserApi,
  settle,
} from "./support/fake-tali-api";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

/** An in-memory stand-in for the platform keystore; no native module is used in tests. */
const mockSecureItems = new Map<string, string>();
const mockSecureCalls: { op: string; key: string; options: unknown }[] = [];
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: (key: string, options: unknown) => {
    mockSecureCalls.push({ op: "get", key, options });
    return Promise.resolve(mockSecureItems.get(key) ?? null);
  },
  setItemAsync: (key: string, value: string, options: unknown) => {
    mockSecureCalls.push({ op: "set", key, options });
    mockSecureItems.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string, options: unknown) => {
    mockSecureCalls.push({ op: "delete", key, options });
    mockSecureItems.delete(key);
    return Promise.resolve();
  },
}));

jest.setTimeout(30_000);

const LOCAL: MobilePublicConfig = { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" };
/** Synthetic, low-entropy stand-ins for one-time secrets. */
const CREDENTIAL = `tali_dev_${"y".repeat(43)}`;
const INVITATION_TOKEN = `tali_inv_${"x".repeat(43)}`;
const DEVICE = {
  id: "0191a1b2-0000-7000-8000-0000000000d1",
  platform: "ANDROID",
  label: "Front counter",
  status: "ACTIVE",
};
const DEVICES_ROUTE = `POST /v1/businesses/${BUSINESS_A.id}/devices`;
const ACCEPT_ROUTE = "POST /v1/invitations/accept";
const originalFetch = globalThis.fetch;

beforeAll(() => {
  installSecureRandom();
});

beforeEach(() => {
  mockSecureItems.clear();
  mockSecureCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function storeFor(api: FakeTaliApi, android = true): SessionStore {
  const client = new TaliApiClient({ baseUrl: LOCAL.apiBaseUrl, createCorrelationId: () => "c-1", fetch: api.fetch });
  return new SessionStore({
    api: client,
    newIdempotencyKey: newUuidV7,
    deviceRegistrationSupported: android,
    deviceStore: createSecureDeviceCredentialStore(),
  });
}

function apiWithBothBusinesses(): FakeTaliApi {
  return registeredUserApi([BUSINESS_A, BUSINESS_B])
    .on(`GET /v1/businesses/${BUSINESS_B.id}`, json(200, BUSINESS_B))
    .on(
      `GET /v1/businesses/${BUSINESS_B.id}/locations`,
      json(200, { items: [{ ...LOCATION_A, id: "0191a1b2-0000-7000-8000-0000000000b1" }], nextCursor: null }),
    );
}

async function selected(store: SessionStore, businessId = BUSINESS_A.id): Promise<void> {
  if (store.getSnapshot().phase === "signedOut") await store.signInLocal("local-user-ada");
  store.selectBusiness(businessId);
  await settle();
}

function deviceHeadersOf(api: FakeTaliApi) {
  return api.requests.map((request) => ({
    route: `${request.method} ${request.path}`,
    deviceId: request.headers.get(DEVICE_ID_HEADER),
    credential: request.headers.get(DEVICE_CREDENTIAL_HEADER),
  }));
}

describe("device credential store", () => {
  it("keeps one keystore entry per business with only the device ID and credential", async () => {
    const store = createSecureDeviceCredentialStore();
    await store.save(BUSINESS_A.id, { deviceId: DEVICE.id, credential: CREDENTIAL });
    expect([...mockSecureItems.keys()]).toEqual([`tali.device.v1.${BUSINESS_A.id}`]);
    expect(JSON.parse(mockSecureItems.get(deviceRegistrationKey(BUSINESS_A.id)) ?? "")).toEqual({
      deviceId: DEVICE.id,
      credential: CREDENTIAL,
    });
    expect(mockSecureCalls[0]?.options).toEqual({ keychainAccessible: 6 });
    expect(await store.read(BUSINESS_A.id)).toEqual({ deviceId: DEVICE.id, credential: CREDENTIAL });
    expect(await store.read(BUSINESS_B.id)).toBeUndefined();
    await store.clear(BUSINESS_A.id);
    expect(mockSecureItems.size).toBe(0);
  });

  it("ignores malformed entries and refuses a key without a business ID", async () => {
    const fake: SecureStoreModule = {
      getItemAsync: () => Promise.resolve('{"deviceId":"nope","credential":"x"}'),
      setItemAsync: () => Promise.resolve(),
      deleteItemAsync: () => Promise.resolve(),
    };
    expect(await createSecureDeviceCredentialStore(fake).read(BUSINESS_A.id)).toBeUndefined();
    expect(() => deviceRegistrationKey("../other")).toThrow("A device registration needs a business ID");
    expect(() => deviceRegistrationKey(BUSINESS_A.id.toUpperCase())).toThrow();
  });
});

describe("session store: device registration (Android)", () => {
  it("registers once with a UUIDv7 key, stores the credential and never exposes it in the snapshot", async () => {
    const api = registeredUserApi().on(
      DEVICES_ROUTE,
      networkError,
      json(201, { device: DEVICE, credentialAvailable: true, credential: CREDENTIAL }),
    );
    const store = storeFor(api);
    await selected(store);
    expect(store.getSnapshot().device).toBe("unregistered");

    expect(await store.registerDevice("  Front counter ")).toMatchObject({ status: "failed" });
    expect(await store.registerDevice("Front counter")).toEqual({ status: "registered" });
    const sent = api.to(DEVICES_ROUTE);
    expect(sent.map((request) => request.body)).toEqual([
      { platform: "ANDROID", label: "Front counter" },
      { platform: "ANDROID", label: "Front counter" },
    ]);
    const keys = sent.map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "");
    expect(isUuidV7(keys[0] ?? "")).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expect(sent.every((request) => request.headers.get(DEVICE_ID_HEADER) === null)).toBe(true);

    expect(store.getSnapshot().device).toBe("registered");
    expect(JSON.stringify(store.getSnapshot())).not.toContain(CREDENTIAL);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(DEVICE.id);
    expect(await createSecureDeviceCredentialStore().read(BUSINESS_A.id)).toEqual({
      deviceId: DEVICE.id,
      credential: CREDENTIAL,
    });
    expect(await store.registerDevice("Again")).toEqual({ status: "ignored" });
  });

  it("validates the label and reports a replay without a credential or a failed save", async () => {
    const api = registeredUserApi().on(DEVICES_ROUTE, json(201, { device: DEVICE, credentialAvailable: false }));
    const store = storeFor(api);
    await selected(store);
    expect(await store.registerDevice("   ")).toEqual({ status: "invalid" });
    expect(await store.registerDevice("x".repeat(61))).toEqual({ status: "invalid" });
    expect(api.to(DEVICES_ROUTE)).toHaveLength(0);
    expect(await store.registerDevice("Front counter")).toEqual({ status: "credentialUnavailable" });
    expect(store.getSnapshot().device).toBe("unregistered");
    expect(mockSecureItems.size).toBe(0);

    const failingStore = new SessionStore({
      api: new TaliApiClient({
        baseUrl: LOCAL.apiBaseUrl,
        createCorrelationId: () => "c-1",
        fetch: registeredUserApi().on(
          DEVICES_ROUTE,
          json(201, { device: DEVICE, credentialAvailable: true, credential: CREDENTIAL }),
        ).fetch,
      }),
      newIdempotencyKey: newUuidV7,
      deviceRegistrationSupported: true,
      deviceStore: {
        read: () => Promise.resolve(undefined),
        save: () => Promise.reject(new Error("keystore unavailable")),
        clear: () => Promise.resolve(),
      },
    });
    await selected(failingStore);
    expect(await failingStore.registerDevice("Front counter")).toEqual({ status: "storageFailed" });
    expect(failingStore.getSnapshot().device).toBe("unregistered");
  });

  it("sends device headers only on business-scoped requests for the registered business", async () => {
    mockSecureItems.set(
      deviceRegistrationKey(BUSINESS_A.id),
      JSON.stringify({ deviceId: DEVICE.id, credential: CREDENTIAL }),
    );
    const api = apiWithBothBusinesses();
    const store = storeFor(api);
    await selected(store, BUSINESS_A.id);
    expect(store.getSnapshot().device).toBe("registered");
    await store.loadBusinessOverview(BUSINESS_A.id);
    await store.loadMembers(BUSINESS_A.id);
    store.changeBusiness();
    await selected(store, BUSINESS_B.id);
    expect(store.getSnapshot().device).toBe("unregistered");
    await store.loadBusinessOverview(BUSINESS_B.id);

    for (const entry of deviceHeadersOf(api)) {
      const registeredBusiness = entry.route.includes(`/v1/businesses/${BUSINESS_A.id}`);
      expect(entry).toEqual({
        route: entry.route,
        deviceId: registeredBusiness ? DEVICE.id : null,
        credential: registeredBusiness ? CREDENTIAL : null,
      });
    }
    expect(deviceHeadersOf(api).filter((entry) => entry.deviceId !== null).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the registration across sign-out and an app restart", async () => {
    const api = registeredUserApi().on(
      DEVICES_ROUTE,
      json(201, { device: DEVICE, credentialAvailable: true, credential: CREDENTIAL }),
    );
    const first = storeFor(api);
    await selected(first);
    await first.registerDevice("Front counter");
    first.signOut();
    expect(first.getSnapshot().device).toBe("none");
    expect(mockSecureItems.size).toBe(1);

    const restarted = storeFor(api);
    await selected(restarted);
    expect(restarted.getSnapshot().device).toBe("registered");
    await restarted.loadBusinessOverview(BUSINESS_A.id);
    expect(api.to(`GET /v1/businesses/${BUSINESS_A.id}`).at(-1)?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE.id);
  });

  it("on DEVICE_NOT_TRUSTED clears the registration, asks to register again and does not re-register", async () => {
    mockSecureItems.set(
      deviceRegistrationKey(BUSINESS_A.id),
      JSON.stringify({ deviceId: DEVICE.id, credential: CREDENTIAL }),
    );
    const api = registeredUserApi().on(
      `GET /v1/businesses/${BUSINESS_A.id}`,
      apiError(403, "DEVICE_NOT_TRUSTED", "This device is not trusted for this business"),
      json(200, BUSINESS_A),
    );
    const store = storeFor(api);
    await selected(store);
    const refused = await store.loadBusinessOverview(BUSINESS_A.id);
    expect(refused).toMatchObject({ ok: false, failure: { code: "DEVICE_NOT_TRUSTED" } });
    expect(store.getSnapshot()).toMatchObject({ device: "untrusted", phase: "businessSelected" });
    expect(mockSecureItems.size).toBe(0);
    expect(api.to(DEVICES_ROUTE)).toHaveLength(0);

    const retried = await store.loadBusinessOverview(BUSINESS_A.id);
    expect(retried.ok).toBe(true);
    expect(api.to(`GET /v1/businesses/${BUSINESS_A.id}`).at(-1)?.headers.get(DEVICE_ID_HEADER)).toBeNull();
    expect(api.to(DEVICES_ROUTE)).toHaveLength(0);
  });

  it("never touches the keystore or offers registration on other platforms", async () => {
    const api = registeredUserApi();
    const store = storeFor(api, false);
    await selected(store);
    expect(store.getSnapshot().device).toBe("unsupported");
    expect(await store.registerDevice("Phone")).toEqual({ status: "ignored" });
    await store.loadBusinessOverview(BUSINESS_A.id);
    expect(mockSecureCalls).toEqual([]);
    expect(deviceHeadersOf(api).every((entry) => entry.deviceId === null)).toBe(true);
  });
});

describe("session store: accepting an invitation by paste", () => {
  it.each([
    [`http://127.0.0.1:3911/invitations/accept#token=${INVITATION_TOKEN}`, INVITATION_TOKEN],
    [`  ${INVITATION_TOKEN}  `, INVITATION_TOKEN],
    ["https://app.example/invitations/accept#token=", undefined],
    ["two words", undefined],
    ["", undefined],
  ])("parses %j", (input, expected) => {
    expect(parseInvitationInput(input)).toBe(expected);
  });

  it("sends the token in the body only, then shows the new business in the picker", async () => {
    const api = registeredUserApi().on(
      ACCEPT_ROUTE,
      json(200, {
        business: BUSINESS_B,
        membership: { id: "0191a1b2-0000-7000-8000-0000000000b2", role: "CASHIER", status: "ACTIVE" },
      }),
    );
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    expect(await store.acceptInvitation("not a link")).toEqual({ status: "invalid" });
    expect(api.to(ACCEPT_ROUTE)).toHaveLength(0);

    api.on(
      "GET /v1/me/businesses",
      json(200, {
        items: [
          { business: BUSINESS_A, membership: MEMBERSHIP_A },
          { business: BUSINESS_B, membership: { id: "0191a1b2-0000-7000-8000-0000000000b2", role: "CASHIER" } },
        ],
        nextCursor: null,
      }),
    );
    const outcome = await store.acceptInvitation(`http://127.0.0.1:3911/invitations/accept#token=${INVITATION_TOKEN}`);
    expect(outcome).toEqual({ status: "accepted", businessName: BUSINESS_B.name });
    expect(api.to(ACCEPT_ROUTE).map((request) => request.body)).toEqual([{ token: INVITATION_TOKEN }]);
    for (const request of api.requests) expect(`${request.path}${request.query}`).not.toContain(INVITATION_TOKEN);
    expect(store.getSnapshot()).toMatchObject({ phase: "choosingBusiness", notice: "invitationAccepted" });
    expect(store.getSnapshot().businesses.map((item) => item.business.id)).toEqual([BUSINESS_A.id, BUSINESS_B.id]);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(INVITATION_TOKEN);
    expect(mockSecureItems.size).toBe(0);
  });
});

async function renderOn(platform: string, api: FakeTaliApi): Promise<SessionStore> {
  globalThis.fetch = api.fetch;
  const store = createSessionStore(LOCAL, platform);
  await render(
    <SessionProvider store={store}>
      <OnboardingApp config={LOCAL} />
    </SessionProvider>,
  );
  return store;
}

async function signInAndOpenBusinessA() {
  await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
  await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
  await fireEvent.press(await screen.findByRole("button", { name: `Open ${BUSINESS_A.name}` }));
  await screen.findByRole("header", { name: BUSINESS_A.name });
}

describe("mobile device and invitation screens", () => {
  it("registers this Android device from the business overview", async () => {
    const api = registeredUserApi().on(
      DEVICES_ROUTE,
      json(201, { device: DEVICE, credentialAvailable: true, credential: CREDENTIAL }),
    );
    await renderOn("android", api);
    await signInAndOpenBusinessA();
    expect(await screen.findByText("This device is not registered for this business.")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Device name"), "Front counter");
    await fireEvent.press(screen.getByRole("button", { name: "Register this device" }));
    expect(await screen.findByText("This device is registered for this business.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(CREDENTIAL, "u"))).toBeNull();
  });

  it("shows the re-registration message after DEVICE_NOT_TRUSTED and waits for the user", async () => {
    mockSecureItems.set(
      deviceRegistrationKey(BUSINESS_A.id),
      JSON.stringify({ deviceId: DEVICE.id, credential: CREDENTIAL }),
    );
    const api = registeredUserApi().on(
      `GET /v1/businesses/${BUSINESS_A.id}`,
      apiError(403, "DEVICE_NOT_TRUSTED"),
      json(200, BUSINESS_A),
    );
    await renderOn("android", api);
    await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
    await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
    await fireEvent.press(await screen.findByRole("button", { name: `Open ${BUSINESS_A.name}` }));
    expect((await screen.findAllByText("This device needs to be registered again.")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Register this device" })).toBeTruthy();
    expect(api.to(DEVICES_ROUTE)).toHaveLength(0);
    expect(mockSecureItems.size).toBe(0);
  });

  it("offers no device registration on iOS and does not crash", async () => {
    const api = registeredUserApi();
    await renderOn("ios", api);
    await signInAndOpenBusinessA();
    expect(screen.queryByTestId("device-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Register this device" })).toBeNull();
    expect(mockSecureCalls).toEqual([]);
  });

  it("accepts a pasted invitation link and clears the field", async () => {
    const api = registeredUserApi().on(
      ACCEPT_ROUTE,
      json(200, {
        business: BUSINESS_B,
        membership: { id: "0191a1b2-0000-7000-8000-0000000000b2", role: "CASHIER", status: "ACTIVE" },
      }),
    );
    await renderOn("android", api);
    await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
    await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
    const field = await screen.findByLabelText("Invitation link or code");
    await fireEvent.changeText(field, `http://127.0.0.1:3911/invitations/accept#token=${INVITATION_TOKEN}`);
    await fireEvent.press(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("Invitation accepted. The business is now in your list.")).toBeTruthy();
    expect(api.to(ACCEPT_ROUTE).map((request) => request.body)).toEqual([{ token: INVITATION_TOKEN }]);
    expect(screen.getByLabelText("Invitation link or code").props["value"]).toBe("");
  });

  it("shows one message for an unusable invitation", async () => {
    const api = registeredUserApi().on(ACCEPT_ROUTE, apiError(404, "NOT_FOUND", "Invitation not found"));
    await renderOn("android", api);
    await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
    await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
    await fireEvent.changeText(await screen.findByLabelText("Invitation link or code"), INVITATION_TOKEN);
    await fireEvent.press(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/This invitation cannot be used\./u)).toBeTruthy();
  });
});
