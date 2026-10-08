import { describe, expect, it } from "vitest";
import { type AccessToken, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import type { AccessTokenResult, AuthSession } from "../src/lib/auth/auth-session";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
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

const PRODUCTS = `GET /v1/businesses/${BUSINESS_A.id}/products`;
const PRODUCT = productFixture();
const PRODUCT_ROUTE = `GET /v1/businesses/${BUSINESS_A.id}/products/${PRODUCT.id}`;

async function selected(api: FakeTaliApi, businessId = BUSINESS_A.id): Promise<SessionStore> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const store = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
  await store.signInLocal("local-user-ada");
  store.selectBusiness(businessId);
  return store;
}

const listProducts = (store: SessionStore, scope: "business" | "resource" = "business") =>
  store.businessRequest(BUSINESS_A.id, { notFoundScope: scope }, (api, { token }) =>
    api.listProducts(token, BUSINESS_A.id),
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

async function gatedSelection(api: FakeTaliApi): Promise<{ store: SessionStore; auth: GatedAuthSession }> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const store = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
  const auth = new GatedAuthSession();
  await store.beginSession(auth);
  store.selectBusiness(BUSINESS_A.id);
  return { store, auth };
}

/** A read and a mutation for business A, recording every `send` call. */
function readAndArchive(store: SessionStore, sent: string[]) {
  return [
    store.businessRequest(BUSINESS_A.id, { notFoundScope: "business" }, (client, { token }) => {
      sent.push("read");
      return client.listProducts(token, BUSINESS_A.id);
    }),
    store.businessRequest(BUSINESS_A.id, { notFoundScope: "resource" }, (client, { token }) => {
      sent.push("archive");
      return client.archiveProduct(token, BUSINESS_A.id, PRODUCT.id, { expectedVersion: 1 });
    }),
  ] as const;
}

describe("SessionStore.businessRequest while the access token is pending", () => {
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
      const { store, auth } = await gatedSelection(api);
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
    const { store, auth } = await gatedSelection(api);
    const sent: string[] = [];
    auth.hold = true;
    const [read, archive] = readAndArchive(store, sent);
    await settle();
    expect(auth.pending).toBe(2);

    store.changeBusiness();
    store.selectBusiness(BUSINESS_B.id);
    store.changeBusiness();
    store.selectBusiness(BUSINESS_A.id);
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

  it("sends once the token resolves while the same business stays selected", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B])
      .on(PRODUCTS, json(200, { items: [], nextCursor: null }))
      .on(ARCHIVE, json(200, PRODUCT));
    const { store, auth } = await gatedSelection(api);
    const sent: string[] = [];
    auth.hold = true;
    const [read, archive] = readAndArchive(store, sent);
    await settle();
    expect(sent).toEqual([]);

    auth.release();

    expect(await read).toMatchObject({ ok: true });
    expect(await archive).toMatchObject({ ok: true });
    expect(sent).toEqual(["read", "archive"]);
    expect(api.to(ARCHIVE)[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });
});

describe("SessionStore.businessRequest", () => {
  it("sends one request with the current bearer token and returns the API result", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCTS, json(200, { items: [], nextCursor: null }));
    const store = await selected(api);
    expect(await listProducts(store)).toMatchObject({ ok: true, value: { items: [], nextCursor: null } });
    expect(api.to(PRODUCTS)[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("is ignored without sending when the business is not the selected one", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]);
    const store = await selected(api, BUSINESS_B.id);
    expect(await listProducts(store)).toEqual({ status: "ignored" });
    expect(api.to(PRODUCTS)).toHaveLength(0);
  });

  it("ignores a late response after a business switch or sign-out", async () => {
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
      const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCTS, late.reply);
      const store = await selected(api);
      const pending = listProducts(store);
      await settle();
      leave(store);
      late.resolve(200, { items: [], nextCursor: null });
      expect(await pending).toEqual({ status: "ignored" });
    }
  });

  it("ignores a response that arrives after another business was selected", async () => {
    const late = deferred();
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCTS, late.reply);
    const store = await selected(api);
    const pending = listProducts(store);
    await settle();
    store.changeBusiness();
    store.selectBusiness(BUSINESS_B.id);
    late.resolve(200, { items: [], nextCursor: null });
    expect(await pending).toEqual({ status: "ignored" });
    expect(store.getSnapshot().selectedBusinessId).toBe(BUSINESS_B.id);
  });

  it("resets the session on 401 and reports ignored", async () => {
    const api = registeredUserApi().on(PRODUCTS, apiError(401, "UNAUTHENTICATED"));
    const store = await selected(api);
    expect(await listProducts(store)).toEqual({ status: "ignored" });
    expect(store.getSnapshot()).toMatchObject({ phase: "signedOut", notice: "sessionEnded" });
  });

  it("answers businessUnavailable for a business-scope NOT_FOUND and never changes the selection", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCTS, apiError(404, "NOT_FOUND"));
    const store = await selected(api);
    const before = api.to("GET /v1/me/businesses").length;
    expect(await listProducts(store, "business")).toMatchObject({
      status: "businessUnavailable",
      failure: { code: "NOT_FOUND" },
    });
    await settle();
    expect(store.getSnapshot()).toMatchObject({
      phase: "businessSelected",
      selectedBusinessId: BUSINESS_A.id,
      notice: undefined,
    });
    expect(api.to("GET /v1/me/businesses")).toHaveLength(before);
  });

  it("returns a resource-scope NOT_FOUND as an ordinary failure and leaves the business selected", async () => {
    const api = registeredUserApi([BUSINESS_A, BUSINESS_B]).on(PRODUCT_ROUTE, apiError(404, "NOT_FOUND"));
    const store = await selected(api);
    const before = api.to("GET /v1/me/businesses").length;
    const result = await store.businessRequest(BUSINESS_A.id, { notFoundScope: "resource" }, (client, { token }) =>
      client.getProduct(token, BUSINESS_A.id, PRODUCT.id),
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "api-error", code: "NOT_FOUND" } });
    await settle();
    expect(store.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_A.id });
    expect(api.to("GET /v1/me/businesses")).toHaveLength(before);
  });

  it("returns PERMISSION_DENIED and VERSION_CONFLICT unchanged without touching the session", async () => {
    for (const [status, code] of [
      [403, "PERMISSION_DENIED"],
      [409, "VERSION_CONFLICT"],
    ] as const) {
      const api = registeredUserApi().on(PRODUCTS, apiError(status, code));
      const store = await selected(api);
      expect(await listProducts(store)).toMatchObject({ ok: false, failure: { code } });
      expect(store.getSnapshot().phase).toBe("businessSelected");
    }
  });

  it("never exposes the token in the session snapshot", async () => {
    const api = registeredUserApi().on(PRODUCTS, json(200, { items: [], nextCursor: null }));
    const store = await selected(api);
    await listProducts(store);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(TOKEN);
  });
});
