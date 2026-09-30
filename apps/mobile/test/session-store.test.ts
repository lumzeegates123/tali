import type * as NodeCrypto from "node:crypto";
import { isUuidV7 } from "@tali/domain/kernel";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { SessionStore } from "../src/auth/session-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
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
  settle,
  TOKEN,
  USER,
} from "./support/fake-tali-api";

jest.mock("expo-crypto", () => ({
  // Stands in for the native module, as in ids.test.ts; the real SecureRandom path is exercised on the Hermes build.
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

beforeAll(() => {
  installSecureRandom();
});

const CREATE = { name: "Ada Provisions", currencyCode: "NGN", timeZone: "Africa/Lagos" };

function storeFor(api: FakeTaliApi): SessionStore {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  return new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
}

async function signedInWithNoBusinesses(): Promise<{ api: FakeTaliApi; store: SessionStore }> {
  const api = registeredUserApi([]);
  const store = storeFor(api);
  await store.signInLocal("local-user-ada");
  expect(store.getSnapshot().phase).toBe("choosingBusiness");
  return { api, store };
}

describe("session store: sign-in and registration", () => {
  it("signs in locally, then sends registration when GET /v1/me answers USER_NOT_REGISTERED", async () => {
    const api = registeredUserApi([]).on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");

    expect(store.getSnapshot()).toMatchObject({ phase: "needsRegistration", user: undefined });
    expect(api.to("POST /__local/sign-in")[0]?.body).toEqual({ subject: "local-user-ada" });
    expect(api.to("POST /__local/sign-in")[0]?.headers.has("authorization")).toBe(false);
    expect(api.to("GET /v1/me")[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(TOKEN);
  });

  it("registers the display name, then loads businesses (none: create flow)", async () => {
    const api = registeredUserApi([])
      .on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"))
      .on("POST /v1/me/registration", json(201, USER));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    await store.register("Ada Obi");

    expect(api.to("POST /v1/me/registration")[0]?.body).toEqual({ displayName: "Ada Obi" });
    expect(store.getSnapshot()).toMatchObject({ phase: "choosingBusiness", user: USER, businesses: [] });
    expect(api.to("GET /v1/me/businesses")[0]?.query).toBe("?limit=50");
  });

  it("keeps the registration form with the error when registration fails", async () => {
    const api = registeredUserApi([])
      .on("GET /v1/me", apiError(403, "USER_NOT_REGISTERED"))
      .on("POST /v1/me/registration", apiError(400, "VALIDATION_FAILED", "bad", [{ path: ["body", "displayName"] }]));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    await store.register("x");
    expect(store.getSnapshot()).toMatchObject({
      phase: "needsRegistration",
      error: { action: "register", failure: { code: "VALIDATION_FAILED", fields: ["displayName"] } },
    });
  });

  it("shows a blocked state for USER_DISABLED and drops the token", async () => {
    const api = registeredUserApi().on("GET /v1/me", apiError(403, "USER_DISABLED"));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    expect(store.getSnapshot()).toMatchObject({ phase: "error", error: { failure: { code: "USER_DISABLED" } } });
    const before = api.requests.length;
    await store.retry();
    await store.loadMembers(BUSINESS_A.id);
    expect(api.requests).toHaveLength(before);
  });

  it("returns to signed out with the error when local sign-in fails", async () => {
    const api = registeredUserApi().on("POST /__local/sign-in", apiError(429, "RATE_LIMITED"));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", error: { action: "signIn" } });
    expect(api.to("GET /v1/me")).toHaveLength(0);
  });

  it("retries GET /v1/me with the same session after a network failure", async () => {
    const api = registeredUserApi().on("GET /v1/me", networkError, json(200, USER));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    expect(store.getSnapshot()).toMatchObject({ phase: "error", error: { action: "checkUser" } });
    await store.retry();
    expect(store.getSnapshot().phase).toBe("choosingBusiness");
    expect(api.to("POST /__local/sign-in")).toHaveLength(1);
  });
});

describe("session store: businesses", () => {
  it("lists the user's businesses and selects only one of them", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]);
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    expect(store.getSnapshot().businesses.map((item) => item.business.id)).toEqual([BUSINESS_A.id, BUSINESS_B.id]);

    store.selectBusiness("0191a1b2-0000-7000-8000-0000000000ff");
    expect(store.getSnapshot()).toMatchObject({ phase: "choosingBusiness", selectedBusinessId: undefined });

    store.selectBusiness(BUSINESS_B.id);
    expect(store.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_B.id });
    store.changeBusiness();
    expect(store.getSnapshot()).toMatchObject({ phase: "choosingBusiness", selectedBusinessId: undefined });
  });

  it("follows the keyset cursor when more businesses are requested", async () => {
    const api = registeredUserApi().on(
      "GET /v1/me/businesses",
      json(200, { items: [{ business: BUSINESS_A, membership: MEMBERSHIP_A }], nextCursor: "cursor-1" }),
      json(200, { items: [{ business: BUSINESS_B, membership: MEMBERSHIP_A }], nextCursor: null }),
    );
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    await store.loadMoreBusinesses();
    expect(api.to("GET /v1/me/businesses")[1]?.query).toBe("?limit=50&after=cursor-1");
    expect(store.getSnapshot()).toMatchObject({ businessesNextCursor: null });
    expect(store.getSnapshot().businesses).toHaveLength(2);
  });

  it("loads the overview from GET business and its active default location", async () => {
    const api = registeredUserApi();
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    store.selectBusiness(BUSINESS_A.id);
    const overview = await store.loadBusinessOverview(BUSINESS_A.id);
    expect(overview).toMatchObject({ ok: true, value: { business: BUSINESS_A, defaultLocation: { isDefault: true } } });
  });

  it("clears the selection and reloads the list when the selected business answers NOT_FOUND", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(
      `GET /v1/businesses/${BUSINESS_A.id}`,
      apiError(404, "NOT_FOUND", "Not found"),
    );
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    store.selectBusiness(BUSINESS_A.id);
    const result = await store.loadBusinessOverview(BUSINESS_A.id);
    await settle();
    expect(result.ok).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      phase: "choosingBusiness",
      selectedBusinessId: undefined,
      notice: "businessUnavailable",
    });
    expect(api.to("GET /v1/me/businesses")).toHaveLength(2);
  });

  it("returns PERMISSION_DENIED for members without touching the session", async () => {
    const api = registeredUserApi().on(
      `GET /v1/businesses/${BUSINESS_A.id}/members`,
      apiError(403, "PERMISSION_DENIED", "Denied"),
    );
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    store.selectBusiness(BUSINESS_A.id);
    const members = await store.loadMembers(BUSINESS_A.id);
    expect(members).toMatchObject({ ok: false, failure: { code: "PERMISSION_DENIED" } });
    expect(store.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_A.id });
  });

  it("signs out when the API answers UNAUTHENTICATED, keeping nothing", async () => {
    const api = registeredUserApi().on(`GET /v1/businesses/${BUSINESS_A.id}`, apiError(401, "UNAUTHENTICATED"));
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    store.selectBusiness(BUSINESS_A.id);
    await store.loadBusinessOverview(BUSINESS_A.id);
    expect(store.getSnapshot()).toMatchObject({
      phase: "signedOut",
      user: undefined,
      businesses: [],
      selectedBusinessId: undefined,
      notice: "sessionEnded",
    });
    const before = api.requests.length;
    await store.loadMembers(BUSINESS_A.id);
    expect(api.requests).toHaveLength(before);
  });

  it("rejects a malformed response instead of treating it as a business list", async () => {
    const api = registeredUserApi().on(
      "GET /v1/me/businesses",
      json(200, { items: [{ business: { ...BUSINESS_A, internal: 1 }, membership: MEMBERSHIP_A }], nextCursor: null }),
    );
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    expect(store.getSnapshot()).toMatchObject({
      phase: "error",
      businesses: [],
      error: { action: "loadBusinesses", failure: { kind: "invalid-response" } },
    });
  });
});

describe("session store: CreateBusiness idempotency", () => {
  it("sends one RFC 9562 key and selects the created business from the server response", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api
      .on("POST /v1/businesses", json(201, createdBusinessBody()))
      .on(
        "GET /v1/me/businesses",
        json(200, { items: [{ business: BUSINESS_A, membership: MEMBERSHIP_A }], nextCursor: null }),
      );
    const outcome = await store.createBusiness({ ...CREATE, name: "  Ada Provisions  " });

    const [request] = api.to("POST /v1/businesses");
    expect(request?.body).toEqual(CREATE);
    expect(isUuidV7(request?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "")).toBe(true);
    expect(outcome).toEqual({ status: "created", businessId: BUSINESS_A.id });
    expect(store.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_A.id });
    expect(JSON.stringify(store.getSnapshot())).not.toContain(request?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "-");
  });

  it("reuses the key when the unchanged submission is retried after a network failure", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api.on("POST /v1/businesses", networkError, json(201, createdBusinessBody()));
    expect(await store.createBusiness(CREATE)).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
    expect(store.getSnapshot()).toMatchObject({ phase: "choosingBusiness", error: { action: "createBusiness" } });
    expect(await store.createBusiness(CREATE)).toMatchObject({ status: "created" });

    const keys = api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("keeps the key for transient server answers too", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api.on(
      "POST /v1/businesses",
      apiError(409, "IDEMPOTENCY_IN_PROGRESS"),
      apiError(503, "DEPENDENCY_UNAVAILABLE"),
      json(201, createdBusinessBody()),
    );
    await store.createBusiness(CREATE);
    await store.createBusiness(CREATE);
    await store.createBusiness(CREATE);
    const keys = new Set(api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER)));
    expect(keys.size).toBe(1);
  });

  it("uses a new key when the command is edited after a failure", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api.on("POST /v1/businesses", networkError, json(201, createdBusinessBody()));
    await store.createBusiness(CREATE);
    await store.createBusiness({ ...CREATE, name: "Ada Provisions Ltd" });
    const keys = api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("drops the key after IDEMPOTENCY_KEY_REUSED", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api.on("POST /v1/businesses", apiError(409, "IDEMPOTENCY_KEY_REUSED"), json(201, createdBusinessBody()));
    await store.createBusiness(CREATE);
    await store.createBusiness(CREATE);
    const keys = api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("ignores a second submission while the first is in flight", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    const pending = deferred();
    api.on("POST /v1/businesses", pending.reply);
    const first = store.createBusiness(CREATE);
    const second = await store.createBusiness(CREATE);
    expect(second).toEqual({ status: "ignored" });
    expect(store.getSnapshot().pending).toBe("createBusiness");
    pending.resolve(201, createdBusinessBody());
    expect(await first).toMatchObject({ status: "created" });
    expect(api.to("POST /v1/businesses")).toHaveLength(1);
  });

  it("rejects invalid input locally without sending or generating a key", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    expect(await store.createBusiness({ ...CREATE, timeZone: " " })).toMatchObject({
      status: "invalid",
      fields: ["timeZone"],
    });
    expect(api.to("POST /v1/businesses")).toHaveLength(0);
  });

  it("keeps the created business selected when the list refresh fails", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api.on("POST /v1/businesses", json(201, createdBusinessBody())).on("GET /v1/me/businesses", networkError);
    await store.createBusiness(CREATE);
    expect(store.getSnapshot()).toMatchObject({
      phase: "businessSelected",
      selectedBusinessId: BUSINESS_A.id,
      businesses: [{ business: BUSINESS_A, membership: MEMBERSHIP_A }],
    });
  });
});

describe("session store: sign-out and memory-only state", () => {
  it("sign-out clears the token, user, businesses and selection", async () => {
    const api = registeredUserApi();
    const store = storeFor(api);
    await store.signInLocal("local-user-ada");
    store.selectBusiness(BUSINESS_A.id);
    store.signOut();
    expect(store.getSnapshot()).toEqual({
      phase: "signedOut",
      user: undefined,
      businesses: [],
      businessesNextCursor: null,
      selectedBusinessId: undefined,
      pending: undefined,
      error: undefined,
      notice: "signedOut",
    });
    const before = api.requests.length;
    await store.loadBusinessOverview(BUSINESS_A.id);
    expect(api.requests).toHaveLength(before);
  });

  it("drops a response that arrives after sign-out", async () => {
    const pending = deferred();
    const api = registeredUserApi().on("GET /v1/me", pending.reply);
    const store = storeFor(api);
    const signIn = store.signInLocal("local-user-ada");
    await settle();
    store.signOut();
    pending.resolve(200, USER);
    await signIn;
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", user: undefined });
    expect(api.to("GET /v1/me/businesses")).toHaveLength(0);
  });

  it("a new store (a reload) starts signed out", async () => {
    const api = registeredUserApi();
    await storeFor(api).signInLocal("local-user-ada");
    expect(storeFor(api).getSnapshot().phase).toBe("signedOut");
  });

  it("forgets the idempotency key on sign-out", async () => {
    const { api, store } = await signedInWithNoBusinesses();
    api.on("POST /v1/businesses", networkError);
    await store.createBusiness(CREATE);
    store.signOut();
    await store.signInLocal("local-user-ada");
    await store.createBusiness(CREATE);
    const keys = api.to("POST /v1/businesses").map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[0]).not.toBe(keys[1]);
  });
});
