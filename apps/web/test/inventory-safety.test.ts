import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { InventoryStore } from "../src/inventory/inventory-store";
import { UNITS } from "./support/catalog-fixtures";
import { BUSINESS_A, json, registeredUserApi, settle, TOKEN } from "./support/fake-tali-api";
import { fullLine, itemFixture, receiptFixture, stocktakeFixture } from "./support/inventory-fixtures";

const INVENTORY_SOURCE = join(import.meta.dirname, "..", "src", "inventory");
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const SECRET_KEY =
  /^(?:token|accessToken|idToken|refreshToken|authorization|credentials?|deviceSecret|idempotencyKey)$/iu;

function sources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(INVENTORY_SOURCE)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => ({ name, text: code(readFileSync(join(INVENTORY_SOURCE, name), "utf8")) }));
}

/** Source code without comments, so prose such as "never LOW STOCK" is not mistaken for code. */
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

describe("inventory source guards", () => {
  it("covers every inventory source file", () => {
    expect(sources().map(({ name }) => name)).toEqual(
      expect.arrayContaining(["inventory-store.ts", "stock-list.tsx", "stocktake-detail.tsx", "quantity-input.ts"]),
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
    const comparison = /\b(?:onHand|threshold|balanceAfter|quantityMinor)\b[^\n;]*?(?:<=|>=|\s<\s|\s>\s)/u;
    expect(hits(comparison)).toEqual([]);
    expect(hits(/onHand\s*<=\s*\w*threshold/iu)).toEqual([]);
    expect(hits(/\bisLessThan|compareTo|isGreaterThan\b/u)).toEqual([]);
    expect(hits(/badge-low|>LOW STOCK</u)).toEqual(["stock-list.tsx"]);
    const badge = sources().find(({ name }) => name === "stock-list.tsx")?.text ?? "";
    expect(badge).toMatch(/lowStock && !archived \? <strong className="badge-low">LOW STOCK<\/strong>/u);
    expect(hits(/<LowStockBadge lowStock=\{(?!item\.lowStock\})/u)).toEqual([]);
  });

  it("never computes a variance or expected quantity, and names them only in the FULL-only cells", () => {
    expect(hits(/\bexpectedAtCount\b|\bvariance\b/u)).toEqual(["stocktake-detail.tsx"]);
    const detail = sources().find(({ name }) => name === "stocktake-detail.tsx")?.text ?? "";
    const fullCells = detail.slice(detail.indexOf("function FullCells"), detail.indexOf("function CountForm"));
    expect(fullCells).toContain('Extract<StocktakeLineResponse, { visibility: "FULL" }>');
    const outside = detail.replace(fullCells, "");
    expect(outside).not.toMatch(/\bexpectedAtCount\b|\bvariance\b/u);
  });

  it("never sends or reads a locationId", () => {
    expect(hits(/\blocationId\b/u)).toEqual([]);
  });

  it("writes inventory only through the API client via the session, never fetch or a backend package", () => {
    expect(hits(/\bfetch\(|XMLHttpRequest|\bWebSocket\b/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/(?:application|database|api|worker|integrations)/u)).toEqual([]);
    expect(hits(/from\s+["']@tali\/domain(?!\/kernel["'])/u)).toEqual([]);
    expect(hits(/from\s+["'][^"']*(?:prisma|@nestjs|\/inventory\/(?:domain|application))/u)).toEqual([]);
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
    const store = sources().find(({ name }) => name === "inventory-store.ts")?.text ?? "";
    expect(store).not.toMatch(/#\w*(?:token|credential)\w*/iu);
    expect(store).not.toMatch(/this\.\w+\s*=\s*(?:token|credentials)\b/u);
  });
});

describe("inventory credential boundary", () => {
  it("keeps no credential, key, expected quantity or variance in the store snapshot", async () => {
    const item = itemFixture();
    const stocktake = stocktakeFixture("FULL");
    const api = registeredUserApi()
      .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
      .on(`GET ${BASE}/inventory/balances`, json(200, { items: [item], nextCursor: null }))
      .on(`GET ${BASE}/inventory/stocktakes`, json(200, { items: [stocktake], nextCursor: null }))
      .on(`GET ${BASE}/inventory/items/${item.variantId}`, json(200, item))
      .on(
        `GET ${BASE}/inventory/stocktakes/${stocktake.stocktakeId}/lines`,
        json(200, { items: [fullLine(item.variantId)], nextCursor: null }),
      )
      .on(`POST ${BASE}/inventory/goods-receipts`, json(201, receiptFixture(item.variantId)));
    const client = new TaliApiClient({
      baseUrl: "http://api.test",
      createCorrelationId: () => "c-1",
      fetch: api.fetch,
    });
    const session = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
    await session.signInLocal("local-user-ada");
    session.selectBusiness(BUSINESS_A.id);
    const store = new InventoryStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    store.start();
    await settle();
    await store.refreshStocktakes();
    await store.loadStocktakeLines(stocktake.stocktakeId);
    await store.ensureLabels([item.variantId]);
    await store.postGoodsReceipt({ lines: [{ variantId: item.variantId, quantityMinor: "1", unit: "PIECE" }] });
    await settle();

    const key = api.to(`POST ${BASE}/inventory/goods-receipts`)[0]?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    expect(key).not.toBe("");
    const serialized = JSON.stringify(store.getSnapshot());
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toMatch(/expectedAtCount|variance/u);
    expect(secretKeys(store.getSnapshot())).toEqual([]);
    expect(Object.keys(store)).toEqual(["subscribe", "getSnapshot"]);
    store.dispose();
  });
});
