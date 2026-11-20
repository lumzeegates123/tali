import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { SalesStore } from "../src/sales/sales-store";
import { NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import { BUSINESS_A, json, registeredUserApi, settle, TOKEN } from "./support/fake-tali-api";
import { saleFixture } from "./support/sales-fixtures";

const SOURCE_DIRS = ["sales", "ledger"].map((dir) => join(import.meta.dirname, "..", "src", dir));
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const SECRET_KEY =
  /^(?:token|accessToken|idToken|refreshToken|authorization|credentials?|deviceSecret|idempotencyKey)$/iu;

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

function secretKeys(value: unknown, path = "$"): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(SECRET_KEY.test(key) ? [`${path}.${key}`] : []),
    ...secretKeys(child, `${path}.${key}`),
  ]);
}

describe("sales and ledger source guards", () => {
  it("covers every sales and ledger source file", () => {
    expect(sources().map(({ name }) => name)).toEqual(
      expect.arrayContaining(["sales-store.ts", "sale-draft.ts", "sell-view.tsx", "ledger-store.ts"]),
    );
  });

  it("does no floating-point money or quantity arithmetic", () => {
    const forbidden: readonly [string, RegExp][] = [
      ["parseFloat", /\bparseFloat\(/u],
      ["Number()", /\bNumber\(/u],
      ["toFixed", /\.toFixed\(/u],
      ["Math", /\bMath\./u],
      ["arithmetic on amountMinor", /amountMinor\s*[-+*/]|[-+*/]\s*\w+\.amountMinor\b/u],
      ["arithmetic on quantityMinor", /quantityMinor\s*[-+*/]|[-+*/]\s*\w+\.quantityMinor\b/u],
    ];
    const found = sources().flatMap(({ name, text }) =>
      forbidden.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${name}: ${label}`),
    );
    expect(found).toEqual([]);
  });

  it("computes no total, change, tax, cost of goods, average cost or margin", () => {
    expect(
      hits(/\bMoney\.(?:sum|zero)\b|\.(?:subtract|multiply|allocate|percentage|plus|minus)\(|\.reduce\(/u),
    ).toEqual([]);
    expect(hits(/\b(?:total|amount|price|cost|money|change)\w*\.add\(/iu)).toEqual([]);
    expect(hits(/\b(?:margin|grossProfit|averageCost|wac)\s*[=:(]/iu)).toEqual([]);
    expect(hits(/\b(?:changeGiven|cogsTotal|taxTotal)\s*=(?!=)/u)).toEqual([]);
  });

  it("reads and writes only through the API client via the session, never fetch or a backend package", () => {
    expect(hits(/\bfetch\(|XMLHttpRequest|\bWebSocket\b/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/(?:application|database|api|worker|integrations)/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/domain(?!\/kernel["'])/u)).toEqual([]);
    expect(hits(/from\s+["'][^"']*(?:prisma|@nestjs|\/sales\/(?:domain|application))/u)).toEqual([]);
  });

  it("the ledger has no write call", () => {
    const ledger = sources().filter(({ name }) => name.startsWith("ledger"));
    expect(ledger.filter(({ text }) => /\bapi\.(?:record|post|create|reverse|update|delete)\w*\(/u.test(text))).toEqual(
      [],
    );
  });

  it("persists nothing and logs nothing", () => {
    expect(
      hits(/\b(?:localStorage|sessionStorage|indexedDB|cookieStore|AsyncStorage|SecureStore)\b|document\.cookie/u),
    ).toEqual([]);
    expect(hits(/\bconsole\./u)).toEqual([]);
  });

  it("components never name a token, an Authorization header or a credential property", () => {
    const leaks = sources()
      .filter(({ name }) => name.endsWith(".tsx"))
      .flatMap(({ name, text }) =>
        [...text.matchAll(/\b(?:token|accessToken|idToken|refreshToken|Authorization|credentials)\b/gu)].map(
          (match) => `${name}: ${match[0]}`,
        ),
      );
    expect(leaks).toEqual([]);
  });
});

describe("sales credential boundary", () => {
  it("keeps no token or idempotency key in the store snapshot", async () => {
    const milk = productFixture({ sellingPrice: { amountMinor: "50000", currency: "NGN" }, priceVersion: 1 });
    let key = "";
    const api = registeredUserApi()
      .on(`GET ${BASE}/currency`, json(200, NGN))
      .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
      .on(`GET ${BASE}/sales`, json(200, { items: [], nextCursor: null }));
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        key = new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER) ?? "";
        api.on(`POST ${BASE}/sales`, json(201, saleFixture({ saleId: key })));
      }
      return api.fetch(input, init);
    };
    const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch });
    const session = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
    await session.signInLocal("local-user-ada");
    session.selectBusiness(BUSINESS_A.id);
    const store = new SalesStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    store.start();
    await settle();
    store.addProduct(milk);
    store.updateLine(milk.variantId, { quantityText: "2" });
    store.updateTender(store.getSnapshot().tenders[0]?.rowId ?? "", { amountText: "1000" });
    const draft = JSON.stringify(store.getSnapshot());
    expect(draft).not.toContain(TOKEN);
    expect(secretKeys(store.getSnapshot())).toEqual([]);
    await store.submitSale(false);
    expect(key).not.toBe("");
    expect(store.getSnapshot().receipt?.saleId).toBe(key);
    expect(JSON.stringify(store.getSnapshot().checkout)).not.toContain(key);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(TOKEN);
    expect(secretKeys(store.getSnapshot())).toEqual([]);
    expect(Object.keys(store)).toEqual(["subscribe", "getSnapshot"]);
    store.dispose();
  });
});
