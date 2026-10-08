import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER } from "@tali/shared";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient, type AccessToken } from "../src/api/tali-api-client";
import { BUSINESS_ID, categoryFixture, NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import { jsonFetch } from "./support/fake-fetch";

const TOKEN = "catalog-test-access" as AccessToken;
const KEY = "0190a000-0000-7000-8000-0000000000aa";
const DEVICE = { deviceId: "0190a000-0000-7000-8000-0000000000dd", credential: "device-fixture-value" };
const BASE = `http://api.test/v1/businesses/${BUSINESS_ID}`;

function client(fetchDouble: typeof fetch): TaliApiClient {
  return new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: fetchDouble });
}

function sent(double: ReturnType<typeof jsonFetch>) {
  const request = double.requests[0];
  const headers = (request?.init?.headers ?? {}) as Record<string, string>;
  const body = request?.init?.body;
  return {
    url: request?.url,
    method: request?.init?.method,
    headers,
    body: typeof body === "string" ? (JSON.parse(body) as unknown) : undefined,
  };
}

describe("mobile TaliApiClient catalog transport", () => {
  it("sends PATCH and PUT with a JSON body, the bearer token and the device headers", async () => {
    const product = productFixture({ version: 2 });
    const patch = jsonFetch(200, product);
    await client(patch.fetch).updateProduct(TOKEN, BUSINESS_ID, product.id, { expectedVersion: 1, name: "X" }, DEVICE);
    expect(sent(patch)).toMatchObject({
      url: `${BASE}/products/${product.id}`,
      method: "PATCH",
      body: { expectedVersion: 1, name: "X" },
      headers: {
        authorization: `Bearer ${TOKEN}`,
        [DEVICE_ID_HEADER]: DEVICE.deviceId,
        [DEVICE_CREDENTIAL_HEADER]: DEVICE.credential,
      },
    });

    const put = jsonFetch(200, product);
    const price = { amountMinor: "35000", currency: "NGN" };
    await client(put.fetch).setSellingPrice(TOKEN, BUSINESS_ID, product.id, { expectedVersion: 2, price });
    expect(sent(put)).toMatchObject({ method: "PUT", url: `${BASE}/products/${product.id}/price`, body: { price } });
    expect(sent(put).headers).not.toHaveProperty(DEVICE_ID_HEADER);
  });

  it("keeps the idempotency key alongside device headers on create", async () => {
    const create = jsonFetch(201, productFixture());
    await client(create.fetch).createProduct(
      TOKEN,
      BUSINESS_ID,
      { name: "Malt", stockUnit: "PIECE", trackInventory: true },
      KEY,
      DEVICE,
    );
    expect(sent(create).headers).toMatchObject({
      [IDEMPOTENCY_KEY_HEADER]: KEY,
      [DEVICE_ID_HEADER]: DEVICE.deviceId,
    });
  });

  it("encodes the search term and omits absent parameters", async () => {
    const list = jsonFetch(200, { items: [], nextCursor: null });
    await client(list.fetch).listProducts(TOKEN, BUSINESS_ID, { q: "6151234567890", limit: 20 });
    expect(sent(list).url).toBe(`${BASE}/products?limit=20&q=6151234567890`);
    const bare = jsonFetch(200, { items: [], nextCursor: null });
    await client(bare.fetch).listCategories(TOKEN, BUSINESS_ID);
    expect(sent(bare).url).toBe(`${BASE}/categories`);
  });

  it("parses successful catalog responses with the strict shared contracts", async () => {
    const product = productFixture();
    expect(await client(jsonFetch(200, NGN).fetch).getBusinessCurrency(TOKEN, BUSINESS_ID)).toMatchObject({
      ok: true,
      value: NGN,
    });
    expect(await client(jsonFetch(200, UNITS).fetch).listUnits(TOKEN, BUSINESS_ID)).toMatchObject({ ok: true });
    expect(
      await client(jsonFetch(200, { items: [product], nextCursor: null }).fetch).listProducts(TOKEN, BUSINESS_ID),
    ).toMatchObject({ ok: true, value: { items: [product] } });
    expect(await client(jsonFetch(200, categoryFixture()).fetch).getCategory(TOKEN, BUSINESS_ID, "c")).toMatchObject({
      ok: true,
    });
  });

  it("rejects malformed successful responses", async () => {
    const product = productFixture();
    const invalid = { ok: false, failure: { kind: "invalid-response" } };
    expect(
      await client(jsonFetch(200, { ...product, sellingPrice: { amountMinor: 1, currency: "NGN" } }).fetch).getProduct(
        TOKEN,
        BUSINESS_ID,
        "p",
      ),
    ).toMatchObject(invalid);
    expect(
      await client(jsonFetch(200, { ...NGN, minorUnitDigits: "2" }).fetch).getBusinessCurrency(TOKEN, BUSINESS_ID),
    ).toMatchObject(invalid);
    expect(
      await client(jsonFetch(200, { ...product, businessId: BUSINESS_ID }).fetch).getProduct(TOKEN, BUSINESS_ID, "p"),
    ).toMatchObject(invalid);
  });
});
