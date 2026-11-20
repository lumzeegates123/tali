import { defineCurrency, defineUnit, isUuidV7 } from "@tali/domain/kernel";
import type { ProductResponse } from "@tali/shared";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { SessionStore } from "../src/lib/auth/session-store";
import { newUuidV7 } from "../src/lib/ids/uuidv7";
import { basisPointsText, buildSalePayload, percentToBasisPoints } from "../src/sales/sale-draft";
import { SalesStore } from "../src/sales/sales-store";
import { NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import {
  apiError,
  BUSINESS_A,
  deferred,
  type FakeTaliApi,
  json,
  networkError,
  registeredUserApi,
  settle,
} from "./support/fake-tali-api";
import { saleFixture } from "./support/sales-fixtures";

const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const SALES = `POST ${BASE}/sales`;
const LIST = `GET ${BASE}/sales`;
const PRODUCTS = `GET ${BASE}/products`;
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });
const ngn = (amountMinor: string) => ({ amountMinor, currency: "NGN" });

const MILK: ProductResponse = productFixture({
  name: "Peak Milk 400g",
  sellingPrice: ngn("50000"),
  priceVersion: 1,
});
const RICE: ProductResponse = productFixture({
  name: "Rice 1kg",
  stockUnit: "KG",
  sellingPrice: ngn("120000"),
  priceVersion: 3,
});
const NO_PRICE: ProductResponse = productFixture({ name: "Unpriced soap" });

function salesApi(): FakeTaliApi {
  return registeredUserApi()
    .on(`GET ${BASE}/currency`, json(200, NGN))
    .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
    .on(PRODUCTS, page([MILK, RICE, NO_PRICE]))
    .on(LIST, page([]));
}

async function storeFor(api: FakeTaliApi): Promise<{ store: SalesStore; session: SessionStore }> {
  const client = new TaliApiClient({ baseUrl: "http://api.test", createCorrelationId: () => "c-1", fetch: api.fetch });
  const session = new SessionStore({ api: client, newIdempotencyKey: newUuidV7 });
  await session.signInLocal("local-user-ada");
  session.selectBusiness(BUSINESS_A.id);
  const store = new SalesStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
  store.start();
  await settle();
  return { store, session };
}

/** A cart of 2 milk paid in cash. */
function fillCart(store: SalesStore) {
  expect(store.addProduct(MILK)).toBe("added");
  store.updateLine(MILK.variantId, { quantityText: "2" });
  const [tender] = store.getSnapshot().tenders;
  store.updateTender(tender?.rowId ?? "", { amountText: "1000", cashReceivedText: "1500" });
}

const EXPECTED_PAYLOAD = {
  lines: [{ variantId: MILK.variantId, quantity: { quantityMinor: "2", unit: "PIECE" }, expectedPriceVersion: 1 }],
  tenders: [{ method: "CASH", amount: ngn("100000"), cashReceived: ngn("150000") }],
};

describe("sale draft parsing (no client totals)", () => {
  it("converts percent text to basis points by string and refuses out-of-range values", () => {
    expect(percentToBasisPoints("12.5")).toBe(1250);
    expect(percentToBasisPoints("0.01")).toBe(1);
    expect(percentToBasisPoints("99.99")).toBe(9999);
    for (const bad of ["0", "100", "12.345", "-1", "1e2", "", "abc"]) expect(percentToBasisPoints(bad)).toBeUndefined();
    expect(basisPointsText(1250)).toBe("12.5%");
    expect(basisPointsText(5)).toBe("0.05%");
  });

  it("parses quantities exactly in the stock unit and rejects extra precision instead of rounding", () => {
    const unitFor = (code: string) => (code === "KG" ? defineUnit("KG", "MASS", 3) : defineUnit("PIECE", "COUNT", 0));
    const line = (quantityText: string) => ({
      variantId: RICE.variantId,
      productId: RICE.id,
      name: "Rice",
      sku: null,
      stockUnit: "KG",
      displayedPrice: ngn("120000"),
      priceVersion: 3,
      quantityText,
      discountKind: "NONE" as const,
      discountText: "",
    });
    const tenders = [{ rowId: "t", method: "CASH" as const, amountText: "10", reference: "", cashReceivedText: "" }];
    const currency = defineCurrency("NGN", 2);
    const ok = buildSalePayload({ lines: [line("1.25")], tenders, currency, unitFor, allowDiscount: false });
    expect(ok).toMatchObject({ ok: true, payload: { lines: [{ quantity: { quantityMinor: "1250", unit: "KG" } }] } });
    const bad = buildSalePayload({ lines: [line("1.2345")], tenders, currency, unitFor, allowDiscount: false });
    expect(bad.ok ? undefined : bad.lines[RICE.variantId]?.quantity).toMatch(/at most 3 decimal places/u);
  });

  it("refuses a discount without the discount affordance and a reference longer than 64 characters", () => {
    const unitFor = () => defineUnit("PIECE", "COUNT", 0);
    const currency = defineCurrency("NGN", 2);
    const line = {
      variantId: MILK.variantId,
      productId: MILK.id,
      name: "Milk",
      sku: null,
      stockUnit: "PIECE",
      displayedPrice: ngn("50000"),
      priceVersion: 1,
      quantityText: "1",
      discountKind: "FIXED" as const,
      discountText: "50",
    };
    const tender = {
      rowId: "t",
      method: "BANK_TRANSFER" as const,
      amountText: "450",
      reference: "x".repeat(65),
      cashReceivedText: "",
    };
    const result = buildSalePayload({ lines: [line], tenders: [tender], currency, unitFor, allowDiscount: false });
    expect(result).toMatchObject({
      ok: false,
      lines: { [MILK.variantId]: { discount: "You cannot give discounts." } },
      tenders: { t: { reference: "Use at most 64 characters." } },
    });
    const allowed = buildSalePayload({
      lines: [line],
      tenders: [{ ...tender, reference: " TRF-1 " }],
      currency,
      unitFor,
      allowDiscount: true,
    });
    expect(allowed).toEqual({
      ok: true,
      payload: {
        lines: [
          {
            variantId: MILK.variantId,
            quantity: { quantityMinor: "1", unit: "PIECE" },
            expectedPriceVersion: 1,
            discount: { kind: "FIXED", amount: ngn("5000") },
          },
        ],
        tenders: [{ method: "BANK_TRANSFER", amount: ngn("45000"), reference: "TRF-1" }],
      },
    });
  });
});

describe("SalesStore: cart and search", () => {
  it("searches ACTIVE products, adds one row per variant and never sells a product without a price", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    await store.searchProducts("  milk ");
    expect(api.to(PRODUCTS).at(-1)?.query).toBe("?limit=20&status=ACTIVE&q=milk");
    expect(store.addProduct(MILK)).toBe("added");
    expect(store.addProduct(MILK)).toBe("alreadyInCart");
    expect(store.addProduct(NO_PRICE)).toBe("priceNotSet");
    expect(store.getSnapshot().lines.map((line) => line.variantId)).toEqual([MILK.variantId]);
    expect(store.getSnapshot().lines[0]).toMatchObject({ displayedPrice: ngn("50000"), priceVersion: 1 });
  });

  it("keeps a reference only on non-cash tenders and cash received only on cash tenders", async () => {
    const { store } = await storeFor(salesApi());
    const [tender] = store.getSnapshot().tenders;
    const rowId = tender?.rowId ?? "";
    store.updateTender(rowId, { cashReceivedText: "1500" });
    store.updateTender(rowId, { method: "POS_CARD", reference: "AUTH-1" });
    expect(store.getSnapshot().tenders[0]).toMatchObject({
      method: "POS_CARD",
      reference: "AUTH-1",
      cashReceivedText: "",
    });
    store.updateTender(rowId, { method: "CASH" });
    expect(store.getSnapshot().tenders[0]).toMatchObject({ method: "CASH", reference: "" });
    for (let index = 0; index < 12; index += 1) store.addTender("CASH");
    expect(store.getSnapshot().tenders).toHaveLength(10);
  });
});

describe("SalesStore: recording a sale (keyed)", () => {
  it("sends only saleId, lines and tenders with Idempotency-Key equal to saleId, then shows the receipt", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    const deferredSale = deferred();
    api.on(SALES, deferredSale.reply);
    const pending = store.submitSale(false);
    await settle();
    const [request] = api.to(SALES);
    const body = request?.body as { saleId: string };
    expect(isUuidV7(body.saleId)).toBe(true);
    expect(request?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(body.saleId);
    expect(body).toEqual({ saleId: body.saleId, ...EXPECTED_PAYLOAD });
    expect(Object.keys(body)).not.toContain("deviceReportedAt");
    expect(store.getSnapshot().checkout.phase).toBe("submitting");
    expect(store.getSnapshot().lines).toHaveLength(1);

    const recorded = saleFixture({ saleId: body.saleId });
    deferredSale.resolve(201, recorded);
    expect(await pending).toMatchObject({ status: "ok" });
    await settle();
    const snapshot = store.getSnapshot();
    expect(snapshot.receipt).toEqual(recorded);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.tenders).toHaveLength(1);
    expect(snapshot.checkout.phase).toBe("editing");
    expect(api.to(LIST).length).toBeGreaterThan(0);
  });

  it("locks the cart after an unknown outcome and resends the same body and key", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    api.on(SALES, networkError, apiError(503, "UNAVAILABLE"), apiError(409, "IDEMPOTENCY_IN_PROGRESS"));
    expect(await store.submitSale(false)).toEqual({ status: "unconfirmed" });
    expect(store.getSnapshot().checkout.phase).toBe("unconfirmed");

    store.updateLine(MILK.variantId, { quantityText: "9" });
    store.addProduct(RICE);
    expect(store.getSnapshot().lines).toHaveLength(1);
    expect(store.getSnapshot().lines[0]?.quantityText).toBe("2");
    expect(await store.submitSale(false)).toEqual({ status: "ignored" });

    expect(await store.resubmitSale()).toEqual({ status: "unconfirmed" });
    expect(await store.resubmitSale()).toEqual({ status: "unconfirmed" });
    const requests = api.to(SALES);
    expect(requests).toHaveLength(3);
    const keys = new Set(requests.map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER)));
    expect(keys.size).toBe(1);
    expect(requests.map((request) => JSON.stringify(request.body))).toEqual(
      Array.from({ length: 3 }, () => JSON.stringify(requests[0]?.body)),
    );
  });

  it("treats an unreadable success as unknown, and a receipt for another sale as unconfirmed", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    api.on(SALES, json(201, { not: "a sale" }), json(201, saleFixture()));
    await store.submitSale(false);
    expect(store.getSnapshot().checkout.phase).toBe("unconfirmed");
    await store.resubmitSale();
    expect(store.getSnapshot().checkout.phase).toBe("unconfirmed");
    expect(store.getSnapshot().receipt).toBeUndefined();
    expect(store.getSnapshot().lines).toHaveLength(1);
  });

  it("discarding an unconfirmed sale keeps the cart, drops the key and reloads Sales history", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    api.on(SALES, networkError, json(201, saleFixture()));
    await store.submitSale(false);
    const historyLoads = api.to(LIST).length;
    store.discardUnconfirmedSale();
    expect(store.getSnapshot().checkout.phase).toBe("editing");
    expect(store.getSnapshot().lines).toHaveLength(1);
    await settle();
    expect(api.to(LIST).length).toBe(historyLoads + 1);
    const [firstKey] = api.to(SALES).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    api.on(SALES, networkError);
    await store.submitSale(false);
    expect(api.to(SALES)[1]?.headers.get(IDEMPOTENCY_KEY_HEADER)).not.toBe(firstKey);
  });

  it("a definite rejection ends the key and keeps the cart", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    api.on(SALES, apiError(409, "LEDGER_NOT_PROVISIONED"));
    expect(await store.submitSale(false)).toMatchObject({ status: "failed" });
    expect(store.getSnapshot().checkout).toMatchObject({
      phase: "editing",
      failure: { code: "LEDGER_NOT_PROVISIONED" },
    });
    expect(store.getSnapshot().lines).toHaveLength(1);
    await store.submitSale(false);
    const [first, second] = api.to(SALES).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(second).not.toBe(first);
  });
});

describe("SalesStore: conflict guidance from the API", () => {
  async function rejectedWith(code: string, details: unknown) {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    store.addProduct(RICE);
    store.updateLine(RICE.variantId, { quantityText: "1.5" });
    api.on(SALES, apiError(409, code, "Rejected", details));
    await store.submitSale(false);
    return store.getSnapshot();
  }

  it("PRICE_CHANGED updates the displayed price and version and requires a new submission", async () => {
    const snapshot = await rejectedWith("PRICE_CHANGED", {
      changes: [{ variantId: MILK.variantId, currentPriceMinor: "55000", currentPriceVersion: 2 }],
    });
    expect(snapshot.lines[0]).toMatchObject({ displayedPrice: ngn("55000"), priceVersion: 2 });
    expect(snapshot.lines[1]).toMatchObject({ priceVersion: 3 });
    expect(snapshot.checkout.lineNotices[MILK.variantId]).toMatch(/price changed/iu);
    expect(snapshot.checkout.phase).toBe("editing");
  });

  it("PRICE_NOT_SET, PRODUCT_ARCHIVED and INSUFFICIENT_STOCK mark their lines", async () => {
    expect((await rejectedWith("PRICE_NOT_SET", { variantIds: [RICE.variantId] })).checkout.lineNotices).toEqual({
      [RICE.variantId]: "Price not set",
    });
    expect((await rejectedWith("PRODUCT_ARCHIVED", { variantIds: [MILK.variantId] })).checkout.lineNotices).toEqual({
      [MILK.variantId]: "This product is no longer available for sale.",
    });
    const stock = await rejectedWith("INSUFFICIENT_STOCK", {
      shortages: [
        { variantId: MILK.variantId, availableQuantityMinor: "1" },
        { variantId: RICE.variantId, availableQuantityMinor: "250" },
      ],
    });
    expect(stock.checkout.lineNotices).toEqual({
      [MILK.variantId]: "Available: 1 PIECE",
      [RICE.variantId]: "Available: 0.250 KG",
    });
  });

  it("DISCOUNT_EXCEEDS_LINE marks the line at lineNumber", async () => {
    const snapshot = await rejectedWith("DISCOUNT_EXCEEDS_LINE", { lineNumber: 2 });
    expect(Object.keys(snapshot.checkout.lineNotices)).toEqual([RICE.variantId]);
  });

  it("TENDER_TOTAL_MISMATCH keeps the cart and shows the server total only", async () => {
    const snapshot = await rejectedWith("TENDER_TOTAL_MISMATCH", { serverTotalMinor: "280000" });
    expect(snapshot.checkout.serverTotal).toEqual(ngn("280000"));
    expect(snapshot.lines).toHaveLength(2);
  });

  it("copies the server total into a single tender without arithmetic", async () => {
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    api.on(SALES, apiError(409, "TENDER_TOTAL_MISMATCH", "Rejected", { serverTotalMinor: "123456" }));
    await store.submitSale(false);
    store.useServerTotal();
    expect(store.getSnapshot().tenders[0]?.amountText).toBe("1234.56");
  });
});

describe("SalesStore: history and reversal", () => {
  it("keeps the API's order across pages without duplicates", async () => {
    const [a, b, c] = [saleFixture(), saleFixture(), saleFixture()];
    const api = salesApi().on(LIST, page([a, b], "c1"), page([b, c]));
    const { store } = await storeFor(api);
    await store.loadHistory();
    await store.loadMoreHistory();
    expect(store.getSnapshot().history.items.map((sale) => sale.saleId)).toEqual([a.saleId, b.saleId, c.saleId]);
    expect(api.to(LIST).at(-1)?.query).toBe("?after=c1");
  });

  it("reverses with its own fresh key and the confirmation, and reuses it after an unknown outcome", async () => {
    const sale = saleFixture();
    const reversed = saleFixture({
      saleId: sale.saleId,
      status: "REVERSED",
      reversedAt: "2026-11-03T09:00:00.000Z",
      reversalTenderUnwoundConfirmed: true,
    });
    const route = `POST ${BASE}/sales/${sale.saleId}/reversal`;
    const api = salesApi()
      .on(LIST, page([sale]))
      .on(route, networkError, json(200, reversed));
    const { store } = await storeFor(api);
    await store.loadHistory();
    store.resetReversal();
    expect(await store.reverseSale(sale.saleId, "Rang up the wrong item")).toEqual({ status: "unconfirmed" });
    expect(store.getSnapshot().reversal).toEqual({ inFlight: false, unconfirmed: true });
    expect(await store.reverseSale(sale.saleId, "Rang up the wrong item")).toMatchObject({ status: "ok" });
    const [first, retry] = api.to(route);
    expect(first?.body).toEqual({ reason: "Rang up the wrong item", tenderUnwoundConfirmed: true });
    expect(retry?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(first?.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(first?.headers.get(IDEMPOTENCY_KEY_HEADER)).not.toBe(sale.saleId);
    expect(store.getSnapshot().history.items[0]?.status).toBe("REVERSED");
  });
});

describe("SalesStore: lifetime and storage", () => {
  it("dispose drops the cart and ignores a late answer; nothing is written to browser storage", async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const api = salesApi();
    const { store } = await storeFor(api);
    fillCart(store);
    const late = deferred();
    api.on(SALES, late.reply);
    const pending = store.submitSale(false);
    await settle();
    const before = store.getSnapshot();
    store.dispose();
    late.resolve(201, saleFixture({ saleId: (api.to(SALES)[0]?.body as { saleId: string }).saleId }));
    expect(await pending).toEqual({ status: "ignored" });
    expect(store.getSnapshot()).toBe(before);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("a new store for another business starts empty", async () => {
    const api = salesApi();
    const { store, session } = await storeFor(api);
    fillCart(store);
    store.dispose();
    const next = new SalesStore({ businessId: BUSINESS_A.id, session, newIdempotencyKey: newUuidV7 });
    expect(next.getSnapshot().lines).toEqual([]);
    expect(next.getSnapshot().receipt).toBeUndefined();
    expect(JSON.stringify(next.getSnapshot())).not.toMatch(/local-test-access-token|saleId/u);
  });

  it("sign-out ends business requests: a later sale is not sent", async () => {
    const api = salesApi();
    const { store, session } = await storeFor(api);
    fillCart(store);
    session.signOut();
    await store.submitSale(false);
    expect(api.to(SALES)).toHaveLength(0);
  });
});
