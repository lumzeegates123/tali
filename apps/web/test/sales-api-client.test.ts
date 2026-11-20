import { describe, expect, it } from "vitest";
import {
  type AccessToken,
  type ApiResult,
  IDEMPOTENCY_KEY_HEADER,
  TaliApiClient,
} from "../src/lib/api-client/tali-api-client";
import { describeFailure } from "../src/lib/api-client/failure-messages";
import { BUSINESS_ID } from "./support/catalog-fixtures";
import { jsonFetch } from "./support/fake-fetch";
import { itemFixture } from "./support/inventory-fixtures";
import { accountBalance, ledgerAccount, saleFixture, salesId } from "./support/sales-fixtures";

const TOKEN = "sales-test-access" as AccessToken;
const BASE = `http://api.test/v1/businesses/${BUSINESS_ID}`;
const SALE_ID = salesId();
const VARIANT = salesId();
const KEY = "0190a000-0000-7000-8000-0000000000ab";
const COMMAND = {
  saleId: SALE_ID,
  lines: [{ variantId: VARIANT, quantity: { quantityMinor: "2", unit: "PIECE" }, expectedPriceVersion: 1 }],
  tenders: [{ method: "CASH" as const, amount: { amountMinor: "100000", currency: "NGN" } }],
};

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

interface RouteCase {
  readonly name: string;
  readonly status: number;
  readonly body: unknown;
  readonly call: (api: TaliApiClient) => Promise<ApiResult<unknown>>;
  readonly method: string;
  readonly url: string;
  readonly sentBody?: unknown;
  readonly key?: string;
}

const sale = saleFixture({ saleId: SALE_ID });

const ROUTES: readonly RouteCase[] = [
  {
    name: "record sale (Idempotency-Key is the saleId)",
    status: 201,
    body: sale,
    call: (api) => api.recordSale(TOKEN, BUSINESS_ID, COMMAND),
    method: "POST",
    url: `${BASE}/sales`,
    sentBody: COMMAND,
    key: SALE_ID,
  },
  {
    name: "list sales",
    status: 200,
    body: { items: [sale], nextCursor: "c2" },
    call: (api) => api.listSales(TOKEN, BUSINESS_ID, { limit: 20, after: "c1" }),
    method: "GET",
    url: `${BASE}/sales?limit=20&after=c1`,
  },
  {
    name: "get sale",
    status: 200,
    body: sale,
    call: (api) => api.getSale(TOKEN, BUSINESS_ID, SALE_ID),
    method: "GET",
    url: `${BASE}/sales/${SALE_ID}`,
  },
  {
    name: "reverse sale (its own key)",
    status: 200,
    body: saleFixture({
      saleId: SALE_ID,
      status: "REVERSED",
      reversedAt: "2026-11-03T09:00:00.000Z",
      reversalTenderUnwoundConfirmed: true,
    }),
    call: (api) =>
      api.reverseSale(TOKEN, BUSINESS_ID, SALE_ID, { reason: "Wrong item", tenderUnwoundConfirmed: true }, KEY),
    method: "POST",
    url: `${BASE}/sales/${SALE_ID}/reversal`,
    sentBody: { reason: "Wrong item", tenderUnwoundConfirmed: true },
    key: KEY,
  },
  {
    name: "ledger accounts",
    status: 200,
    body: { items: [ledgerAccount()] },
    call: (api) => api.listLedgerAccounts(TOKEN, BUSINESS_ID),
    method: "GET",
    url: `${BASE}/ledger/accounts`,
  },
  {
    name: "ledger balances",
    status: 200,
    body: { items: [accountBalance()] },
    call: (api) => api.listAccountBalances(TOKEN, BUSINESS_ID),
    method: "GET",
    url: `${BASE}/ledger/balances`,
  },
  {
    name: "record stock valuation",
    status: 201,
    body: { valuationId: salesId(), kind: "INITIAL_OPENING" },
    call: (api) =>
      api.recordStockValuation(
        TOKEN,
        BUSINESS_ID,
        {
          variantId: VARIANT,
          expectedBalanceVersion: 3,
          newTotalValue: { amountMinor: "0", currency: "NGN" },
          reason: "Opening count",
        },
        KEY,
      ),
    method: "POST",
    url: `${BASE}/inventory/valuations`,
    sentBody: {
      variantId: VARIANT,
      expectedBalanceVersion: 3,
      newTotalValue: { amountMinor: "0", currency: "NGN" },
      reason: "Opening count",
    },
    key: KEY,
  },
  {
    name: "needs valuation",
    status: 200,
    body: { items: [itemFixture({ valuationStatus: "UNVALUED" })], nextCursor: null },
    call: (api) => api.listInventoryItems(TOKEN, BUSINESS_ID, { needsValuation: true, limit: 1 }),
    method: "GET",
    url: `${BASE}/inventory/balances?limit=1&needsValuation=true`,
  },
];

describe("TaliApiClient: sales, ledger and valuation routes", () => {
  for (const route of ROUTES) {
    it(`${route.name}: sends the contract request and validates the response`, async () => {
      const double = jsonFetch(route.status, route.body);
      const result = await route.call(client(double.fetch));
      expect(result).toMatchObject({ ok: true, status: route.status, value: route.body });
      const request = sent(double);
      expect(request).toMatchObject({ url: route.url, method: route.method, authorization: `Bearer ${TOKEN}` });
      expect(request.idempotencyKey).toBe(route.key ?? null);
      if (route.sentBody !== undefined) expect(request.body).toEqual(route.sentBody);
    });

    it(`${route.name}: a response outside the contract is an invalid response`, async () => {
      const result = await route.call(client(jsonFetch(route.status, { unexpected: true }).fetch));
      expect(result).toEqual({
        ok: false,
        failure: { kind: "invalid-response", status: route.status, correlationId: undefined },
      });
    });
  }

  it("treats a wrong success status as an invalid response", async () => {
    const result = await client(jsonFetch(200, sale).fetch).recordSale(TOKEN, BUSINESS_ID, COMMAND);
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-response", status: 200 } });
  });

  it("keeps the API's sales order and never adds a journal browser route", () => {
    const methods = Object.getOwnPropertyNames(TaliApiClient.prototype);
    expect(methods).toEqual(expect.arrayContaining(["getJournalEntry", "listLedgerAccounts", "listAccountBalances"]));
    expect(methods.some((name) => /listJournal|postJournal|createJournal|recordJournal/u.test(name))).toBe(false);
  });
});

const envelope = (code: string, details?: unknown) => ({
  error: { code, message: "Rejected", ...(details === undefined ? {} : { details }) },
});

const CONFLICTS: readonly { readonly code: string; readonly details: unknown }[] = [
  { code: "PRICE_NOT_SET", details: { variantIds: [VARIANT] } },
  {
    code: "PRICE_CHANGED",
    details: { changes: [{ variantId: VARIANT, currentPriceMinor: "55000", currentPriceVersion: 2 }] },
  },
  { code: "PRODUCT_ARCHIVED", details: { variantIds: [VARIANT] } },
  { code: "INSUFFICIENT_STOCK", details: { shortages: [{ variantId: VARIANT, availableQuantityMinor: "1" }] } },
  { code: "DISCOUNT_EXCEEDS_LINE", details: { lineNumber: 1 } },
  { code: "TENDER_TOTAL_MISMATCH", details: { serverTotalMinor: "100000" } },
];

describe("TaliApiClient: sales conflict details", () => {
  for (const { code, details } of CONFLICTS) {
    it(`${code}: keeps exactly the strict details`, async () => {
      const result = await client(jsonFetch(409, envelope(code, details)).fetch).recordSale(
        TOKEN,
        BUSINESS_ID,
        COMMAND,
      );
      expect(result).toEqual({
        ok: false,
        failure: {
          kind: "api-error",
          status: 409,
          code,
          message: "Rejected",
          correlationId: undefined,
          fields: [],
          sales: { code, details },
        },
      });
    });

    it(`${code}: a malformed specialized envelope fails closed as an invalid response`, async () => {
      const result = await client(
        jsonFetch(409, envelope(code, { unexpected: "x", secret: "tender reference" })).fetch,
      ).recordSale(TOKEN, BUSINESS_ID, COMMAND);
      expect(result).toEqual({
        ok: false,
        failure: { kind: "invalid-response", status: 409, correlationId: undefined },
      });
    });
  }

  it("keeps INSUFFICIENT_STOCK without details (an inventory request) as an ordinary API error", async () => {
    const result = await client(jsonFetch(409, envelope("INSUFFICIENT_STOCK")).fetch).getSale(
      TOKEN,
      BUSINESS_ID,
      SALE_ID,
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "api-error", code: "INSUFFICIENT_STOCK" } });
    expect(result.ok ? undefined : result.failure).not.toHaveProperty("sales");
  });

  it("never stores arbitrary details of other codes", async () => {
    const result = await client(jsonFetch(409, envelope("CONFLICT", { reference: "TRF-1" })).fetch).getSale(
      TOKEN,
      BUSINESS_ID,
      SALE_ID,
    );
    expect(JSON.stringify(result)).not.toContain("TRF-1");
  });

  it("gives plain-language text for the sales and valuation codes", () => {
    const text = (code: string) =>
      describeFailure({ kind: "api-error", status: 409, code, message: "x", correlationId: undefined, fields: [] })
        .text;
    expect(text("PRICE_NOT_SET")).toMatch(/^Price not set/u);
    expect(text("PRODUCT_ARCHIVED")).toBe("This product is no longer available for sale.");
    expect(text("LEDGER_NOT_PROVISIONED")).toBe("This business is not ready to record sales yet.");
    expect(text("VALUATION_STALE")).toBe(
      "Stock changed since this valuation was reviewed. Reload the item and enter the value again.",
    );
    for (const code of ["PRICE_CHANGED", "DISCOUNT_EXCEEDS_LINE", "TENDER_TOTAL_MISMATCH"]) {
      expect(text(code)).not.toBe(text("SOME_UNKNOWN_CODE"));
    }
  });
});
