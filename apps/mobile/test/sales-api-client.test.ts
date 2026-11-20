import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER } from "@tali/shared";
import { type AccessToken, type ApiResult, IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { describeFailure } from "../src/api/failure-messages";
import { inventoryAffordances } from "../src/inventory/affordances";
import { salesAffordances } from "../src/sales/affordances";
import { BUSINESS_ID } from "./support/catalog-fixtures";
import { jsonFetch } from "./support/fake-fetch";
import { itemFixture } from "./support/inventory-fixtures";
import { accountBalance, ledgerAccount, saleFixture, salesId } from "./support/sales-fixtures";

const TOKEN = "sales-test-access" as AccessToken;
const KEY = "0190a000-0000-7000-8000-0000000000ab";
const DEVICE = { deviceId: "0190a000-0000-7000-8000-0000000000dd", credential: "device-fixture-value" };
const BASE = `http://api.test/v1/businesses/${BUSINESS_ID}`;
const SALE_ID = salesId();
const VARIANT = salesId();

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
    idempotencyKey: headers.get(IDEMPOTENCY_KEY_HEADER),
    deviceId: headers.get(DEVICE_ID_HEADER),
    deviceCredential: headers.get(DEVICE_CREDENTIAL_HEADER),
    body: typeof body === "string" ? (JSON.parse(body) as unknown) : undefined,
  };
}

const SALE_COMMAND = {
  saleId: SALE_ID,
  lines: [{ variantId: VARIANT, quantity: { quantityMinor: "2", unit: "PIECE" }, expectedPriceVersion: 1 }],
  tenders: [{ method: "CASH" as const, amount: { amountMinor: "100000", currency: "NGN" } }],
};

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

const ROUTES: readonly RouteCase[] = [
  {
    name: "record sale",
    status: 201,
    body: saleFixture({ saleId: SALE_ID }),
    call: (api) => api.recordSale(TOKEN, BUSINESS_ID, SALE_COMMAND, DEVICE),
    method: "POST",
    url: `${BASE}/sales`,
    sentBody: SALE_COMMAND,
    key: SALE_ID,
  },
  {
    name: "list sales",
    status: 200,
    body: { items: [saleFixture()], nextCursor: null },
    call: (api) => api.listSales(TOKEN, BUSINESS_ID, { limit: 20, after: "c1" }, DEVICE),
    method: "GET",
    url: `${BASE}/sales?limit=20&after=c1`,
  },
  {
    name: "get sale",
    status: 200,
    body: saleFixture({ saleId: SALE_ID }),
    call: (api) => api.getSale(TOKEN, BUSINESS_ID, SALE_ID, DEVICE),
    method: "GET",
    url: `${BASE}/sales/${SALE_ID}`,
  },
  {
    name: "reverse sale",
    status: 200,
    body: saleFixture({
      saleId: SALE_ID,
      status: "REVERSED",
      reversedAt: "2026-11-03T09:00:00.000Z",
      reversalTenderUnwoundConfirmed: true,
    }),
    call: (api) =>
      api.reverseSale(TOKEN, BUSINESS_ID, SALE_ID, { reason: "Wrong item", tenderUnwoundConfirmed: true }, KEY, DEVICE),
    method: "POST",
    url: `${BASE}/sales/${SALE_ID}/reversal`,
    sentBody: { reason: "Wrong item", tenderUnwoundConfirmed: true },
    key: KEY,
  },
  {
    name: "ledger accounts",
    status: 200,
    body: { items: [ledgerAccount()] },
    call: (api) => api.listLedgerAccounts(TOKEN, BUSINESS_ID, DEVICE),
    method: "GET",
    url: `${BASE}/ledger/accounts`,
  },
  {
    name: "ledger balances",
    status: 200,
    body: { items: [accountBalance()] },
    call: (api) => api.listAccountBalances(TOKEN, BUSINESS_ID, DEVICE),
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
        DEVICE,
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
    call: (api) => api.listInventoryItems(TOKEN, BUSINESS_ID, { needsValuation: true, limit: 1 }, DEVICE),
    method: "GET",
    url: `${BASE}/inventory/balances?limit=1&needsValuation=true`,
  },
];

describe("mobile TaliApiClient: sales, ledger and valuation routes", () => {
  for (const route of ROUTES) {
    it(`${route.name}: sends the contract request with this business's device headers`, async () => {
      const double = jsonFetch(route.status, route.body);
      const result = await route.call(client(double.fetch));
      expect(result.ok).toBe(true);
      const request = sent(double);
      expect(request.url).toBe(route.url);
      expect(request.method).toBe(route.method);
      expect(request.deviceId).toBe(DEVICE.deviceId);
      expect(request.deviceCredential).toBe(DEVICE.credential);
      expect(request.idempotencyKey).toBe(route.key ?? null);
      if (route.sentBody !== undefined) expect(request.body).toEqual(route.sentBody);
    });

    it(`${route.name}: rejects a response that does not match the contract`, async () => {
      const result = await route.call(client(jsonFetch(route.status, { unexpected: true }).fetch));
      expect(result.ok ? undefined : result.failure.kind).toBe("invalid-response");
    });
  }

  it("parses sales conflict details only when they match the contract", async () => {
    const valid = await client(
      jsonFetch(409, { error: { code: "TENDER_TOTAL_MISMATCH", message: "x", details: { serverTotalMinor: "12" } } })
        .fetch,
    ).recordSale(TOKEN, BUSINESS_ID, SALE_COMMAND, DEVICE);
    expect(!valid.ok && valid.failure.kind === "api-error" ? valid.failure.sales : undefined).toEqual({
      code: "TENDER_TOTAL_MISMATCH",
      details: { serverTotalMinor: "12" },
    });
    const malformed = await client(
      jsonFetch(409, { error: { code: "TENDER_TOTAL_MISMATCH", message: "x", details: { total: 12 } } }).fetch,
    ).recordSale(TOKEN, BUSINESS_ID, SALE_COMMAND, DEVICE);
    expect(malformed.ok ? undefined : malformed.failure.kind).toBe("invalid-response");
  });

  it("gives plain-language text for the sales and valuation codes", () => {
    const text = (code: string) =>
      describeFailure({ kind: "api-error", status: 409, code, message: "x", correlationId: undefined, fields: [] })
        .text;
    expect(text("PRODUCT_ARCHIVED")).toBe("This product is no longer available for sale.");
    expect(text("LEDGER_NOT_PROVISIONED")).toBe("This business is not ready to record sales yet.");
    expect(text("VALUATION_STALE")).toBe(
      "Stock changed since this valuation was reviewed. Reload the item and enter the value again.",
    );
  });
});

/** Affordances shape the UI only; the API authorizes every request. */
describe("mobile sales, ledger and valuation affordances (UX only)", () => {
  it.each([
    ["OWNER", { salesVisible: true, readAll: true, create: true, discount: true, reverse: true, ledger: true }],
    ["MANAGER", { salesVisible: true, readAll: true, create: true, discount: true, reverse: true, ledger: false }],
    ["CASHIER", { salesVisible: true, readAll: false, create: true, discount: false, reverse: false, ledger: false }],
    ["ACCOUNTANT", { salesVisible: true, readAll: true, create: false, discount: false, reverse: false, ledger: true }],
    [
      "STOCK_KEEPER",
      { salesVisible: false, readAll: false, create: false, discount: false, reverse: false, ledger: false },
    ],
    [
      "__proto__",
      { salesVisible: false, readAll: false, create: false, discount: false, reverse: false, ledger: false },
    ],
  ])("%s", (role, expected) => {
    expect(salesAffordances(role)).toEqual(expected);
    expect(Object.isFrozen(salesAffordances(role))).toBe(true);
  });

  it("gives inventory:value to OWNER and MANAGER and inventory:cost-read also to ACCOUNTANT", () => {
    const can = (role: string, permission: "inventory:value" | "inventory:cost-read") =>
      inventoryAffordances(role).can(permission);
    expect(
      ["OWNER", "MANAGER", "CASHIER", "ACCOUNTANT", "STOCK_KEEPER"].filter((role) => can(role, "inventory:value")),
    ).toEqual(["OWNER", "MANAGER"]);
    expect(
      ["OWNER", "MANAGER", "CASHIER", "ACCOUNTANT", "STOCK_KEEPER"].filter((role) => can(role, "inventory:cost-read")),
    ).toEqual(["OWNER", "MANAGER", "ACCOUNTANT"]);
  });
});
