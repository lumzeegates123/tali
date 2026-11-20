import type * as NodeCrypto from "node:crypto";
import type { MobilePublicConfig } from "@tali/config/public";
import {
  DEVICE_CREDENTIAL_HEADER,
  DEVICE_ID_HEADER,
  type InventoryItemResponse,
  type ProductResponse,
  type SaleResponse,
} from "@tali/shared";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { IDEMPOTENCY_KEY_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { SessionProvider } from "../src/auth/session-context";
import { SessionStore } from "../src/auth/session-store";
import type { DeviceCredentialStore, DeviceRegistration } from "../src/devices/device-credential-store";
import { installSecureRandom } from "../src/ids/secure-random";
import { newUuidV7 } from "../src/ids/uuidv7";
import { VALUATION_INCOMPLETE, VALUATION_UNCHECKED } from "../src/ledger/ledger-screen";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { TENDER_UNWOUND_CONFIRMATION, UNCONFIRMED_REVERSAL } from "../src/sales/sales-history-screen";
import { CHANGE_NOTE, FINAL_TOTAL_NOTE, UNCONFIRMED_SALE } from "../src/sales/sell-screen";
import { NGN, productFixture, UNITS } from "./support/catalog-fixtures";
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
import { itemFixture } from "./support/inventory-fixtures";
import { accountBalance, costedSale, ledgerAccount, saleFixture } from "./support/sales-fixtures";

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

jest.setTimeout(30_000);

const LOCAL: MobilePublicConfig = { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" };
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const SALES = `${BASE}/sales`;
const BALANCES = `${BASE}/inventory/balances`;
const DEVICE_ID = "0191a1b2-0000-7000-8000-0000000000d1";
const CREDENTIAL = "device-fixture-credential";
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });
const ngn = (amountMinor: string) => ({ amountMinor, currency: "NGN" });
const MILK: ProductResponse = productFixture({ name: "Peak Milk 400g", sellingPrice: ngn("50000"), priceVersion: 1 });
const reversedOf = (sale: SaleResponse): SaleResponse => ({
  ...sale,
  status: "REVERSED",
  reversedAt: sale.recordedAt,
  reversalTenderUnwoundConfirmed: true,
});
const originalFetch = globalThis.fetch;

beforeAll(() => {
  installSecureRandom();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
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

/**
 * A fake API for one role. `GET .../inventory/balances?needsValuation=true`
 * answers from `needsValuation`, so the valuation list and the ledger's
 * completeness check are independent of the stock list.
 */
function salesApi(role: string, needsValuation: readonly InventoryItemResponse[] | "fail" = []) {
  const api = registeredUserApi()
    .on(
      "GET /v1/me/businesses",
      json(200, { items: [{ business: BUSINESS_A, membership: { ...MEMBERSHIP_A, role } }], nextCursor: null }),
    )
    .on(`GET ${BASE}/currency`, json(200, NGN))
    .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
    .on(`GET ${BASE}/products`, page([MILK]))
    .on(`GET ${SALES}`, page([]))
    .on(`GET ${BALANCES}`, page([]))
    .on(`GET ${BASE}/inventory/stocktakes`, page([]))
    .on(`GET ${BASE}/ledger/accounts`, json(200, { items: [ledgerAccount()] }))
    .on(`GET ${BASE}/ledger/balances`, json(200, { items: [accountBalance()] }));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.href);
    if (url.search.includes("needsValuation=true")) {
      api.requests.push({
        method: "GET",
        path: url.pathname,
        query: url.search,
        headers: new Headers(init?.headers),
        body: undefined,
      });
      if (needsValuation === "fail") throw new TypeError("Network request failed");
      return new Response(JSON.stringify({ items: needsValuation, nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return api.fetch(input, init);
  };
  return { api, fetch };
}

/** An Android-style session whose business A device registration lives in memory only. */
async function openBusiness(harness: { readonly fetch: typeof globalThis.fetch }): Promise<SessionStore> {
  globalThis.fetch = harness.fetch;
  const session = new SessionStore({
    api: new TaliApiClient({ baseUrl: LOCAL.apiBaseUrl, createCorrelationId: () => "c-1", fetch: harness.fetch }),
    newIdempotencyKey: newUuidV7,
    deviceRegistrationSupported: true,
    deviceStore: memoryDeviceStore({ deviceId: DEVICE_ID, credential: CREDENTIAL }),
  });
  await render(
    <SessionProvider store={session}>
      <OnboardingApp config={LOCAL} />
    </SessionProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
  await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
  await fireEvent.press(await screen.findByRole("button", { name: `Open ${BUSINESS_A.name}` }));
  await screen.findByLabelText("Business sections");
  await settle();
  return session;
}

function sectionTabs(): string[] {
  return within(screen.getByLabelText("Business sections"))
    .getAllByRole("tab")
    .map((tab) => tab.props["accessibilityLabel"] as string);
}

async function openSection(name: string) {
  await fireEvent.press(within(screen.getByLabelText("Business sections")).getByRole("tab", { name }));
  await settle();
}

async function openSalesTab(name: "Sell" | "Sales") {
  await fireEvent.press(within(screen.getByLabelText("Sales sections")).getByRole("tab", { name }));
  await settle();
}

async function press(name: string | RegExp) {
  await fireEvent.press(await screen.findByRole("button", { name }));
  await settle();
}

async function cartOfTwoMilk() {
  await fireEvent.changeText(screen.getByLabelText("Find a product"), "milk");
  await press("Search");
  await press(`Add ${MILK.name}`);
  await fireEvent.changeText(screen.getByLabelText(`Quantity of ${MILK.name} (PIECE)`), "2");
  await fireEvent.changeText(screen.getByLabelText("Amount of tender 1 (NGN)"), "1000");
  await fireEvent.changeText(screen.getByLabelText("Cash received for tender 1 (NGN, optional)"), "1500");
}

function expectDeviceHeaders(api: FakeTaliApi, route: string) {
  const requests = api.to(route);
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
    expect(request.headers.get(DEVICE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  }
}

describe("mobile sales and ledger navigation (UX only; the API is authoritative)", () => {
  it.each([
    ["OWNER", true, true],
    ["MANAGER", true, false],
    ["CASHIER", true, false],
    ["ACCOUNTANT", true, true],
    ["STOCK_KEEPER", false, false],
  ])("%s: Sales tab %s, Ledger tab %s", async (role, sales, ledger) => {
    await openBusiness(salesApi(role));
    expect(sectionTabs().includes("Sales")).toBe(sales);
    expect(sectionTabs().includes("Ledger")).toBe(ledger);
  });

  it("gives the accountant the Sales history only, with no Sell tab", async () => {
    await openBusiness(salesApi("ACCOUNTANT"));
    await openSection("Sales");
    const tabs = within(screen.getByLabelText("Sales sections")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.props["accessibilityLabel"] as string)).toEqual(["Sales"]);
    expect(screen.queryByLabelText("Find a product")).toBeNull();
  });
});

describe("mobile selling", () => {
  it("records a keyed sale with device headers and shows the server receipt", async () => {
    const harness = salesApi("OWNER");
    const inner = harness.fetch;
    harness.fetch = async (input, init) => {
      if (init?.method === "POST") {
        const key = new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER) ?? "";
        harness.api.on(`POST ${SALES}`, json(201, saleFixture({ saleId: key, receiptNumber: "R-000009" })));
      }
      return inner(input, init);
    };
    await openBusiness(harness);
    await openSection("Sales");
    expect(screen.getByText(FINAL_TOTAL_NOTE)).toBeTruthy();
    expect(screen.getByText(CHANGE_NOTE)).toBeTruthy();
    await cartOfTwoMilk();
    await press("Record sale");
    const [request] = harness.api.to(`POST ${SALES}`);
    expect(Object.keys(request?.body as object).sort()).toEqual(["lines", "saleId", "tenders"]);
    expect(request?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe((request?.body as { saleId: string }).saleId);
    expectDeviceHeaders(harness.api, `POST ${SALES}`);
    expectDeviceHeaders(harness.api, `GET ${BASE}/products`);
    expect(await screen.findByText("Sale recorded.")).toBeTruthy();
    expect(screen.getByText(/R-000009/u)).toBeTruthy();
  });

  it("locks the cart on an unknown outcome and resends the same key and body", async () => {
    const harness = salesApi("CASHIER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    harness.api.on(`POST ${SALES}`, networkError);
    await press("Record sale");
    expect(screen.getByText(UNCONFIRMED_SALE)).toBeTruthy();
    expect(screen.getByLabelText(`Quantity of ${MILK.name} (PIECE)`).props["editable"] as unknown).toBe(false);
    const [first] = harness.api.to(`POST ${SALES}`);
    const key = first?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    harness.api.on(`POST ${SALES}`, json(201, saleFixture({ saleId: key })));
    await press("Submit again with same details");
    const [, second] = harness.api.to(`POST ${SALES}`);
    expect(second?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(key);
    expect(second?.body).toEqual(first?.body);
    expectDeviceHeaders(harness.api, `POST ${SALES}`);
    expect(await screen.findByText("Sale recorded.")).toBeTruthy();
  });

  it("shows the server total on a tender mismatch and keeps the cart", async () => {
    const harness = salesApi("OWNER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    harness.api.on(`POST ${SALES}`, apiError(409, "TENDER_TOTAL_MISMATCH", "x", { serverTotalMinor: "123456" }));
    await press("Record sale");
    expect(screen.getByText(/^Server total: 1,234\.56 NGN$/u)).toBeTruthy();
    await press("Use the server total as the tender amount");
    expect(screen.getByLabelText("Amount of tender 1 (NGN)").props["value"] as unknown).toBe("1234.56");
  });

  it("drops the cart when the section is left", async () => {
    await openBusiness(salesApi("OWNER"));
    await openSection("Sales");
    await cartOfTwoMilk();
    await openSection("Overview");
    await openSection("Sales");
    expect(screen.getByText("The cart is empty.")).toBeTruthy();
  });
});

describe("mobile sale detail and reversal", () => {
  function withSale(role: string, sale: SaleResponse = costedSale("VALUED", { receiptNumber: "R-000003" })) {
    const harness = salesApi(role);
    harness.api.on(`GET ${SALES}`, page([sale])).on(`GET ${SALES}/${sale.saleId}`, json(200, sale));
    return { harness, sale };
  }

  it("reverses only after the tender confirmation, keyed, with device headers", async () => {
    const { harness, sale } = withSale("OWNER");
    harness.api.on(`POST ${SALES}/${sale.saleId}/reversal`, networkError);
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await press("Open sale R-000003");
    await fireEvent.changeText(screen.getByLabelText("Reason for the correction"), "Rang up the wrong item");
    await press("Reverse sale");
    expect(screen.getByText("Error: Confirm that the original tender has been returned or unwound.")).toBeTruthy();
    expect(harness.api.to(`POST ${SALES}/${sale.saleId}/reversal`)).toHaveLength(0);
    await fireEvent.press(screen.getByRole("checkbox", { name: TENDER_UNWOUND_CONFIRMATION }));
    await press("Reverse sale");
    expect(screen.getByText(UNCONFIRMED_REVERSAL)).toBeTruthy();
    harness.api.on(`POST ${SALES}/${sale.saleId}/reversal`, json(200, reversedOf(sale)));
    await press("Submit again with same details");
    const [first, second] = harness.api.to(`POST ${SALES}/${sale.saleId}/reversal`);
    expect(first?.body).toEqual({ reason: "Rang up the wrong item", tenderUnwoundConfirmed: true });
    expect(second?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(first?.headers.get(IDEMPOTENCY_KEY_HEADER));
    expectDeviceHeaders(harness.api, `POST ${SALES}/${sale.saleId}/reversal`);
    expect(await screen.findByText("Sale reversed.")).toBeTruthy();
  });

  it("a cashier sees the sale but no reversal", async () => {
    const { harness } = withSale("CASHIER", saleFixture({ receiptNumber: "R-000003" }));
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await press("Open sale R-000003");
    expect(screen.queryByLabelText("Reason for the correction")).toBeNull();
  });

  it("discloses unknown cost and incomplete margin without computing one", async () => {
    const { harness } = withSale("OWNER", costedSale("PARTIAL", { receiptNumber: "R-000003" }));
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await press("Open sale R-000003");
    expect(screen.getByText("Margin incomplete")).toBeTruthy();
    expect(screen.getByText("Some item costs are unknown.")).toBeTruthy();
    expect(screen.queryByText(/Margin:/u)).toBeNull();
  });
});

describe("mobile ledger (read only)", () => {
  it("shows accounts, balances and the incomplete-valuation notice, with device headers", async () => {
    const harness = salesApi("ACCOUNTANT", [itemFixture({ valuationStatus: "UNVALUED" })]);
    await openBusiness(harness);
    await openSection("Ledger");
    expect(screen.getByLabelText("Account 1000")).toBeTruthy();
    expect(screen.getByLabelText("Balance 1000")).toBeTruthy();
    expect(screen.getByText(VALUATION_INCOMPLETE)).toBeTruthy();
    expectDeviceHeaders(harness.api, `GET ${BASE}/ledger/accounts`);
    expectDeviceHeaders(harness.api, `GET ${BASE}/ledger/balances`);
    const probe = harness.api.requests.find((request) => request.query.includes("needsValuation=true"));
    expect(probe?.query).toBe("?limit=1&needsValuation=true");
    expect(probe?.headers.get(DEVICE_ID_HEADER)).toBe(DEVICE_ID);
  });

  it("says when completeness could not be checked", async () => {
    await openBusiness(salesApi("OWNER", "fail"));
    await openSection("Ledger");
    expect(screen.getByText(VALUATION_UNCHECKED)).toBeTruthy();
  });
});

describe("mobile needs valuation", () => {
  const UNVALUED = itemFixture({ name: "Rice 1kg", valuationStatus: "UNVALUED", balanceVersion: 4 });

  async function openNeedsValuation(role: string) {
    const harness = salesApi(role, [UNVALUED]);
    harness.api.on(`GET ${BASE}/inventory/items/${UNVALUED.variantId}`, json(200, UNVALUED));
    await openBusiness(harness);
    await openSection("Inventory");
    await fireEvent.press(screen.getByRole("tab", { name: "Needs valuation" }));
    await settle();
    return harness;
  }

  it("records an opening valuation with the balance version, a key and device headers", async () => {
    const harness = await openNeedsValuation("OWNER");
    expect(within(screen.getByLabelText(`Needs valuation ${UNVALUED.name}`)).getByText("Cost unknown")).toBeTruthy();
    harness.api.on(
      `POST ${BASE}/inventory/valuations`,
      json(201, { valuationId: UNVALUED.variantId, kind: "INITIAL_OPENING" }),
    );
    await press(`Value stock of ${UNVALUED.name}`);
    await fireEvent.changeText(screen.getByLabelText("Total value (NGN)"), "0");
    await fireEvent.changeText(screen.getByLabelText("Reason"), "Opening count");
    await press("Record valuation");
    const [request] = harness.api.to(`POST ${BASE}/inventory/valuations`);
    expect(request?.body).toEqual({
      variantId: UNVALUED.variantId,
      expectedBalanceVersion: 4,
      newTotalValue: ngn("0"),
      reason: "Opening count",
    });
    expect(request?.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expectDeviceHeaders(harness.api, `POST ${BASE}/inventory/valuations`);
    expect(await screen.findByText("Opening valuation recorded.")).toBeTruthy();
  });

  it("lets the accountant see the list but not value stock", async () => {
    await openNeedsValuation("ACCOUNTANT");
    expect(screen.getByText("Rice 1kg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Value stock of/u })).toBeNull();
  });

  it("gives a cashier no Needs valuation tab", async () => {
    await openBusiness(salesApi("CASHIER"));
    await openSection("Inventory");
    expect(screen.queryByRole("tab", { name: "Needs valuation" })).toBeNull();
  });
});
