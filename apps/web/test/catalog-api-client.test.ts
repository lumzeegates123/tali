import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient, type AccessToken } from "../src/lib/api-client/tali-api-client";
import {
  BUSINESS_ID,
  categoryFixture,
  NGN,
  packFixture,
  priceEntryFixture,
  productFixture,
  UNITS,
} from "./support/catalog-fixtures";
import { jsonFetch } from "./support/fake-fetch";

const TOKEN = "catalog-test-access" as AccessToken;
const KEY = "0190a000-0000-7000-8000-0000000000aa";
const BASE = `http://api.test/v1/businesses/${BUSINESS_ID}`;

function client(fetchDouble: typeof fetch): TaliApiClient {
  return new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: fetchDouble });
}

function sent(double: ReturnType<typeof jsonFetch>) {
  const request = double.requests[0];
  const headers = new Headers(request?.init?.headers);
  const body = request?.init?.body;
  return {
    url: request?.url,
    method: request?.init?.method,
    authorization: headers.get("authorization"),
    idempotencyKey: headers.get(IDEMPOTENCY_KEY_HEADER),
    body: typeof body === "string" ? (JSON.parse(body) as unknown) : undefined,
  };
}

describe("TaliApiClient catalog transport", () => {
  it("sends PATCH and PUT with a JSON body and the bearer token", async () => {
    const product = productFixture({ version: 2 });
    const patch = jsonFetch(200, product);
    await client(patch.fetch).updateProduct(TOKEN, BUSINESS_ID, product.id, { expectedVersion: 1, sku: null });
    expect(sent(patch)).toEqual({
      url: `${BASE}/products/${product.id}`,
      method: "PATCH",
      authorization: `Bearer ${TOKEN}`,
      idempotencyKey: null,
      body: { expectedVersion: 1, sku: null },
    });

    const put = jsonFetch(200, product);
    const price = { amountMinor: "35000", currency: "NGN" };
    await client(put.fetch).setSellingPrice(TOKEN, BUSINESS_ID, product.id, { expectedVersion: 2, price });
    expect(sent(put)).toMatchObject({
      url: `${BASE}/products/${product.id}/price`,
      method: "PUT",
      body: { expectedVersion: 2, price },
    });

    const category = categoryFixture({ version: 2 });
    const patchCategory = jsonFetch(200, category);
    await client(patchCategory.fetch).updateCategory(TOKEN, BUSINESS_ID, category.id, {
      expectedVersion: 1,
      name: "Drinks",
    });
    expect(sent(patchCategory)).toMatchObject({ method: "PATCH", url: `${BASE}/categories/${category.id}` });
  });

  it("sends the idempotency key on keyed creates only", async () => {
    const product = jsonFetch(201, productFixture());
    await client(product.fetch).createProduct(
      TOKEN,
      BUSINESS_ID,
      { name: "Malt", stockUnit: "PIECE", trackInventory: true },
      KEY,
    );
    expect(sent(product)).toMatchObject({ method: "POST", url: `${BASE}/products`, idempotencyKey: KEY });

    const category = jsonFetch(201, categoryFixture());
    await client(category.fetch).createCategory(TOKEN, BUSINESS_ID, { name: "Drinks" }, KEY);
    expect(sent(category)).toMatchObject({ url: `${BASE}/categories`, idempotencyKey: KEY, body: { name: "Drinks" } });

    const pack = jsonFetch(201, packFixture());
    await client(pack.fetch).addPack(TOKEN, BUSINESS_ID, "p-1", { name: "Crate", factorMinor: "24" }, KEY);
    expect(sent(pack)).toMatchObject({ url: `${BASE}/products/p-1/packs`, idempotencyKey: KEY });

    const archive = jsonFetch(200, productFixture({ status: "ARCHIVED" }));
    await client(archive.fetch).archiveProduct(TOKEN, BUSINESS_ID, "p-1", { expectedVersion: 1 });
    expect(sent(archive)).toMatchObject({ url: `${BASE}/products/p-1/archive`, idempotencyKey: null });
  });

  it("encodes list queries and omits absent parameters", async () => {
    const list = jsonFetch(200, { items: [], nextCursor: null });
    await client(list.fetch).listProducts(TOKEN, BUSINESS_ID, {
      q: "malt & co/33",
      status: "ARCHIVED",
      limit: 25,
      after: "c+1",
    });
    const url = new URL(sent(list).url ?? "");
    expect(url.pathname).toBe(`/v1/businesses/${BUSINESS_ID}/products`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "malt & co/33",
      status: "ARCHIVED",
      limit: "25",
      after: "c+1",
    });

    const bare = jsonFetch(200, { items: [], nextCursor: null });
    await client(bare.fetch).listProducts(TOKEN, BUSINESS_ID);
    expect(sent(bare).url).toBe(`${BASE}/products`);

    const ids = jsonFetch(200, productFixture());
    await client(ids.fetch).getProduct(TOKEN, "a/b", "../x?y");
    expect(sent(ids).url).toBe("http://api.test/v1/businesses/a%2Fb/products/..%2Fx%3Fy");
  });

  it("parses every successful catalog response with the strict shared contracts", async () => {
    const product = productFixture();
    const cases: [string, unknown, (api: TaliApiClient) => Promise<unknown>][] = [
      ["currency", NGN, (api) => api.getBusinessCurrency(TOKEN, BUSINESS_ID)],
      ["units", UNITS, (api) => api.listUnits(TOKEN, BUSINESS_ID)],
      ["products", { items: [product], nextCursor: null }, (api) => api.listProducts(TOKEN, BUSINESS_ID)],
      ["product", product, (api) => api.getProduct(TOKEN, BUSINESS_ID, product.id)],
      [
        "prices",
        { items: [priceEntryFixture()], nextCursor: "n" },
        (api) => api.listPriceHistory(TOKEN, BUSINESS_ID, product.id),
      ],
      ["categories", { items: [categoryFixture()], nextCursor: null }, (api) => api.listCategories(TOKEN, BUSINESS_ID)],
      ["packs", { items: [packFixture()], nextCursor: null }, (api) => api.listPacks(TOKEN, BUSINESS_ID, product.id)],
      ["retire", packFixture({ status: "RETIRED" }), (api) => api.retirePack(TOKEN, BUSINESS_ID, "k-1")],
    ];
    for (const [name, body, call] of cases) {
      expect({ name, result: await call(client(jsonFetch(200, body).fetch)) }).toMatchObject({
        name,
        result: { ok: true, value: body },
      });
    }
  });

  it("rejects malformed successful responses instead of trusting them", async () => {
    const product = productFixture();
    const malformed: [string, number, unknown, (api: TaliApiClient) => Promise<unknown>][] = [
      [
        "extra product key",
        200,
        { ...product, businessId: BUSINESS_ID },
        (api) => api.getProduct(TOKEN, BUSINESS_ID, "p"),
      ],
      [
        "numeric money",
        200,
        { ...product, sellingPrice: { amountMinor: 35000, currency: "NGN" } },
        (api) => api.getProduct(TOKEN, BUSINESS_ID, "p"),
      ],
      [
        "numeric pack factor",
        201,
        { ...packFixture(), factorMinor: 24 },
        (api) => api.addPack(TOKEN, BUSINESS_ID, "p", { name: "Crate", factorMinor: "24" }, KEY),
      ],
      [
        "currency digits too large",
        200,
        { code: "NGN", minorUnitDigits: 5 },
        (api) => api.getBusinessCurrency(TOKEN, BUSINESS_ID),
      ],
      ["currency extra key", 200, { ...NGN, symbol: "N" }, (api) => api.getBusinessCurrency(TOKEN, BUSINESS_ID)],
      [
        "unit scale",
        200,
        { items: [{ code: "KG", kind: "MASS", scale: 9 }] },
        (api) => api.listUnits(TOKEN, BUSINESS_ID),
      ],
      ["products without cursor", 200, { items: [] }, (api) => api.listProducts(TOKEN, BUSINESS_ID)],
      [
        "create answered 200",
        200,
        product,
        (api) => api.createProduct(TOKEN, BUSINESS_ID, { name: "M", stockUnit: "PIECE", trackInventory: true }, KEY),
      ],
    ];
    for (const [name, status, body, call] of malformed) {
      expect({ name, result: await call(client(jsonFetch(status, body).fetch)) }).toMatchObject({
        name,
        result: { ok: false, failure: { kind: "invalid-response" } },
      });
    }
  });

  it("maps a VERSION_CONFLICT envelope to an api-error", async () => {
    const envelope = { error: { code: "VERSION_CONFLICT", message: "Stale version" } };
    const result = await client(jsonFetch(409, envelope).fetch).updateProduct(TOKEN, BUSINESS_ID, "p", {
      expectedVersion: 1,
      name: "X",
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: "api-error", status: 409, code: "VERSION_CONFLICT" } });
  });
});
