import { describe, expect, it } from "vitest";
import {
  type ApiResult,
  IDEMPOTENCY_KEY_HEADER,
  TaliApiClient,
  type AccessToken,
} from "../src/lib/api-client/tali-api-client";
import { BUSINESS_ID } from "./support/catalog-fixtures";
import { jsonFetch } from "./support/fake-fetch";
import {
  adjustmentFixture,
  blindLine,
  fullLine,
  inventoryId,
  itemFixture,
  LOCATION_ID,
  movementFixture,
  openingFixture,
  receiptFixture,
  stocktakeFixture,
} from "./support/inventory-fixtures";

const TOKEN = "inventory-test-access" as AccessToken;
const KEY = "0190a000-0000-7000-8000-0000000000aa";
const BASE = `http://api.test/v1/businesses/${BUSINESS_ID}/inventory`;
const VARIANT = inventoryId();
const DOC = inventoryId();
const STOCKTAKE = inventoryId();
const LINE = { variantId: VARIANT, quantityMinor: "24", unit: "PIECE" };

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

const full = stocktakeFixture("FULL", { stocktakeId: STOCKTAKE, version: 3 });
const blind = stocktakeFixture("BLIND", { stocktakeId: STOCKTAKE, version: 3 });
const threshold = { variantId: VARIANT, locationId: LOCATION_ID, threshold: null, version: 1, changed: true };
const page = <T>(items: readonly T[]) => ({ items, nextCursor: null });

interface RouteCase {
  readonly name: string;
  readonly status: number;
  readonly body: unknown;
  readonly call: (api: TaliApiClient) => Promise<ApiResult<unknown>>;
  readonly method: string;
  readonly url: string;
  readonly sentBody?: unknown;
  readonly keyed?: boolean;
}

const ROUTES: readonly RouteCase[] = [
  {
    name: "balances",
    status: 200,
    body: page([itemFixture()]),
    call: (api) => api.listInventoryItems(TOKEN, BUSINESS_ID, { q: "milk", lowStock: true, after: "c1" }),
    method: "GET",
    url: `${BASE}/balances?after=c1&q=milk&lowStock=true`,
  },
  {
    name: "item",
    status: 200,
    body: itemFixture({ variantId: VARIANT }),
    call: (api) => api.getInventoryItem(TOKEN, BUSINESS_ID, VARIANT),
    method: "GET",
    url: `${BASE}/items/${VARIANT}`,
  },
  {
    name: "item movements",
    status: 200,
    body: page([movementFixture()]),
    call: (api) => api.listInventoryMovements(TOKEN, BUSINESS_ID, VARIANT, { after: "m1" }),
    method: "GET",
    url: `${BASE}/items/${VARIANT}/movements?after=m1`,
  },
  {
    name: "opening stock",
    status: 201,
    body: openingFixture(VARIANT, DOC),
    call: (api) => api.recordOpeningStock(TOKEN, BUSINESS_ID, { lines: [LINE] }, KEY),
    method: "POST",
    url: `${BASE}/opening-stock`,
    sentBody: { lines: [LINE] },
    keyed: true,
  },
  {
    name: "opening batch",
    status: 200,
    body: openingFixture(VARIANT, DOC),
    call: (api) => api.getOpeningBatch(TOKEN, BUSINESS_ID, DOC),
    method: "GET",
    url: `${BASE}/opening-batches/${DOC}`,
  },
  {
    name: "goods receipt",
    status: 201,
    body: receiptFixture(VARIANT, DOC),
    call: (api) => api.postGoodsReceipt(TOKEN, BUSINESS_ID, { lines: [LINE], reference: "INV-1" }, KEY),
    method: "POST",
    url: `${BASE}/goods-receipts`,
    sentBody: { lines: [LINE], reference: "INV-1" },
    keyed: true,
  },
  {
    name: "read goods receipt",
    status: 200,
    body: receiptFixture(VARIANT, DOC),
    call: (api) => api.getGoodsReceipt(TOKEN, BUSINESS_ID, DOC),
    method: "GET",
    url: `${BASE}/goods-receipts/${DOC}`,
  },
  {
    name: "reverse goods receipt",
    status: 200,
    body: { document: receiptFixture(VARIANT, DOC, "REVERSED").document, reversalMovements: [], changed: false },
    call: (api) => api.reverseGoodsReceipt(TOKEN, BUSINESS_ID, DOC, { reason: "Wrong delivery" }),
    method: "POST",
    url: `${BASE}/goods-receipts/${DOC}/reverse`,
    sentBody: { reason: "Wrong delivery" },
  },
  {
    name: "adjustment",
    status: 201,
    body: adjustmentFixture(VARIANT, "ADJUSTMENT", DOC),
    call: (api) =>
      api.recordAdjustment(
        TOKEN,
        BUSINESS_ID,
        { lines: [{ ...LINE, direction: "DECREASE" }], reasonCode: "DATA_ENTRY_CORRECTION" },
        KEY,
      ),
    method: "POST",
    url: `${BASE}/adjustments`,
    sentBody: { lines: [{ ...LINE, direction: "DECREASE" }], reasonCode: "DATA_ENTRY_CORRECTION" },
    keyed: true,
  },
  {
    name: "write-off",
    status: 201,
    body: adjustmentFixture(VARIANT, "WRITE_OFF", DOC),
    call: (api) => api.recordWriteOff(TOKEN, BUSINESS_ID, { lines: [LINE], reasonCode: "EXPIRED" }, KEY),
    method: "POST",
    url: `${BASE}/write-offs`,
    sentBody: { lines: [LINE], reasonCode: "EXPIRED" },
    keyed: true,
  },
  {
    name: "read adjustment",
    status: 200,
    body: adjustmentFixture(VARIANT, "WRITE_OFF", DOC),
    call: (api) => api.getAdjustment(TOKEN, BUSINESS_ID, DOC),
    method: "GET",
    url: `${BASE}/adjustments/${DOC}`,
  },
  {
    name: "reverse adjustment",
    status: 200,
    body: { document: adjustmentFixture(VARIANT, "ADJUSTMENT", DOC).document, reversalMovements: [], changed: true },
    call: (api) => api.reverseAdjustment(TOKEN, BUSINESS_ID, DOC, { reason: "Typed twice" }),
    method: "POST",
    url: `${BASE}/adjustments/${DOC}/reverse`,
    sentBody: { reason: "Typed twice" },
  },
  {
    name: "set threshold",
    status: 200,
    body: { ...threshold, threshold: { quantityMinor: "5", unit: "PIECE" } },
    call: (api) =>
      api.setLowStockThreshold(TOKEN, BUSINESS_ID, VARIANT, {
        expectedVersion: 0,
        threshold: { quantityMinor: "5", unit: "PIECE" },
      }),
    method: "PUT",
    url: `${BASE}/items/${VARIANT}/threshold`,
    sentBody: { expectedVersion: 0, threshold: { quantityMinor: "5", unit: "PIECE" } },
  },
  {
    name: "clear threshold",
    status: 200,
    body: threshold,
    call: (api) => api.clearLowStockThreshold(TOKEN, BUSINESS_ID, VARIANT, { expectedVersion: 1 }),
    method: "POST",
    url: `${BASE}/items/${VARIANT}/threshold/clear`,
    sentBody: { expectedVersion: 1 },
  },
  {
    name: "create stocktake",
    status: 201,
    body: {
      stocktakeId: STOCKTAKE,
      locationId: LOCATION_ID,
      status: "DRAFT",
      version: 1,
      note: null,
      createdAt: full.createdAt,
    },
    call: (api) => api.createStocktake(TOKEN, BUSINESS_ID, { note: "Month end" }, KEY),
    method: "POST",
    url: `${BASE}/stocktakes`,
    sentBody: { note: "Month end" },
    keyed: true,
  },
  {
    name: "stocktake list",
    status: 200,
    body: page([blind]),
    call: (api) => api.listStocktakes(TOKEN, BUSINESS_ID, { status: "DRAFT" }),
    method: "GET",
    url: `${BASE}/stocktakes?status=DRAFT`,
  },
  {
    name: "stocktake",
    status: 200,
    body: full,
    call: (api) => api.getStocktake(TOKEN, BUSINESS_ID, STOCKTAKE),
    method: "GET",
    url: `${BASE}/stocktakes/${STOCKTAKE}`,
  },
  {
    name: "stocktake lines",
    status: 200,
    body: page([blindLine(VARIANT)]),
    call: (api) => api.listStocktakeLines(TOKEN, BUSINESS_ID, STOCKTAKE, { limit: 100 }),
    method: "GET",
    url: `${BASE}/stocktakes/${STOCKTAKE}/lines?limit=100`,
  },
  {
    name: "count",
    status: 200,
    body: { stocktake: blind, line: blindLine(VARIANT, { version: 2 }), changed: true },
    call: (api) =>
      api.recordStocktakeCount(TOKEN, BUSINESS_ID, STOCKTAKE, VARIANT, {
        count: { packId: DOC, packCount: "2", loose: { quantityMinor: "3", unit: "PIECE" } },
        expectedVersion: 1,
      }),
    method: "PUT",
    url: `${BASE}/stocktakes/${STOCKTAKE}/lines/${VARIANT}`,
    sentBody: {
      count: { packId: DOC, packCount: "2", loose: { quantityMinor: "3", unit: "PIECE" } },
      expectedVersion: 1,
    },
  },
  {
    name: "remove line",
    status: 200,
    body: { stocktake: full, line: fullLine(VARIANT, { status: "REMOVED", version: 3 }), changed: true },
    call: (api) => api.removeStocktakeLine(TOKEN, BUSINESS_ID, STOCKTAKE, VARIANT, { expectedVersion: 2 }),
    method: "POST",
    url: `${BASE}/stocktakes/${STOCKTAKE}/lines/${VARIANT}/remove`,
    sentBody: { expectedVersion: 2 },
  },
  {
    name: "post stocktake",
    status: 200,
    body: { stocktake: { ...full, status: "POSTED" }, movements: [], changed: false },
    call: (api) => api.postStocktake(TOKEN, BUSINESS_ID, STOCKTAKE, { expectedVersion: 3 }),
    method: "POST",
    url: `${BASE}/stocktakes/${STOCKTAKE}/post`,
    sentBody: { expectedVersion: 3 },
  },
  {
    name: "cancel stocktake",
    status: 200,
    body: { stocktake: { ...full, status: "CANCELLED" }, changed: true },
    call: (api) => api.cancelStocktake(TOKEN, BUSINESS_ID, STOCKTAKE, { expectedVersion: 3, reason: "Wrong day" }),
    method: "POST",
    url: `${BASE}/stocktakes/${STOCKTAKE}/cancel`,
    sentBody: { expectedVersion: 3, reason: "Wrong day" },
  },
];

describe("TaliApiClient inventory transport (all 22 Slice 6 routes)", () => {
  it("covers every Slice 6 inventory route once", () => {
    expect(ROUTES).toHaveLength(22);
    expect(new Set(ROUTES.map((route) => `${route.method} ${route.url.split("?")[0] ?? ""}`)).size).toBe(22);
  });

  it.each(ROUTES)("$name: method, path, body, bearer and key; the response is schema-validated", async (route) => {
    const double = jsonFetch(route.status, route.body);
    const result = await route.call(client(double.fetch));
    expect(result).toMatchObject({ ok: true, status: route.status, value: route.body });
    expect(sent(double)).toEqual({
      url: route.url,
      method: route.method,
      authorization: `Bearer ${TOKEN}`,
      idempotencyKey: route.keyed === true ? KEY : null,
      body: route.sentBody,
    });
  });

  it.each(ROUTES)("$name: an unknown response field is an invalid response, never a value", async (route) => {
    const body = route.body as Record<string, unknown>;
    const result = await route.call(client(jsonFetch(route.status, { ...body, businessId: BUSINESS_ID }).fetch));
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-response", status: route.status } });
  });

  it("never sends a locationId and omits lowStock unless the filter is on", async () => {
    const double = jsonFetch(200, page([]));
    await client(double.fetch).listInventoryItems(TOKEN, BUSINESS_ID, { lowStock: false });
    expect(sent(double).url).toBe(`${BASE}/balances`);
    for (const route of ROUTES) {
      expect(JSON.stringify(route.sentBody ?? {})).not.toContain("locationId");
      expect(route.url).not.toContain("location");
    }
  });

  it("rejects a BLIND line that carries expectedAtCount or variance", async () => {
    const leaked = { ...blindLine(VARIANT), expectedAtCount: { quantityMinor: "9", unit: "PIECE" } };
    const result = await client(jsonFetch(200, page([leaked])).fetch).listStocktakeLines(TOKEN, BUSINESS_ID, STOCKTAKE);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-response" } });
    const mixed = await client(
      jsonFetch(200, page([blindLine(VARIANT), fullLine(inventoryId())])).fetch,
    ).listStocktakeLines(TOKEN, BUSINESS_ID, STOCKTAKE);
    expect(mixed).toMatchObject({ ok: false, failure: { kind: "invalid-response" } });
  });

  it("rejects a quantity sent as a JSON number", async () => {
    const result = await client(
      jsonFetch(200, itemFixture({ onHand: { quantityMinor: 12 as unknown as string, unit: "PIECE" } })).fetch,
    ).getInventoryItem(TOKEN, BUSINESS_ID, VARIANT);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-response" } });
  });
});

describe("TaliApiClient inventory errors", () => {
  const ids = [inventoryId(), inventoryId()].sort();

  it("keeps the strict STOCKTAKE_STALE details", async () => {
    const result = await client(
      jsonFetch(409, {
        error: { code: "STOCKTAKE_STALE", message: "stale", details: { staleVariantIds: ids, staleLineCount: 7 } },
      }).fetch,
    ).postStocktake(TOKEN, BUSINESS_ID, STOCKTAKE, { expectedVersion: 3 });
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "api-error",
        status: 409,
        code: "STOCKTAKE_STALE",
        message: "stale",
        correlationId: undefined,
        fields: [],
        stale: { staleVariantIds: ids, staleLineCount: 7 },
      },
    });
  });

  it("drops STOCKTAKE_STALE details that do not match the contract, and never attaches them to other codes", async () => {
    const extra = await client(
      jsonFetch(409, {
        error: {
          code: "STOCKTAKE_STALE",
          message: "stale",
          details: { staleVariantIds: ids, staleLineCount: 2, expected: "12" },
        },
      }).fetch,
    ).postStocktake(TOKEN, BUSINESS_ID, STOCKTAKE, { expectedVersion: 3 });
    expect(extra).toMatchObject({ ok: false, failure: { kind: "api-error", code: "STOCKTAKE_STALE" } });
    expect(extra.ok ? undefined : extra.failure).not.toHaveProperty("stale");

    const other = await client(
      jsonFetch(409, {
        error: { code: "VERSION_CONFLICT", message: "x", details: { staleVariantIds: ids, staleLineCount: 2 } },
      }).fetch,
    ).postStocktake(TOKEN, BUSINESS_ID, STOCKTAKE, { expectedVersion: 3 });
    expect(other.ok ? undefined : other.failure).not.toHaveProperty("stale");
  });

  it.each(["INSUFFICIENT_STOCK", "VERSION_CONFLICT", "CONFLICT", "PERMISSION_DENIED", "NOT_FOUND"])(
    "maps %s to an api-error",
    async (code) => {
      const result = await client(jsonFetch(409, { error: { code, message: "m" } }).fetch).recordWriteOff(
        TOKEN,
        BUSINESS_ID,
        { lines: [LINE], reasonCode: "DAMAGED" },
        KEY,
      );
      expect(result).toMatchObject({ ok: false, failure: { kind: "api-error", code } });
    },
  );
});
