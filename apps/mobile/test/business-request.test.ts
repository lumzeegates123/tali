import type * as NodeCrypto from "node:crypto";
import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER } from "@tali/shared";
import { type AccessToken, TaliApiClient } from "../src/api/tali-api-client";
import type { AccessTokenResult, AuthSession } from "../src/auth/auth-session";
import { SessionStore } from "../src/auth/session-store";
import type { DeviceCredentialStore, DeviceRegistration } from "../src/devices/device-credential-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
import { productFixture } from "./support/catalog-fixtures";
import {
  apiError,
  BUSINESS_A,
  BUSINESS_B,
  deferred,
  type FakeTaliApi,
  json,
  registeredUserApi,
  settle,
  TOKEN,
} from "./support/fake-tali-api";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

beforeAll(() => {
  installSecureRandom();
});

/** Synthetic stand-in for a one-time device credential. */
const CREDENTIAL = `tali_dev_${"z".repeat(43)}`;
const DEVICE_ID = "0191a1b2-0000-7000-8000-0000000000d1";
const PRODUCTS = `GET /v1/businesses/${BUSINESS_A.id}/products`;
const PRODUCT = productFixture();
const PRODUCT_ROUTE = `GET /v1/businesses/${BUSINESS_A.id}/products/${PRODUCT.id}`;

function memoryDeviceStore(initial: Record<string, DeviceRegistration> = {}): DeviceCredentialStore & {
  readonly items: Map<string, DeviceRegistration>;
} {
  const items = new Map(Object.entries(initial));
  return {
    items,
    read: (businessId) => Promise.resolve(items.get(businessId)),
    save: (businessId, registration) => {
      items.set(businessId, registration);
      return Promise.resolve();
    },
    clear: (businessId) => {
      items.delete(businessId);
      return Promise.resolve();
    },
  };
}

async function selected(
  api: FakeTaliApi,
  deviceStore: DeviceCredentialStore = memoryDeviceStore(),
  businessId = BUSINESS_A.id,
): Promise<SessionStore> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const store = new SessionStore({
    api: client,
    newIdempotencyKey: newUuidV7,
    deviceRegistrationSupported: true,
    deviceStore,
  });
  await store.signInLocal("local-user-ada");
  store.selectBusiness(businessId);
  await settle();
  return store;
}

const listProducts = (store: SessionStore, scope: "business" | "resource" = "business") =>
  store.businessRequest(BUSINESS_A.id, { notFoundScope: scope }, (api, { token, device }) =>
    api.listProducts(token, BUSINESS_A.id, {}, device),
  );

const ARCHIVE = `POST /v1/businesses/${BUSINESS_A.id}/products/${PRODUCT.id}/archive`;

/** An auth session whose access tokens can be held pending until the test releases them. */
class GatedAuthSession implements AuthSession {
  hold = false;
  readonly #waiting: ((result: AccessTokenResult) => void)[] = [];

  get pending(): number {
    return this.#waiting.length;
  }

  accessToken(): Promise<AccessTokenResult> {
    if (!this.hold) return Promise.resolve({ ok: true, token: TOKEN as AccessToken });
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /** Resolves every held request with a valid token, even after the session ended (the worst case). */
  release(): void {
    for (const resolve of this.#waiting.splice(0)) resolve({ ok: true, token: TOKEN as AccessToken });
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

async function gatedSelection(
  api: FakeTaliApi,
  deviceStore: DeviceCredentialStore,
): Promise<{ store: SessionStore; auth: GatedAuthSession }> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const store = new SessionStore({
    api: client,
    newIdempotencyKey: newUuidV7,
    deviceRegistrationSupported: true,
    deviceStore,
  });
  const auth = new GatedAuthSession();
  await store.beginSession(auth);
  store.selectBusiness(BUSINESS_A.id);
  await settle();
  return { store, auth };
}

/** A read and a mutation for business A, recording every `send` call. */
function readAndArchive(store: SessionStore, sent: string[]) {
  return [
    store.businessRequest(BUSINESS_A.id, { notFoundScope: "business" }, (client, { token, device }) => {
      sent.push("read");
      return client.listProducts(token, BUSINESS_A.id, {}, device);
    }),
    store.businessRequest(BUSINESS_A.id, { notFoundScope: "resource" }, (client, { token, device }) => {
      sent.push("archive");
      return client.archiveProduct(token, BUSINESS_A.id, PRODUCT.id, { expectedVersion: 1 }, device);
    }),
  ] as const;
}

describe("mobile SessionStore.businessRequest", () => {
  it("attaches the bearer token and this business's device headers only", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B])
      .on(PRODUCTS, json(200, { items: [], nextCursor: null }))
      .on(`GET /v1/businesses/${BUSINESS_B.id}/products`, json(200, { items: [], nextCursor: null }));
    const devices = memoryDeviceStore({ [BUSINESS_A.id]: { deviceId: DEVICE_ID, credential: CREDENTIAL } });
    const store = await selected(api, devices);
    expect(await listProducts(store)).toMatchObject({ ok: true });
    const sent = api.to(PRODUCTS)[0];
    expect(sent?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(sent?.headers.get(DEVICE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);

    store.changeBusiness();
    store.selectBusiness(BUSINESS_B.id);
    await settle();
    await store.businessRequest(BUSINESS_B.id, { notFoundScope: "business" }, (client, { token, device }) =>
      client.listProducts(token, BUSINESS_B.id, {}, device),
    );
    expect(api.to(`GET /v1/businesses/${BUSINESS_B.id}/products`)[0]?.headers.get(DEVICE_ID_HEADER)).toBeNull();
    expect(JSON.stringify(store.getSnapshot())).not.toContain(CREDENTIAL);
  });

  it("forgets a refused device on DEVICE_NOT_TRUSTED, returns the failure and retries without it", async () => {
    const api = registeredUserApi().on(
      PRODUCTS,
      apiError(403, "DEVICE_NOT_TRUSTED"),
      json(200, { items: [], nextCursor: null }),
    );
    const devices = memoryDeviceStore({ [BUSINESS_A.id]: { deviceId: DEVICE_ID, credential: CREDENTIAL } });
    const store = await selected(api, devices);
    expect(await listProducts(store)).toMatchObject({ ok: false, failure: { code: "DEVICE_NOT_TRUSTED" } });
    expect(store.getSnapshot()).toMatchObject({ device: "untrusted", phase: "businessSelected" });
    expect(devices.items.size).toBe(0);
    expect(await listProducts(store)).toMatchObject({ ok: true });
    expect(api.to(PRODUCTS).at(-1)?.headers.get(DEVICE_ID_HEADER)).toBeNull();
  });

  it("is ignored when the business is not selected, and for late responses after a switch or sign-out", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]);
    const other = await selected(api, memoryDeviceStore(), BUSINESS_B.id);
    expect(await listProducts(other)).toEqual({ status: "ignored" });
    expect(api.to(PRODUCTS)).toHaveLength(0);

    const leaves = [
      (s: SessionStore) => {
        s.changeBusiness();
      },
      (s: SessionStore) => {
        s.signOut();
      },
    ];
    for (const leave of leaves) {
      const late = deferred();
      const store = await selected(registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCTS, late.reply));
      const pending = listProducts(store);
      await settle();
      leave(store);
      late.resolve(200, { items: [], nextCursor: null });
      expect(await pending).toEqual({ status: "ignored" });
    }
  });

  it("resets the session on 401 and reports ignored", async () => {
    const store = await selected(registeredUserApi().on(PRODUCTS, apiError(401, "UNAUTHENTICATED")));
    expect(await listProducts(store)).toEqual({ status: "ignored" });
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", notice: "sessionEnded" });
  });

  it("answers businessUnavailable for a business-scope NOT_FOUND without changing the selection", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCTS, apiError(404, "NOT_FOUND"));
    const store = await selected(api);
    const before = api.to("GET /v1/me/businesses").length;
    expect(await listProducts(store, "business")).toMatchObject({ status: "businessUnavailable" });
    await settle();
    expect(store.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_A.id });
    expect(api.to("GET /v1/me/businesses")).toHaveLength(before);
  });

  it("returns a resource-scope NOT_FOUND as an ordinary failure", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCT_ROUTE, apiError(404, "NOT_FOUND"));
    const store = await selected(api);
    const result = await store.businessRequest(
      BUSINESS_A.id,
      { notFoundScope: "resource" },
      (client, { token, device }) => client.getProduct(token, BUSINESS_A.id, PRODUCT.id, device),
    );
    expect(result).toMatchObject({ ok: false, failure: { code: "NOT_FOUND" } });
    await settle();
    expect(store.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_A.id });
  });
});

describe("mobile SessionStore.businessRequest while the access token is pending", () => {
  const leaves: readonly (readonly [string, (store: SessionStore) => void])[] = [
    [
      "another business is selected",
      (store) => {
        store.changeBusiness();
        store.selectBusiness(BUSINESS_B.id);
      },
    ],
    [
      "the user signs out",
      (store) => {
        store.signOut();
      },
    ],
  ];

  for (const [when, leave] of leaves) {
    it(`never calls send when ${when} before the token resolves`, async () => {
      const api = registeredUserApi([BUSINESS_A, BUSINESS_B])
        .on(PRODUCTS, json(200, { items: [], nextCursor: null }))
        .on(ARCHIVE, json(200, PRODUCT));
      const devices = memoryDeviceStore({ [BUSINESS_A.id]: { deviceId: DEVICE_ID, credential: CREDENTIAL } });
      const { store, auth } = await gatedSelection(api, devices);
      const sent: string[] = [];
      auth.hold = true;
      const [read, archive] = readAndArchive(store, sent);
      await settle();
      expect(auth.pending).toBe(2);

      leave(store);
      auth.release();

      expect(await read).toEqual({ status: "ignored" });
      expect(await archive).toEqual({ status: "ignored" });
      expect(sent).toEqual([]);
      expect(api.to(PRODUCTS)).toHaveLength(0);
      expect(api.to(ARCHIVE)).toHaveLength(0);
    });
  }

  it("never calls send after A -> B -> A: re-selecting A does not revive a request from the first selection", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B])
      .on(PRODUCTS, json(200, { items: [], nextCursor: null }))
      .on(ARCHIVE, json(200, PRODUCT));
    const devices = memoryDeviceStore({ [BUSINESS_A.id]: { deviceId: DEVICE_ID, credential: CREDENTIAL } });
    const { store, auth } = await gatedSelection(api, devices);
    const sent: string[] = [];
    auth.hold = true;
    const [read, archive] = readAndArchive(store, sent);
    await settle();
    expect(auth.pending).toBe(2);

    store.changeBusiness();
    store.selectBusiness(BUSINESS_B.id);
    store.changeBusiness();
    store.selectBusiness(BUSINESS_A.id);
    await settle();
    expect(store.getSnapshot().selectedBusinessId).toBe(BUSINESS_A.id);
    auth.release();

    expect(await read).toEqual({ status: "ignored" });
    expect(await archive).toEqual({ status: "ignored" });
    expect(sent).toEqual([]);
    expect(api.to(PRODUCTS)).toHaveLength(0);
    expect(api.to(ARCHIVE)).toHaveLength(0);

    auth.hold = false;
    const [freshRead, freshArchive] = readAndArchive(store, sent);
    expect(await freshRead).toMatchObject({ ok: true });
    expect(await freshArchive).toMatchObject({ ok: true });
    expect(sent).toEqual(["read", "archive"]);
    expect(api.to(ARCHIVE)).toHaveLength(1);
  });

  it("sends with this business's current device registration once the token resolves", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B])
      .on(PRODUCTS, json(200, { items: [], nextCursor: null }))
      .on(ARCHIVE, json(200, PRODUCT));
    const devices = memoryDeviceStore({ [BUSINESS_A.id]: { deviceId: DEVICE_ID, credential: CREDENTIAL } });
    const { store, auth } = await gatedSelection(api, devices);
    const sent: string[] = [];
    auth.hold = true;
    const [read, archive] = readAndArchive(store, sent);
    await settle();
    expect(sent).toEqual([]);

    auth.release();

    expect(await read).toMatchObject({ ok: true });
    expect(await archive).toMatchObject({ ok: true });
    expect(sent).toEqual(["read", "archive"]);
    const request = api.to(ARCHIVE)[0];
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(request?.headers.get(DEVICE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
  });
});
