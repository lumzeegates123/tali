import { describe, expect, it } from "vitest";
import { TaliApiClient } from "../src/lib/api-client/tali-api-client";
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
