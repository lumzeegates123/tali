import type * as NodeCrypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER } from "@tali/shared";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { SessionStore } from "../src/auth/session-store";
import type { DeviceCredentialStore, DeviceRegistration } from "../src/devices/device-credential-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
import { InventoryStore } from "../src/inventory/inventory-store";
import { UNITS } from "./support/catalog-fixtures";
import { BUSINESS_A, json, registeredUserApi, settle, TOKEN } from "./support/fake-tali-api";
import { fullLine, itemFixture, receiptFixture, stocktakeFixture } from "./support/inventory-fixtures";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

const INVENTORY_SOURCE = join(__dirname, "..", "src", "inventory");
const INV = `/v1/businesses/${BUSINESS_A.id}/inventory`;
/** Synthetic stand-in for a one-time device credential. */
const CREDENTIAL = `tali_dev_${"q".repeat(43)}`;
const DEVICE_ID = "0191a1b2-0000-7000-8000-0000000000d1";

beforeAll(() => {
  installSecureRandom();
});

/** Source code without comments, so prose such as "never credentials" is not mistaken for a leak. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

function sources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(INVENTORY_SOURCE)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({ name, text: code(readFileSync(join(INVENTORY_SOURCE, name), "utf8")) }));
}

function hits(pattern: RegExp): string[] {
  return sources()
    .filter(({ text }) => pattern.test(text))
    .map(({ name }) => name);
}

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

describe("mobile inventory source guards", () => {
  it("covers every inventory source file", () => {
    expect(sources().map(({ name }) => name)).toEqual(
      expect.arrayContaining(["inventory-store.ts", "stock-list-screen.tsx", "stocktake-detail-screen.tsx"]),
    );
  });

  it("does no floating-point quantity arithmetic", () => {
    const forbidden: readonly [string, RegExp][] = [
      ["parseFloat", /\bparseFloat\(/u],
      ["parseInt", /\bparseInt\(/u],
      ["Number()", /\bNumber\(/u],
      ["toFixed", /\.toFixed\(/u],
      ["Math", /\bMath\./u],
      ["unary plus on a quantity", /\+\s*\w+\.(?:quantityMinor|text|packCount|loose)\b/u],
      ["arithmetic on quantityMinor", /quantityMinor\s*[-+*/]|[-+*/]\s*\w+\.quantityMinor\b/u],
    ];
    const found = sources().flatMap(({ name, text }) =>
      forbidden.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${name}: ${label}`),
    );
    expect(found).toEqual([]);
  });

  it("never compares on hand with a threshold: LOW STOCK comes from the API boolean only", () => {
    expect(hits(/\b(?:onHand|threshold|balanceAfter|quantityMinor)\b[^\n;]*?(?:<=|>=|\s<\s|\s>\s)/u)).toEqual([]);
    expect(hits(/\bisLessThan|compareTo|isGreaterThan\b/u)).toEqual([]);
    expect(hits(/>LOW STOCK</u)).toEqual(["inventory-context.tsx"]);
    const context = sources().find(({ name }) => name === "inventory-context.tsx")?.text ?? "";
    expect(context).toMatch(/lowStock && !archived \? <Text/u);
    expect(hits(/<LowStockBadge lowStock=\{(?!item\.lowStock\})/u)).toEqual([]);
  });

  it("never computes a variance or expected quantity, and names them only in the FULL-only facts", () => {
    expect(hits(/\bexpectedAtCount\b|\bvariance\b/u)).toEqual(["stocktake-detail-screen.tsx"]);
    const detail = sources().find(({ name }) => name === "stocktake-detail-screen.tsx")?.text ?? "";
    const facts = detail.slice(detail.indexOf("function FullLineFacts"), detail.indexOf("function CountForm"));
    expect(facts).toContain('Extract<StocktakeLineResponse, { visibility: "FULL" }>');
    expect(detail.replace(facts, "")).not.toMatch(/\bexpectedAtCount\b|\bvariance\b/u);
  });

  it("never sends or reads a locationId and writes only through the API client", () => {
    expect(hits(/\blocationId\b/u)).toEqual([]);
    expect(hits(/\bfetch\(|XMLHttpRequest|\bWebSocket\b/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/(?:application|database|api|worker|integrations)/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/domain(?!\/kernel["'])/u)).toEqual([]);
  });

  it("persists nothing and logs nothing", () => {
    expect(
      hits(/\b(?:AsyncStorage|SecureStore|localStorage|sessionStorage|expo-secure-store|SQLite|MMKV|FileSystem)\b/u),
    ).toEqual([]);
    expect(hits(/\bconsole\./u)).toEqual([]);
  });

  it("components never name a token, credential or device header; the store keeps none in a field", () => {
    const leaks = sources()
      .filter(({ name }) => name.endsWith(".tsx"))
      .flatMap(({ name, text }) =>
        [...text.matchAll(/\b(?:token|accessToken|idToken|refreshToken|Authorization|credentials?|device)\b/gu)].map(
          (match) => `${name}: ${match[0]}`,
        ),
      );
    expect(leaks).toEqual([]);
    const store = sources().find(({ name }) => name === "inventory-store.ts")?.text ?? "";
    expect(store).not.toMatch(/#\w*(?:token|credential|device)\w*/iu);
    expect(store).not.toMatch(/this\.\w+\s*=\s*(?:token|device|credentials)\b/u);
  });
});

describe("mobile inventory store: device headers and credential boundary", () => {
  it("sends this business's device headers and keeps no credential, token, key or expected quantity in its state", async () => {
    const item = itemFixture();
    const stocktake = stocktakeFixture("FULL");
    const api = registeredUserApi()
      .on(`GET /v1/businesses/${BUSINESS_A.id}/catalog/units`, json(200, UNITS))
      .on(`GET ${INV}/balances`, json(200, { items: [item], nextCursor: null }))
      .on(`GET ${INV}/items/${item.variantId}`, json(200, item))
      .on(
        `GET ${INV}/stocktakes/${stocktake.stocktakeId}/lines`,
        json(200, { items: [fullLine(item.variantId)], nextCursor: null }),
      )
      .on(`POST ${INV}/goods-receipts`, json(201, receiptFixture(item.variantId)));
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
    const store = new InventoryStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    store.start();
    await settle();
    await store.loadStocktakeLines(stocktake.stocktakeId);
    await store.ensureLabels([item.variantId]);
    await store.postGoodsReceipt({ lines: [{ variantId: item.variantId, quantityMinor: "1", unit: "PIECE" }] });
    await settle();

    const post = api.to(`POST ${INV}/goods-receipts`)[0];
    expect(post?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(post?.headers.get(DEVICE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
    expect(api.to(`GET ${INV}/balances`)[0]?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    const key = post?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    expect(key).not.toBe("");
    const state = JSON.stringify(store.getSnapshot());
    for (const secret of [TOKEN, CREDENTIAL, DEVICE_ID, key]) expect(state).not.toContain(secret);
    expect(state).not.toMatch(/expectedAtCount|variance/u);
    expect(Object.keys(store)).toEqual(["subscribe", "getSnapshot"]);
    store.dispose();
  });
});
