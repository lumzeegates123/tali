import type * as NodeCrypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MobilePublicConfig } from "@tali/config/public";
import { isUuidV7 } from "@tali/domain/kernel";
import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER, type ProductResponse } from "@tali/shared";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { BackHandler } from "react-native";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { createSessionStore, SessionProvider } from "../src/auth/session-context";
import { SessionStore } from "../src/auth/session-store";
import { CatalogStore } from "../src/catalog/catalog-store";
import type { DeviceCredentialStore, DeviceRegistration } from "../src/devices/device-credential-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { categoryFixture, NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import {
  apiError,
  BUSINESS_A,
  type FakeTaliApi,
  json,
  MEMBERSHIP_A,
  networkError,
  registeredUserApi,
  settle,
  TOKEN,
} from "./support/fake-tali-api";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

jest.setTimeout(30_000);

const LOCAL: MobilePublicConfig = { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" };
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const CATEGORY = categoryFixture({ name: "Drinks" });
const PRODUCT = productFixture({ name: "Malt 33cl", sku: "MALT-33", barcode: "5012345678900" });
const EMPTY_PAGE = { items: [], nextCursor: null };
/** Synthetic stand-in for a one-time device credential. */
const CREDENTIAL = `tali_dev_${"q".repeat(43)}`;
const DEVICE_ID = "0191a1b2-0000-7000-8000-0000000000d1";
const originalFetch = globalThis.fetch;

beforeAll(() => {
  installSecureRandom();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

function catalogApi(role = "OWNER", product: ProductResponse = PRODUCT): FakeTaliApi {
  return registeredUserApi()
    .on(
      "GET /v1/me/businesses",
      json(200, { items: [{ business: BUSINESS_A, membership: { ...MEMBERSHIP_A, role } }], nextCursor: null }),
    )
    .on(`GET ${BASE}/currency`, json(200, NGN))
    .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
    .on(`GET ${BASE}/products`, json(200, { items: [product], nextCursor: null }))
    .on(`GET ${BASE}/categories`, json(200, { items: [CATEGORY], nextCursor: null }))
    .on(`GET ${BASE}/products/${product.id}`, json(200, product));
}

/** Non-Android platform: no device registration, so no keystore is touched by these UI tests. */
async function openCatalog(api: FakeTaliApi, listHeading = true): Promise<SessionStore> {
  globalThis.fetch = api.fetch;
  const store = createSessionStore(LOCAL, "ios");
  await render(
    <SessionProvider store={store}>
      <OnboardingApp config={LOCAL} />
    </SessionProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
  await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
  await fireEvent.press(await screen.findByRole("button", { name: `Open ${BUSINESS_A.name}` }));
  await fireEvent.press(await screen.findByRole("tab", { name: "Catalog" }));
  if (listHeading) await screen.findByRole("header", { name: "Products" });
  await settle();
  return store;
}

async function openProduct(name = PRODUCT.name) {
  await fireEvent.press(await screen.findByRole("button", { name: `Open ${name}` }));
  await screen.findByRole("header", { name });
  await settle();
}

/** Captures the hardware-back listeners registered through `BackHandler`. */
function trackBackHandler() {
  const listeners: Parameters<typeof BackHandler.addEventListener>[1][] = [];
  jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
    listeners.push(handler);
    return {
      remove: () => {
        listeners.splice(listeners.indexOf(handler), 1);
      },
    };
  });
  return listeners;
}

describe("mobile catalog navigation and BackHandler", () => {
  it("registers hardware back only in detail and form views and removes it on return", async () => {
    const listeners = trackBackHandler();
    await openCatalog(catalogApi());
    expect(listeners).toHaveLength(0);

    const pressBack = async (): Promise<boolean | null | undefined> => {
      let consumed: boolean | null | undefined;
      await act(() => {
        consumed = listeners[0]?.({ type: "hardwareBackPress", timeStamp: 0 });
      });
      return consumed;
    };

    await openProduct();
    expect(listeners).toHaveLength(1);
    expect(await pressBack()).toBe(true);
    await screen.findByRole("header", { name: "Products" });
    expect(listeners).toHaveLength(0);

    await fireEvent.press(screen.getByRole("button", { name: "Create product" }));
    await screen.findByRole("header", { name: "Create product" });
    expect(listeners).toHaveLength(1);
    expect(await pressBack()).toBe(true);
    await screen.findByRole("header", { name: "Products" });
    expect(listeners).toHaveLength(0);

    await openProduct();
    await fireEvent.press(screen.getByRole("button", { name: "Edit product" }));
    await screen.findByRole("header", { name: `Edit ${PRODUCT.name}` });
    expect(listeners).toHaveLength(1);
    expect(await pressBack()).toBe(true);
    await screen.findByRole("header", { name: PRODUCT.name });
    expect(listeners).toHaveLength(1);
  });

  it("switches between Overview and Catalog in the business screen", async () => {
    await openCatalog(catalogApi());
    expect(screen.getByRole("tab", { name: "Catalog" }).props["accessibilityState"]).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByRole("tab", { name: "Overview" }));
    expect(await screen.findByRole("header", { name: BUSINESS_A.name })).toBeTruthy();
    expect(screen.queryByRole("header", { name: "Products" })).toBeNull();
  });
});

describe("mobile role affordances (UX only)", () => {
  it.each([
    ["OWNER", true, true],
    ["MANAGER", true, true],
    ["STOCK_KEEPER", true, false],
    ["CASHIER", false, false],
    ["ACCOUNTANT", false, false],
  ])("%s: manage=%s price=%s", async (role, canManage, canPrice) => {
    await openCatalog(catalogApi(role));
    expect(screen.queryByRole("button", { name: "Create product" }) !== null).toBe(canManage);
    await openProduct();
    expect(screen.getByTestId("product-price")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit product" }) !== null).toBe(canManage);
    expect(screen.queryByRole("button", { name: "Archive product" }) !== null).toBe(canManage);
    expect(screen.queryByRole("button", { name: "Set price" }) !== null).toBe(canPrice);
  });
});

describe("mobile product search", () => {
  it("searches by barcode server-side and filters by status", async () => {
    const api = catalogApi().on(
      `GET ${BASE}/products`,
      json(200, { items: [PRODUCT], nextCursor: null }),
      json(200, { items: [PRODUCT], nextCursor: null }),
      json(200, EMPTY_PAGE),
    );
    await openCatalog(api);
    await fireEvent.changeText(screen.getByLabelText("Search name, SKU or barcode"), " 5012345678900 ");
    await fireEvent.press(screen.getByRole("button", { name: "Search" }));
    await settle();
    expect(api.to(`GET ${BASE}/products`).at(-1)?.query).toBe("?status=ACTIVE&q=5012345678900");
    await fireEvent.press(screen.getByRole("radio", { name: "Archived" }));
    await settle();
    expect(api.to(`GET ${BASE}/products`).at(-1)?.query).toBe("?status=ARCHIVED&q=5012345678900");
    expect(await screen.findByText("No products match this search.")).toBeTruthy();
  });
});

describe("mobile create, edit and price", () => {
  it("creates with an exact price and reuses the key after an unknown outcome", async () => {
    const created = productFixture({
      name: "Zobo 50cl",
      categoryId: CATEGORY.id,
      sellingPrice: { amountMinor: "35000", currency: "NGN" },
      priceVersion: 1,
    });
    const api = catalogApi()
      .on(`POST ${BASE}/products`, networkError, json(201, created))
      .on(`GET ${BASE}/products/${created.id}`, json(200, created));
    await openCatalog(api);
    await fireEvent.press(screen.getByRole("button", { name: "Create product" }));
    await fireEvent.changeText(await screen.findByLabelText("Name"), "Zobo 50cl");
    await fireEvent.press(screen.getByRole("radio", { name: "Drinks" }));
    await fireEvent.press(screen.getByRole("radio", { name: "PIECE (count)" }));
    await fireEvent.changeText(screen.getByLabelText("Selling price (optional)"), "350.00");
    await fireEvent.press(screen.getByRole("button", { name: "Create product" }));
    await settle();
    await fireEvent.press(await screen.findByRole("button", { name: "Try again" }));
    await settle();
    expect(await screen.findByRole("header", { name: "Zobo 50cl" })).toBeTruthy();
    expect(screen.getByText("Selling price: 350.00 NGN")).toBeTruthy();

    const sent = api.to(`POST ${BASE}/products`);
    const body = {
      name: "Zobo 50cl",
      categoryId: CATEGORY.id,
      stockUnit: "PIECE",
      trackInventory: true,
      initialPrice: { amountMinor: "35000", currency: "NGN" },
    };
    expect(sent.map((request) => request.body)).toEqual([body, body]);
    const keys = sent.map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "");
    expect(isUuidV7(keys[0] ?? "")).toBe(true);
    expect(keys[1]).toBe(keys[0]);
  });

  it("keeps the draft on VERSION_CONFLICT and resubmits only the edited field with the new version", async () => {
    const latest = { ...PRODUCT, version: 2, sku: "MALT-33-B" };
    const saved = { ...latest, version: 3, name: "Malt can" };
    const api = catalogApi()
      .on(`GET ${BASE}/products/${PRODUCT.id}`, json(200, PRODUCT), json(200, latest), json(200, saved))
      .on(`PATCH ${BASE}/products/${PRODUCT.id}`, apiError(409, "VERSION_CONFLICT"), json(200, saved));
    await openCatalog(api);
    await openProduct();
    await fireEvent.press(screen.getByRole("button", { name: "Edit product" }));
    await fireEvent.changeText(await screen.findByLabelText("Name"), "Malt can");
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await settle();
    expect(await screen.findByText("This record changed since you opened it. Reload to see the latest.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Reload latest" }));
    await settle();
    expect(await screen.findByText(/Latest saved values \(version 2\)/u)).toBeTruthy();
    expect(screen.getByLabelText("Name").props["value"]).toBe("Malt can");
    await fireEvent.press(screen.getByRole("button", { name: "Save changes" }));
    await settle();
    expect(api.to(`PATCH ${BASE}/products/${PRODUCT.id}`).map((request) => request.body)).toEqual([
      { expectedVersion: 1, name: "Malt can" },
      { expectedVersion: 2, name: "Malt can" },
    ]);
  });

  it("sets an exact price with the loaded version and rejects inexact input locally", async () => {
    const priced = { ...PRODUCT, version: 2, priceVersion: 1, sellingPrice: { amountMinor: "35050", currency: "NGN" } };
    const api = catalogApi().on(`PUT ${BASE}/products/${PRODUCT.id}/price`, json(200, priced));
    await openCatalog(api);
    await openProduct();
    await fireEvent.changeText(screen.getByLabelText("New selling price (NGN)"), "350.505");
    await fireEvent.press(screen.getByRole("button", { name: "Set price" }));
    expect(api.to(`PUT ${BASE}/products/${PRODUCT.id}/price`)).toHaveLength(0);

    await fireEvent.changeText(screen.getByLabelText("New selling price (NGN)"), "350.50");
    await fireEvent.press(screen.getByRole("button", { name: "Set price" }));
    await settle();
    expect(api.to(`PUT ${BASE}/products/${PRODUCT.id}/price`)[0]?.body).toEqual({
      expectedVersion: 1,
      price: { amountMinor: "35050", currency: "NGN" },
    });
    expect(await screen.findByText("Price saved.")).toBeTruthy();
    expect(screen.getByText("Selling price: 350.50 NGN")).toBeTruthy();
  });

  it("archives with the loaded version", async () => {
    const api = catalogApi().on(
      `POST ${BASE}/products/${PRODUCT.id}/archive`,
      json(200, { ...PRODUCT, status: "ARCHIVED", version: 2 }),
    );
    await openCatalog(api);
    await openProduct();
    await fireEvent.press(screen.getByRole("button", { name: "Archive product" }));
    await settle();
    expect(await screen.findByText("Product archived.")).toBeTruthy();
    expect(api.to(`POST ${BASE}/products/${PRODUCT.id}/archive`)[0]?.body).toEqual({ expectedVersion: 1 });
  });
});

describe("mobile NOT_FOUND semantics", () => {
  it("a missing product is a neutral notice and the business stays selected", async () => {
    const api = catalogApi().on(`GET ${BASE}/products/${PRODUCT.id}`, apiError(404, "NOT_FOUND"));
    const store = await openCatalog(api);
    await fireEvent.press(screen.getByRole("button", { name: `Open ${PRODUCT.name}` }));
    await settle();
    expect(
      await screen.findByText(
        "This item is not available. It may have been removed, or you may no longer have access to it.",
      ),
    ).toBeTruthy();
    expect(store.getSnapshot().selectedBusinessId).toBe(BUSINESS_A.id);
  });

  it("a business-scope NOT_FOUND offers Switch business and does not clear the selection itself", async () => {
    const api = catalogApi().on(`GET ${BASE}/products`, apiError(404, "NOT_FOUND"));
    const store = await openCatalog(api, false);
    expect(await screen.findByText("This business is no longer available to you.")).toBeTruthy();
    expect(store.getSnapshot().selectedBusinessId).toBe(BUSINESS_A.id);
    await fireEvent.press(screen.getByRole("button", { name: "Switch business" }));
    expect(await screen.findByRole("header", { name: "Choose a business" })).toBeTruthy();
  });
});

function memoryDeviceStore(registration: DeviceRegistration): DeviceCredentialStore {
  const items = new Map([[BUSINESS_A.id, registration]]);
  return {
    read: (businessId) => Promise.resolve(items.get(businessId)),
    save: (businessId, value) => {
      items.set(businessId, value);
      return Promise.resolve();
    },
    clear: (businessId) => {
      items.delete(businessId);
      return Promise.resolve();
    },
  };
}

describe("mobile catalog store: device headers and credential boundary", () => {
  it("sends this business's device headers and keeps no credential, token or key in its state", async () => {
    const api = catalogApi().on(`POST ${BASE}/products`, json(201, productFixture({ name: "Zobo" })));
    const client = new TaliApiClient({
      baseUrl: "http://api.test",
      createCorrelationId: () => "c-1",
      fetch: api.fetch,
    });
    const session = new SessionStore({
      api: client,
      newIdempotencyKey: newUuidV7,
      deviceRegistrationSupported: true,
      deviceStore: memoryDeviceStore({ deviceId: DEVICE_ID, credential: CREDENTIAL }),
    });
    await session.signInLocal("local-user-ada");
    session.selectBusiness(BUSINESS_A.id);
    await settle();
    const catalog = new CatalogStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    catalog.start();
    await settle();
    await catalog.createProduct({ name: "Zobo", stockUnit: "PIECE", trackInventory: true });
    await settle();

    const create = api.to(`POST ${BASE}/products`)[0];
    expect(create?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(create?.headers.get(DEVICE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
    expect(api.to(`GET ${BASE}/products`)[0]?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    const key = create?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    const state = JSON.stringify(catalog.getSnapshot());
    for (const secret of [TOKEN, CREDENTIAL, DEVICE_ID, key]) expect(state).not.toContain(secret);
    expect(Object.keys(catalog)).toEqual(["subscribe", "getSnapshot"]);
    catalog.dispose();
  });
});

const CATALOG_SOURCE = join(__dirname, "..", "src", "catalog");

/** Source code without comments, so prose such as "never credentials" is not mistaken for a leak. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

function sources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(CATALOG_SOURCE)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({ name, text: code(readFileSync(join(CATALOG_SOURCE, name), "utf8")) }));
}

describe("mobile catalog source guards", () => {
  it("components never name a token, credential or device header; the store keeps none in a field", () => {
    const leaks = sources()
      .filter(({ name }) => name.endsWith(".tsx"))
      .flatMap(({ name, text }) =>
        [...text.matchAll(/\b(?:token|accessToken|idToken|refreshToken|Authorization|credentials?|device)\b/gu)].map(
          (match) => `${name}: ${match[0]}`,
        ),
      );
    expect(leaks).toEqual([]);
    const store = sources().find(({ name }) => name === "catalog-store.ts")?.text ?? "";
    expect(store).not.toMatch(/#\w*(?:token|credential|device)\w*/iu);
    expect(store).not.toMatch(/this\.\w+\s*=\s*(?:token|device|credentials)\b/u);
  });

  it("persists nothing, logs nothing and uses no floating-point money", () => {
    const forbidden: readonly [string, RegExp][] = [
      ["storage", /\b(?:AsyncStorage|SecureStore|localStorage|sessionStorage|expo-secure-store)\b/u],
      ["console", /\bconsole\./u],
      ["parseFloat", /\bparseFloat\(/u],
      ["Number()", /\bNumber\(/u],
      ["toFixed", /\.toFixed\(/u],
      ["Math", /\bMath\./u],
    ];
    const hits = sources().flatMap(({ name, text }) =>
      forbidden.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${name}: ${label}`),
    );
    expect(hits).toEqual([]);
  });
});
