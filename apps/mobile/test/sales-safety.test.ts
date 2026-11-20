import type * as NodeCrypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER } from "@tali/shared";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { SessionStore } from "../src/auth/session-store";
import type { DeviceCredentialStore, DeviceRegistration } from "../src/devices/device-credential-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
import { LedgerStore } from "../src/ledger/ledger-store";
import { SalesStore } from "../src/sales/sales-store";
import { NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import { BUSINESS_A, json, registeredUserApi, settle, TOKEN } from "./support/fake-tali-api";
import { accountBalance, ledgerAccount, saleFixture } from "./support/sales-fixtures";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

const SOURCE_DIRS = ["sales", "ledger"].map((dir) => join(__dirname, "..", "src", dir));
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const DEVICE_ID = "0191a1b2-0000-7000-8000-0000000000d1";
const CREDENTIAL = "device-fixture-credential";

beforeAll(() => {
  installSecureRandom();
});

function sources(): readonly { readonly name: string; readonly text: string }[] {
  return SOURCE_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
      .map((name) => ({ name, text: code(readFileSync(join(dir, name), "utf8")) })),
  );
}

/** Source code without comments, so prose is not mistaken for code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
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

describe("mobile sales and ledger source guards", () => {
  it("covers every sales and ledger source file", () => {
    expect(sources().map(({ name }) => name)).toEqual(
      expect.arrayContaining(["sales-store.ts", "sale-draft.ts", "sell-screen.tsx", "ledger-store.ts"]),
    );
  });

  it("does no floating-point money or quantity arithmetic and computes no totals, change, cost or margin", () => {
    const forbidden: readonly [string, RegExp][] = [
      ["parseFloat", /\bparseFloat\(/u],
      ["Number()", /\bNumber\(/u],
      ["toFixed", /\.toFixed\(/u],
      ["Math", /\bMath\./u],
      ["arithmetic on amountMinor", /amountMinor\s*[-+*/]|[-+*/]\s*\w+\.amountMinor\b/u],
      ["arithmetic on quantityMinor", /quantityMinor\s*[-+*/]|[-+*/]\s*\w+\.quantityMinor\b/u],
      [
        "money arithmetic",
        /\bMoney\.(?:sum|zero)\b|\.(?:subtract|multiply|allocate|percentage|plus|minus)\(|\.reduce\(/u,
      ],
      ["margin or average cost", /\b(?:margin|grossProfit|averageCost|wac)\s*[=:(]/iu],
      ["assigned server figure", /\b(?:changeGiven|cogsTotal|taxTotal)\s*=(?!=)/u],
    ];
    const found = sources().flatMap(({ name, text }) =>
      forbidden.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${name}: ${label}`),
    );
    expect(found).toEqual([]);
  });

  it("goes only through the API client via the session; the ledger has no write call", () => {
    expect(hits(/\bfetch\(|XMLHttpRequest|\bWebSocket\b/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/(?:application|database|api|worker|integrations)/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/domain(?!\/kernel["'])/u)).toEqual([]);
    const ledger = sources().filter(({ name }) => name.startsWith("ledger"));
    expect(ledger.filter(({ text }) => /\bapi\.(?:record|post|create|reverse|update|delete)\w*\(/u.test(text))).toEqual(
      [],
    );
  });

  it("persists nothing and logs nothing", () => {
    expect(
      hits(/\b(?:AsyncStorage|SecureStore|localStorage|sessionStorage|expo-secure-store|SQLite|MMKV|FileSystem)\b/u),
    ).toEqual([]);
    expect(hits(/\bconsole\./u)).toEqual([]);
  });

  it("components never name a token, credential or device header; stores keep none in a field", () => {
    const leaks = sources()
      .filter(({ name }) => name.endsWith(".tsx"))
      .flatMap(({ name, text }) =>
        [...text.matchAll(/\b(?:token|accessToken|idToken|refreshToken|Authorization|credentials?|device)\b/gu)].map(
          (match) => `${name}: ${match[0]}`,
        ),
      );
    expect(leaks).toEqual([]);
    for (const store of ["sales-store.ts", "ledger-store.ts"]) {
      const text = sources().find(({ name }) => name === store)?.text ?? "";
      expect(text).not.toMatch(/#\w*(?:token|credential|device)\w*/iu);
      expect(text).not.toMatch(/this\.\w+\s*=\s*(?:token|device|credentials)\b/u);
    }
  });
});

describe("mobile sales and ledger stores: device headers and credential boundary", () => {
  it("send this business's device headers and keep no credential, token or key in their state", async () => {
    const milk = productFixture({ sellingPrice: { amountMinor: "50000", currency: "NGN" }, priceVersion: 1 });
    let key = "";
    const api = registeredUserApi()
      .on(`GET ${BASE}/currency`, json(200, NGN))
      .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
      .on(`GET ${BASE}/sales`, json(200, { items: [], nextCursor: null }))
      .on(`GET ${BASE}/inventory/balances`, json(200, { items: [], nextCursor: null }))
      .on(`GET ${BASE}/ledger/accounts`, json(200, { items: [ledgerAccount()] }))
      .on(`GET ${BASE}/ledger/balances`, json(200, { items: [accountBalance()] }));
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        key = new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER) ?? "";
        api.on(`POST ${BASE}/sales`, json(201, saleFixture({ saleId: key })));
      }
      return api.fetch(input, init);
    };
    const session = new SessionStore({
      api: new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch }),
      newIdempotencyKey: newUuidV7,
      deviceRegistrationSupported: true,
      deviceStore: memoryDeviceStore({ deviceId: DEVICE_ID, credential: CREDENTIAL }),
    });
    await session.signInLocal("local-user-ada");
    session.selectBusiness(BUSINESS_A.id);
    await settle();

    const sales = new SalesStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    sales.start();
    await settle();
    sales.addProduct(milk);
    sales.updateLine(milk.variantId, { quantityText: "2" });
    sales.updateTender(sales.getSnapshot().tenders[0]?.rowId ?? "", { amountText: "1000" });
    await sales.submitSale(false);
    const ledger = new LedgerStore({ businessId: BUSINESS_A.id, session });
    await ledger.load();

    const post = api.to(`POST ${BASE}/sales`)[0];
    expect(post?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(post?.headers.get(DEVICE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
    expect(api.to(`GET ${BASE}/ledger/accounts`)[0]?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(key).not.toBe("");
    expect(sales.getSnapshot().receipt?.saleId).toBe(key);
    for (const state of [JSON.stringify(sales.getSnapshot()), JSON.stringify(ledger.getSnapshot())]) {
      for (const secret of [TOKEN, CREDENTIAL, DEVICE_ID]) expect(state).not.toContain(secret);
    }
    expect(JSON.stringify(sales.getSnapshot().checkout)).not.toContain(key);
    expect(Object.keys(sales)).toEqual(["subscribe", "getSnapshot"]);
    sales.dispose();
    ledger.dispose();
  });
});
