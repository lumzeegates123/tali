import { isUuidV7 } from "@tali/domain/kernel";
import { describe, expect, it } from "vitest";
import { CATEGORY_OPTION_MAX_PAGES, CatalogStore } from "../src/catalog/catalog-store";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { categoryFixture, NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import {
  apiError,
  BUSINESS_A,
  BUSINESS_B,
  deferred,
  type FakeTaliApi,
  json,
  networkError,
  registeredUserApi,
  settle,
  TOKEN,
} from "./support/fake-tali-api";

const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const PRODUCTS = `GET ${BASE}/products`;
const CATEGORIES = `GET ${BASE}/categories`;
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });

function catalogApi(): FakeTaliApi {
  return registeredUserApi([BUSINESS_A, BUSINESS_B])
    .on(`GET ${BASE}/currency`, json(200, NGN))
    .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
    .on(PRODUCTS, page([]))
    .on(CATEGORIES, page([]));
}

async function storeFor(api: FakeTaliApi): Promise<{ session: SessionStore; catalog: CatalogStore }> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const session = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
  await session.signInLocal("local-user-ada");
  session.selectBusiness(BUSINESS_A.id);
  const catalog = new CatalogStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
  return { session, catalog };
}

describe("CatalogStore: reference data and the product list", () => {
  it("loads the currency, units and the first ACTIVE page without q", async () => {
    const product = productFixture();
    const api = catalogApi().on(PRODUCTS, page([product], "c1"));
    const { catalog } = await storeFor(api);
    catalog.start();
    await settle();
    const snapshot = catalog.getSnapshot();
    expect(snapshot.reference).toMatchObject({ phase: "ready", currency: { code: "NGN", minorUnitDigits: 2 } });
    expect(snapshot.reference.units).toEqual(UNITS.items);
    expect(snapshot.products).toMatchObject({ phase: "ready", items: [product], nextCursor: "c1", status: "ACTIVE" });
    expect(api.to(PRODUCTS)[0]?.query).toBe("?status=ACTIVE");
  });

  it("sends q only when the trimmed search is not blank and resets the cursor on a new search", async () => {
    const api = catalogApi().on(PRODUCTS, page([productFixture()], "c1"), page([productFixture()], "c2"), page([]));
    const { catalog } = await storeFor(api);
    await catalog.searchProducts("  Malt 33 ", "ACTIVE");
    await catalog.searchProducts("   ", "ARCHIVED");
    expect(api.to(PRODUCTS).map((request) => request.query)).toEqual(["?status=ACTIVE&q=Malt+33", "?status=ARCHIVED"]);
    expect(catalog.getSnapshot().products).toMatchObject({ query: "", status: "ARCHIVED", nextCursor: "c2" });
  });

  it("appends Show more pages for the same query, de-duplicates by ID and keeps items when a page fails", async () => {
    const first = productFixture({ name: "A" });
    const second = productFixture({ name: "B" });
    const api = catalogApi().on(PRODUCTS, page([first], "c1"), networkError, page([first, second], null));
    const { catalog } = await storeFor(api);
    await catalog.searchProducts("milk", "ACTIVE");
    await catalog.loadMoreProducts();
    expect(catalog.getSnapshot().products).toMatchObject({
      items: [first],
      nextCursor: "c1",
      moreFailure: { kind: "unavailable" },
    });
    await catalog.loadMoreProducts();
    expect(api.to(PRODUCTS).map((request) => request.query)).toEqual([
      "?status=ACTIVE&q=milk",
      "?after=c1&status=ACTIVE&q=milk",
      "?after=c1&status=ACTIVE&q=milk",
    ]);
    expect(catalog.getSnapshot().products).toMatchObject({ items: [first, second], nextCursor: null });
    await catalog.loadMoreProducts();
    expect(api.to(PRODUCTS)).toHaveLength(3);
  });

  it("never lets an older search overwrite a newer one", async () => {
    const slow = deferred();
    const fresh = productFixture({ name: "Fresh" });
    const api = catalogApi().on(PRODUCTS, slow.reply, page([fresh]));
    const { catalog } = await storeFor(api);
    const older = catalog.searchProducts("old", "ACTIVE");
    await settle();
    await catalog.searchProducts("new", "ACTIVE");
    slow.resolve(200, { items: [productFixture({ name: "Stale" })], nextCursor: "stale" });
    await older;
    expect(catalog.getSnapshot().products).toMatchObject({ query: "new", items: [fresh], nextCursor: null });
  });

  it("drops a Show more page that arrives after a new search", async () => {
    const slowMore = deferred();
    const api = catalogApi().on(PRODUCTS, page([productFixture()], "c1"), slowMore.reply, page([]));
    const { catalog } = await storeFor(api);
    await catalog.searchProducts("", "ACTIVE");
    const more = catalog.loadMoreProducts();
    await settle();
    await catalog.searchProducts("", "ARCHIVED");
    slowMore.resolve(200, { items: [productFixture()], nextCursor: "late" });
    await more;
    expect(catalog.getSnapshot().products).toMatchObject({ status: "ARCHIVED", items: [], nextCursor: null });
  });

  it("marks the business unavailable on a list NOT_FOUND without changing the session selection", async () => {
    const api = catalogApi().on(PRODUCTS, apiError(404, "NOT_FOUND"));
    const { session, catalog } = await storeFor(api);
    await catalog.searchProducts("", "ACTIVE");
    await settle();
    expect(catalog.getSnapshot().businessUnavailable).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ phase: "businessSelected", selectedBusinessId: BUSINESS_A.id });
  });

  it("treats a product NOT_FOUND as a resource failure only", async () => {
    const product = productFixture();
    const api = catalogApi().on(`GET ${BASE}/products/${product.id}`, apiError(404, "NOT_FOUND"));
    const { session, catalog } = await storeFor(api);
    expect(await catalog.getProduct(product.id)).toMatchObject({ status: "failed", failure: { code: "NOT_FOUND" } });
    expect(catalog.getSnapshot().businessUnavailable).toBe(false);
    expect(session.getSnapshot().selectedBusinessId).toBe(BUSINESS_A.id);
  });

  it("ignores every result after dispose", async () => {
    const slow = deferred();
    const api = catalogApi().on(PRODUCTS, slow.reply);
    const { catalog } = await storeFor(api);
    const pending = catalog.searchProducts("", "ACTIVE");
    await settle();
    const before = catalog.getSnapshot();
    catalog.dispose();
    slow.resolve(200, { items: [productFixture()], nextCursor: null });
    await pending;
    expect(catalog.getSnapshot()).toBe(before);
    expect(await catalog.getProduct("p")).toEqual({ status: "ignored" });
  });
});

describe("CatalogStore: keyed creates", () => {
  const COMMAND = { name: "Malt 33cl", stockUnit: "PIECE", trackInventory: true } as const;

  it("reuses one UUIDv7 key for an unchanged retry after an unknown outcome and refreshes the list on success", async () => {
    const created = productFixture({ name: "Malt 33cl" });
    const api = catalogApi().on(`POST ${BASE}/products`, networkError, json(201, created));
    const { catalog } = await storeFor(api);
    expect(await catalog.createProduct(COMMAND)).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
    expect(await catalog.createProduct({ ...COMMAND })).toEqual({ status: "ok", value: created });
    const keys = api.to(`POST ${BASE}/products`).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "");
    expect(isUuidV7(keys[0] ?? "")).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    await settle();
    expect(api.to(PRODUCTS).length).toBeGreaterThanOrEqual(1);
  });

  it("uses a new key for a changed command and after IDEMPOTENCY_KEY_REUSED", async () => {
    const api = catalogApi().on(
      `POST ${BASE}/products`,
      networkError,
      apiError(409, "IDEMPOTENCY_KEY_REUSED"),
      json(201, productFixture()),
    );
    const { catalog } = await storeFor(api);
    await catalog.createProduct(COMMAND);
    await catalog.createProduct({ ...COMMAND, sku: "MALT-33" });
    await catalog.createProduct({ ...COMMAND, sku: "MALT-33" });
    const keys = api.to(`POST ${BASE}/products`).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(new Set(keys).size).toBe(3);
  });

  it("ignores a second submit while one is in flight", async () => {
    const slow = deferred();
    const api = catalogApi().on(`POST ${BASE}/categories`, slow.reply);
    const { catalog } = await storeFor(api);
    const first = catalog.createCategory({ name: "Drinks" });
    await settle();
    expect(catalog.getSnapshot().submitting.createCategory).toBe(true);
    expect(await catalog.createCategory({ name: "Drinks" })).toEqual({ status: "ignored" });
    slow.resolve(201, categoryFixture({ name: "Drinks" }));
    expect(await first).toMatchObject({ status: "ok" });
    expect(api.to(`POST ${BASE}/categories`)).toHaveLength(1);
    expect(catalog.getSnapshot().submitting.createCategory).toBe(false);
  });

  it("keys AddPack per product, name and factor", async () => {
    const api = catalogApi()
      .on(`POST ${BASE}/products/p-1/packs`, networkError, networkError)
      .on(`POST ${BASE}/products/p-2/packs`, networkError);
    const { catalog } = await storeFor(api);
    await catalog.addPack("p-1", { name: "Crate", factorMinor: "24" });
    await catalog.addPack("p-1", { name: "Crate", factorMinor: "24" });
    await catalog.addPack("p-2", { name: "Crate", factorMinor: "24" });
    const key = (route: string, index: number) => api.to(route)[index]?.headers.get(IDEMPOTENCY_KEY_HEADER);
    expect(key(`POST ${BASE}/products/p-1/packs`, 1)).toBe(key(`POST ${BASE}/products/p-1/packs`, 0));
    expect(key(`POST ${BASE}/products/p-2/packs`, 0)).not.toBe(key(`POST ${BASE}/products/p-1/packs`, 0));
  });
});

describe("CatalogStore: mutations update the list", () => {
  it("replaces an edited row and removes a row whose status no longer matches the filter", async () => {
    const product = productFixture({ name: "Old" });
    const api = catalogApi()
      .on(PRODUCTS, page([product]))
      .on(`PATCH ${BASE}/products/${product.id}`, json(200, { ...product, name: "New", version: 2 }))
      .on(
        `POST ${BASE}/products/${product.id}/archive`,
        json(200, { ...product, name: "New", version: 3, status: "ARCHIVED" }),
      );
    const { catalog } = await storeFor(api);
    await catalog.searchProducts("", "ACTIVE");
    await catalog.updateProduct(product.id, { expectedVersion: 1, name: "New" });
    expect(catalog.getSnapshot().products.items).toMatchObject([{ id: product.id, name: "New", version: 2 }]);
    expect(api.to(`PATCH ${BASE}/products/${product.id}`)[0]?.body).toEqual({ expectedVersion: 1, name: "New" });
    await catalog.archiveProduct(product.id, { expectedVersion: 2 });
    expect(catalog.getSnapshot().products.items).toEqual([]);
  });

  it("returns VERSION_CONFLICT to the caller without retrying", async () => {
    const product = productFixture();
    const api = catalogApi().on(`PATCH ${BASE}/products/${product.id}`, apiError(409, "VERSION_CONFLICT"));
    const { catalog } = await storeFor(api);
    expect(await catalog.updateProduct(product.id, { expectedVersion: 1, name: "X" })).toMatchObject({
      status: "failed",
      failure: { code: "VERSION_CONFLICT" },
    });
    expect(api.to(`PATCH ${BASE}/products/${product.id}`)).toHaveLength(1);
  });
});

describe("CatalogStore: category options", () => {
  const optionQueries = (api: FakeTaliApi) => api.to(CATEGORIES).map((request) => request.query);

  it("follows cursors with limit 100 until nextCursor is null", async () => {
    const [a, b] = [categoryFixture({ name: "A" }), categoryFixture({ name: "B" })];
    const api = catalogApi().on(CATEGORIES, page([a], "c1"), page([b], null));
    const { catalog } = await storeFor(api);
    await catalog.loadCategoryOptions();
    expect(catalog.getSnapshot().categoryOptions).toEqual({
      phase: "ready",
      items: [a, b],
      truncated: false,
      failure: undefined,
    });
    expect(optionQueries(api)).toEqual(["?limit=100&status=ACTIVE", "?limit=100&after=c1&status=ACTIVE"]);
  });

  it("stops at the page cap with a truncated notice", async () => {
    let n = 0;
    const replies = Array.from({ length: CATEGORY_OPTION_MAX_PAGES + 2 }, () =>
      page([categoryFixture({ name: `C${String((n += 1))}` })], `cursor-${String(n)}`),
    );
    const api = catalogApi().on(CATEGORIES, ...replies);
    const { catalog } = await storeFor(api);
    await catalog.loadCategoryOptions();
    expect(api.to(CATEGORIES)).toHaveLength(CATEGORY_OPTION_MAX_PAGES);
    expect(catalog.getSnapshot().categoryOptions).toMatchObject({ phase: "ready", truncated: true });
    expect(catalog.getSnapshot().categoryOptions.items).toHaveLength(CATEGORY_OPTION_MAX_PAGES);
  });

  it("stops on a repeated cursor or an empty page that still has a cursor", async () => {
    const repeated = catalogApi().on(
      CATEGORIES,
      page([categoryFixture()], "same"),
      page([categoryFixture()], "same"),
      page([categoryFixture()], null),
    );
    const first = await storeFor(repeated);
    await first.catalog.loadCategoryOptions();
    expect(repeated.to(CATEGORIES)).toHaveLength(2);
    expect(first.catalog.getSnapshot().categoryOptions).toMatchObject({ truncated: true });
    expect(first.catalog.getSnapshot().categoryOptions.items).toHaveLength(2);

    const empty = catalogApi().on(CATEGORIES, page([], "more"), page([categoryFixture()], null));
    const second = await storeFor(empty);
    await second.catalog.loadCategoryOptions();
    expect(empty.to(CATEGORIES)).toHaveLength(1);
    expect(second.catalog.getSnapshot().categoryOptions).toMatchObject({ phase: "ready", items: [], truncated: true });
  });

  it("keeps loaded options when a later page fails, and fails only when nothing loaded", async () => {
    const a = categoryFixture();
    const api = catalogApi().on(CATEGORIES, page([a], "c1"), networkError);
    const { catalog } = await storeFor(api);
    await catalog.loadCategoryOptions();
    expect(catalog.getSnapshot().categoryOptions).toMatchObject({ phase: "ready", items: [a], truncated: true });

    const failing = catalogApi().on(CATEGORIES, networkError);
    const other = await storeFor(failing);
    await other.catalog.loadCategoryOptions();
    expect(other.catalog.getSnapshot().categoryOptions).toMatchObject({ phase: "failed", items: [] });
  });
});

describe("CatalogStore: credential boundary", () => {
  it("never puts the token or an idempotency key in a snapshot", async () => {
    const api = catalogApi()
      .on(PRODUCTS, page([productFixture()]))
      .on(`POST ${BASE}/categories`, networkError);
    const { catalog } = await storeFor(api);
    catalog.start();
    await catalog.createCategory({ name: "Drinks" });
    await settle();
    const text = JSON.stringify(catalog.getSnapshot());
    const key = api.to(`POST ${BASE}/categories`)[0]?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "missing";
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(key);
    expect(Object.keys(catalog)).toEqual(["subscribe", "getSnapshot"]);
  });
});
