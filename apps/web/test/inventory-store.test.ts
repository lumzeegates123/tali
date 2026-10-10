import { isUuidV7 } from "@tali/domain/kernel";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { InventoryStore, STOCKTAKE_LINE_MAX_PAGES } from "../src/inventory/inventory-store";
import { UNITS } from "./support/catalog-fixtures";
import {
  apiError,
  BUSINESS_A,
  type FakeTaliApi,
  json,
  networkError,
  registeredUserApi,
  settle,
} from "./support/fake-tali-api";
import { blindLine, inventoryId, itemFixture, receiptFixture, stocktakeFixture } from "./support/inventory-fixtures";

const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const BALANCES = `GET ${BASE}/inventory/balances`;
const RECEIPTS = `POST ${BASE}/inventory/goods-receipts`;
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });
const LINE = { variantId: inventoryId(), quantityMinor: "24", unit: "PIECE" };

function inventoryApi(): FakeTaliApi {
  return registeredUserApi().on(`GET ${BASE}/catalog/units`, json(200, UNITS)).on(BALANCES, page([]));
}

async function storeFor(api: FakeTaliApi): Promise<InventoryStore> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const session = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
  await session.signInLocal("local-user-ada");
  session.selectBusiness(BUSINESS_A.id);
  return new InventoryStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
}

describe("InventoryStore: the stock list", () => {
  it("loads units and the first page; search sends q and the filter sends lowStock=true only", async () => {
    const item = itemFixture({ lowStock: true });
    const api = inventoryApi().on(BALANCES, page([item], "c1"));
    const store = await storeFor(api);
    store.start();
    await settle();
    expect(store.getSnapshot().units).toMatchObject({ phase: "ready", items: UNITS.items });
    expect(store.getSnapshot().items).toMatchObject({ phase: "ready", items: [item], nextCursor: "c1" });
    await store.searchItems("  milk ", true);
    await store.loadMoreItems();
    await store.searchItems("", false);
    expect(api.to(BALANCES).map((request) => request.query)).toEqual([
      "",
      "?q=milk&lowStock=true",
      "?after=c1&q=milk&lowStock=true",
      "",
    ]);
  });

  it("exposes picker results as labels without quantities", async () => {
    const item = itemFixture({ onHand: { quantityMinor: "4321", unit: "PIECE" }, lowStock: true });
    const store = await storeFor(inventoryApi().on(BALANCES, page([item])));
    const outcome = await store.findItems("milk");
    expect(outcome).toMatchObject({ status: "ok" });
    const labels = outcome.status === "ok" ? outcome.value : [];
    expect(labels).toEqual([
      {
        variantId: item.variantId,
        productId: item.productId,
        name: item.name,
        sku: null,
        barcode: null,
        productStatus: "ACTIVE",
        stockUnit: "PIECE",
      },
    ]);
    expect(JSON.stringify(labels)).not.toMatch(/4321|onHand|threshold|lowStock/u);
  });

  it("keeps stocktake line labels free of quantities and marks unavailable items", async () => {
    const item = itemFixture({ onHand: { quantityMinor: "777", unit: "PIECE" } });
    const missing = inventoryId();
    const api = inventoryApi()
      .on(`GET ${BASE}/inventory/items/${item.variantId}`, json(200, item))
      .on(`GET ${BASE}/inventory/items/${missing}`, apiError(404, "NOT_FOUND"));
    const store = await storeFor(api);
    await store.ensureLabels([item.variantId, missing]);
    await store.ensureLabels([item.variantId]);
    const labels = store.getSnapshot().labels;
    expect(labels[missing]).toBeNull();
    expect(labels[item.variantId]?.name).toBe(item.name);
    expect(JSON.stringify(labels)).not.toMatch(/777|onHand/u);
    expect(api.to(`GET ${BASE}/inventory/items/${item.variantId}`)).toHaveLength(1);
  });
});

describe("InventoryStore: keyed stock documents", () => {
  it("reuses the key after a network failure and refuses a changed command until it is discarded", async () => {
    const variantId = LINE.variantId;
    const api = inventoryApi().on(
      RECEIPTS,
      networkError,
      json(201, receiptFixture(variantId)),
      json(201, receiptFixture(variantId)),
    );
    const store = await storeFor(api);
    const command = { lines: [LINE], reference: "INV-1" };

    expect(await store.postGoodsReceipt(command)).toMatchObject({ status: "failed", failure: { kind: "unavailable" } });
    expect(store.getSnapshot().keyed.goodsReceipt).toEqual({ inFlight: false, unconfirmed: true });

    const changed = { lines: [{ ...LINE, quantityMinor: "25" }], reference: "INV-1" };
    expect(await store.postGoodsReceipt(changed)).toEqual({ status: "unconfirmed" });
    expect(api.to(RECEIPTS)).toHaveLength(1);

    expect(await store.postGoodsReceipt({ reference: "INV-1", lines: [{ ...LINE }] })).toMatchObject({ status: "ok" });
    const [first, retry] = api.to(RECEIPTS).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(isUuidV7(first ?? "")).toBe(true);
    expect(retry).toBe(first);
    expect(store.getSnapshot().keyed.goodsReceipt.unconfirmed).toBe(false);

    await store.postGoodsReceipt(command);
    expect(api.to(RECEIPTS)[2]?.headers.get(IDEMPOTENCY_KEY_HEADER)).not.toBe(first);
  });

  it("treats a server error as unknown, and a definite rejection as final", async () => {
    const api = inventoryApi().on(
      RECEIPTS,
      apiError(503, "DEPENDENCY_UNAVAILABLE"),
      apiError(409, "CONFLICT"),
      json(201, receiptFixture(LINE.variantId)),
    );
    const store = await storeFor(api);
    const command = { lines: [LINE] };
    await store.postGoodsReceipt(command);
    expect(store.getSnapshot().keyed.goodsReceipt.unconfirmed).toBe(true);
    await store.postGoodsReceipt(command);
    expect(store.getSnapshot().keyed.goodsReceipt.unconfirmed).toBe(false);
    await store.postGoodsReceipt(command);
    const keys = api.to(RECEIPTS).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("discarding an unconfirmed submission gives the next one a new key", async () => {
    const api = inventoryApi().on(RECEIPTS, networkError, json(201, receiptFixture(LINE.variantId)));
    const store = await storeFor(api);
    await store.postGoodsReceipt({ lines: [LINE] });
    store.discardUnconfirmed("goodsReceipt");
    expect(await store.postGoodsReceipt({ lines: [{ ...LINE, quantityMinor: "30" }] })).toMatchObject({ status: "ok" });
    const keys = api.to(RECEIPTS).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("reloads the list from the API after a successful change and never edits a balance itself", async () => {
    const before = itemFixture({ onHand: { quantityMinor: "1", unit: "PIECE" } });
    const after = { ...before, onHand: { quantityMinor: "25", unit: "PIECE" }, balanceVersion: 2 };
    const api = inventoryApi()
      .on(BALANCES, page([before]), page([after]))
      .on(RECEIPTS, json(201, receiptFixture(before.variantId)));
    const store = await storeFor(api);
    await store.searchItems("", false);
    await store.postGoodsReceipt({ lines: [{ ...LINE, variantId: before.variantId }] });
    await settle();
    expect(api.to(BALANCES)).toHaveLength(2);
    expect(store.getSnapshot().items.items).toEqual([after]);
  });
});

describe("InventoryStore: stocktakes", () => {
  it("loads every line page up to the cap and reports truncation", async () => {
    const stocktakeId = inventoryId();
    const LINES = `GET ${BASE}/inventory/stocktakes/${stocktakeId}/lines`;
    const replies = Array.from({ length: STOCKTAKE_LINE_MAX_PAGES }, (_, index) =>
      page([blindLine(inventoryId())], `c${String(index + 1)}`),
    );
    const api = inventoryApi().on(LINES, ...replies);
    const store = await storeFor(api);
    const outcome = await store.loadStocktakeLines(stocktakeId);
    expect(outcome).toMatchObject({ status: "ok", value: { truncated: true } });
    expect(api.to(LINES).map((request) => request.query)[1]).toBe("?limit=100&after=c1");
    expect(api.to(LINES)).toHaveLength(STOCKTAKE_LINE_MAX_PAGES);
  });

  it("treats a POSTED replay as success and refreshes stock and stocktakes", async () => {
    const stocktake = stocktakeFixture("FULL", { status: "POSTED", version: 4 });
    const api = inventoryApi()
      .on(`GET ${BASE}/inventory/stocktakes`, page([stocktake]))
      .on(
        `POST ${BASE}/inventory/stocktakes/${stocktake.stocktakeId}/post`,
        json(200, { stocktake, movements: [], changed: false }),
      );
    const store = await storeFor(api);
    const outcome = await store.postStocktake(stocktake.stocktakeId, { expectedVersion: 3 });
    await settle();
    expect(outcome).toMatchObject({ status: "ok", value: { changed: false } });
    expect(api.to(BALANCES)).toHaveLength(1);
    expect(api.to(`GET ${BASE}/inventory/stocktakes`)).toHaveLength(1);
  });

  it("finds the DRAFT in progress after a create CONFLICT", async () => {
    const draft = stocktakeFixture("BLIND");
    const api = inventoryApi()
      .on(`POST ${BASE}/inventory/stocktakes`, apiError(409, "CONFLICT"))
      .on(`GET ${BASE}/inventory/stocktakes`, page([draft]));
    const store = await storeFor(api);
    expect(await store.createStocktake({})).toMatchObject({ status: "failed", failure: { code: "CONFLICT" } });
    expect(await store.findDraftStocktake()).toEqual({ status: "ok", value: draft });
    expect(api.to(`GET ${BASE}/inventory/stocktakes`)[0]?.query).toBe("?limit=1&status=DRAFT");
  });

  it("holds no credential or key in its snapshot", async () => {
    const store = await storeFor(inventoryApi());
    store.start();
    await settle();
    const text = JSON.stringify(store.getSnapshot());
    expect(text).not.toMatch(/Bearer|accessToken|local-test-access-token|idempotency/iu);
    expect(Object.keys(store)).toEqual(["subscribe", "getSnapshot"]);
  });
});
