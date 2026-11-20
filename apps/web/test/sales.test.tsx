import type { WebPublicConfig } from "@tali/config/public";
import type { InventoryItemResponse, ProductResponse, SaleResponse } from "@tali/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VALUATION_STALE_TEXT } from "../src/inventory/valuation-form";
import { VALUATION_INCOMPLETE, VALUATION_UNCHECKED } from "../src/ledger/ledger-section";
import { IDEMPOTENCY_KEY_HEADER } from "../src/lib/api-client/tali-api-client";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { TENDER_UNWOUND_CONFIRMATION, UNCONFIRMED_REVERSAL } from "../src/sales/sales-history";
import { CHANGE_NOTE, FINAL_TOTAL_NOTE, UNCONFIRMED_SALE } from "../src/sales/sell-view";
import { NGN, productFixture, UNITS } from "./support/catalog-fixtures";
import {
  apiError,
  BUSINESS_A,
  json,
  MEMBERSHIP_A,
  networkError,
  registeredUserApi,
  settle,
} from "./support/fake-tali-api";
import { itemFixture } from "./support/inventory-fixtures";
import { accountBalance, cashTender, costedSale, ledgerAccount, saleFixture } from "./support/sales-fixtures";

const LOCAL: WebPublicConfig = { env: "local", apiBaseUrl: "http://api.test", authMode: "local" };
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const SALES = `${BASE}/sales`;
const BALANCES = `${BASE}/inventory/balances`;
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });
const ngn = (amountMinor: string) => ({ amountMinor, currency: "NGN" });

const reversedOf = (sale: SaleResponse): SaleResponse => ({
  ...sale,
  status: "REVERSED",
  reversedAt: sale.recordedAt,
  reversalTenderUnwoundConfirmed: true,
});

const MILK: ProductResponse = productFixture({ name: "Peak Milk 400g", sellingPrice: ngn("50000"), priceVersion: 1 });

/**
 * A fake API for one role. `GET .../inventory/balances?needsValuation=true`
 * answers from `needsValuation` so the valuation list and the ledger's
 * completeness check are independent of the normal stock list.
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
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    if (url.includes("needsValuation=true")) {
      api.requests.push({
        method: "GET",
        path: new URL(url).pathname,
        query: new URL(url).search,
        headers: new Headers(init?.headers),
        body: undefined,
      });
      if (needsValuation === "fail") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ items: needsValuation, nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return api.fetch(input, init);
  };
  return { api, fetch };
}

async function openBusiness({ fetch }: { readonly fetch: typeof globalThis.fetch }) {
  vi.stubGlobal("fetch", fetch);
  render(<OnboardingAppUnderTest />);
  fireEvent.change(screen.getByLabelText("Local subject"), { target: { value: "local-user-ada" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in (local development)" }));
  fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
  await screen.findByRole("navigation", { name: "Business sections" });
  await act(settle);
}

function OnboardingAppUnderTest() {
  return <OnboardingApp config={LOCAL} invitationLink={false} />;
}

function sectionButtons(): string[] {
  const nav = screen.getByRole("navigation", { name: "Business sections" });
  return within(nav)
    .getAllByRole("button")
    .map((button) => button.textContent);
}

async function openSection(name: string) {
  const nav = screen.getByRole("navigation", { name: "Business sections" });
  fireEvent.click(within(nav).getByRole("button", { name }));
  await act(settle);
}

async function openSalesTab(name: "Sell" | "Sales") {
  const nav = screen.getByRole("navigation", { name: "Sales sections" });
  fireEvent.click(within(nav).getByRole("button", { name }));
  await act(settle);
}

async function click(name: string | RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
  await act(settle);
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function cartOfTwoMilk() {
  type("Find a product", "milk");
  await click("Search");
  await click(`Add ${MILK.name}`);
  type("Quantity (PIECE)", "2");
  type("Amount (NGN)", "1000");
  type("Cash received (NGN, optional)", "1500");
}

function expectNothingPersisted() {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
  expect(document.cookie).toBe("");
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sales and ledger navigation (UX only; the API is authoritative)", () => {
  it.each([
    ["OWNER", true, true],
    ["MANAGER", true, false],
    ["CASHIER", true, false],
    ["ACCOUNTANT", true, true],
    ["STOCK_KEEPER", false, false],
  ])("%s: Sales shown %s, Ledger shown %s", async (role, sales, ledger) => {
    await openBusiness(salesApi(role));
    const buttons = sectionButtons();
    expect(buttons.includes("Sales")).toBe(sales);
    expect(buttons.includes("Ledger")).toBe(ledger);
  });

  it("gives the accountant the Sales history only, with no Sell tab", async () => {
    await openBusiness(salesApi("ACCOUNTANT"));
    await openSection("Sales");
    const tabs = within(screen.getByRole("navigation", { name: "Sales sections" })).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Sales"]);
    expect(screen.queryByLabelText("Find a product")).toBeNull();
  });

  it("gives a cashier Sell and Sales but no discount control", async () => {
    await openBusiness(salesApi("CASHIER"));
    await openSection("Sales");
    const tabs = within(screen.getByRole("navigation", { name: "Sales sections" })).getAllByRole("button");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Sell", "Sales"]);
    type("Find a product", "milk");
    await click("Search");
    await click(`Add ${MILK.name}`);
    expect(screen.queryByLabelText("Discount")).toBeNull();
  });
});

describe("selling", () => {
  it("records a keyed sale, shows the server receipt and keeps nothing in storage", async () => {
    const harness = salesApi("OWNER");
    const sale = saleFixture({ receiptNumber: "R-000007" });
    await openBusiness(harness);
    await openSection("Sales");
    expect(screen.getByText(FINAL_TOTAL_NOTE)).toBeTruthy();
    expect(screen.getByText(CHANGE_NOTE)).toBeTruthy();
    await cartOfTwoMilk();
    expect(harness.api.to(`POST ${SALES}`)).toHaveLength(0);
    let sentKey = "";
    const originalFetch = harness.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        sentKey = new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER) ?? "";
        harness.api.on(`POST ${SALES}`, json(201, { ...sale, saleId: sentKey }));
      }
      return originalFetch(input, init);
    });
    await click("Record sale");
    const [request] = harness.api.to(`POST ${SALES}`);
    expect(Object.keys(request?.body as object).sort()).toEqual(["lines", "saleId", "tenders"]);
    expect((request?.body as { saleId: string }).saleId).toBe(sentKey);
    expect(screen.getByText("Sale recorded.")).toBeTruthy();
    expect(screen.getByText(/R-000007/u)).toBeTruthy();
    expect(screen.queryByLabelText("Find a product")).toBeNull();
    expectNothingPersisted();
  });

  it("locks the cart on an unknown outcome and resends the same key and body", async () => {
    const harness = salesApi("OWNER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    harness.api.on(`POST ${SALES}`, networkError);
    await click("Record sale");
    expect(screen.getByText(UNCONFIRMED_SALE)).toBeTruthy();
    expect(screen.getByLabelText("Quantity (PIECE)")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Record sale" })).toBeNull();
    const [first] = harness.api.to(`POST ${SALES}`);
    const key = first?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    harness.api.on(`POST ${SALES}`, json(201, saleFixture({ saleId: key })));
    await click("Submit again with same details");
    const [, second] = harness.api.to(`POST ${SALES}`);
    expect(second?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(key);
    expect(second?.body).toEqual(first?.body);
    expect(screen.getByText("Sale recorded.")).toBeTruthy();
  });

  it("discarding an unknown outcome keeps the cart and opens Sales history", async () => {
    const harness = salesApi("OWNER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    harness.api.on(`POST ${SALES}`, networkError);
    await click("Record sale");
    await click("Discard and check Sales history");
    expect(screen.getByText("No sales yet.")).toBeTruthy();
    await openSalesTab("Sell");
    expect(screen.getByLabelText("Quantity (PIECE)")).toHaveProperty("value", "2");
  });

  it("shows the server total on a tender mismatch and keeps the cart", async () => {
    const harness = salesApi("OWNER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    harness.api.on(`POST ${SALES}`, apiError(409, "TENDER_TOTAL_MISMATCH", "x", { serverTotalMinor: "123456" }));
    await click("Record sale");
    expect(screen.getByText(/Server total: .*1,234\.56/u)).toBeTruthy();
    await click("Use the server total as the tender amount");
    expect(screen.getByLabelText("Amount (NGN)")).toHaveProperty("value", "1234.56");
    expect(screen.getByLabelText("Quantity (PIECE)")).toBeTruthy();
  });

  it("shows ledger-not-provisioned guidance", async () => {
    const harness = salesApi("OWNER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    harness.api.on(`POST ${SALES}`, apiError(409, "LEDGER_NOT_PROVISIONED"));
    await click("Record sale");
    expect(screen.getByText("This business is not ready to record sales yet.")).toBeTruthy();
  });

  it("drops the cart when the section is left, and after sign-out", async () => {
    const harness = salesApi("OWNER");
    await openBusiness(harness);
    await openSection("Sales");
    await cartOfTwoMilk();
    await openSection("Overview");
    await openSection("Sales");
    expect(screen.getByText("The cart is empty.")).toBeTruthy();
    await cartOfTwoMilk();
    await click("Sign out");
    expect(screen.queryByText("Cart")).toBeNull();
    expect(harness.api.to(`POST ${SALES}`)).toHaveLength(0);
    expectNothingPersisted();
  });
});

describe("sale detail and reversal", () => {
  function withSale(role: string, sale = costedSale("VALUED", { receiptNumber: "R-000003" })) {
    const harness = salesApi(role);
    harness.api.on(`GET ${SALES}`, page([sale])).on(`GET ${SALES}/${sale.saleId}`, json(200, sale));
    return { harness, sale };
  }

  it("reverses only after the tender confirmation, with a key, and shows Sale reversed.", async () => {
    const { harness, sale } = withSale("OWNER");
    harness.api.on(`POST ${SALES}/${sale.saleId}/reversal`, json(200, reversedOf(sale)));
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await click("Open sale R-000003");
    type("Reason for the correction", "Rang up the wrong item");
    await click("Reverse sale");
    expect(screen.getByText("Confirm that the original tender has been returned or unwound.")).toBeTruthy();
    expect(harness.api.to(`POST ${SALES}/${sale.saleId}/reversal`)).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(TENDER_UNWOUND_CONFIRMATION));
    await click("Reverse sale");
    const [request] = harness.api.to(`POST ${SALES}/${sale.saleId}/reversal`);
    expect(request?.body).toEqual({ reason: "Rang up the wrong item", tenderUnwoundConfirmed: true });
    expect(request?.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(screen.getByText("Sale reversed.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reverse sale" })).toBeNull();
  });

  it("reuses the reversal key after an unknown outcome", async () => {
    const { harness, sale } = withSale("MANAGER");
    harness.api.on(`POST ${SALES}/${sale.saleId}/reversal`, networkError);
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await click("Open sale R-000003");
    type("Reason for the correction", "Wrong customer");
    fireEvent.click(screen.getByLabelText(TENDER_UNWOUND_CONFIRMATION));
    await click("Reverse sale");
    expect(screen.getByText(UNCONFIRMED_REVERSAL)).toBeTruthy();
    harness.api.on(`POST ${SALES}/${sale.saleId}/reversal`, json(200, reversedOf(sale)));
    await click("Submit again with same details");
    const [first, second] = harness.api.to(`POST ${SALES}/${sale.saleId}/reversal`);
    expect(second?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(first?.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(screen.getByText("Sale reversed.")).toBeTruthy();
  });

  it.each(["CASHIER", "ACCOUNTANT"])("%s sees the sale but no reversal", async (role) => {
    const { harness } = withSale(role, saleFixture({ receiptNumber: "R-000003" }));
    await openBusiness(harness);
    await openSection("Sales");
    if (role === "CASHIER") await openSalesTab("Sales");
    await click("Open sale R-000003");
    expect(screen.getByText(/R-000003/u)).toBeTruthy();
    expect(screen.queryByLabelText("Reason for the correction")).toBeNull();
  });

  it("discloses unknown cost and incomplete margin without computing one", async () => {
    const { harness } = withSale("OWNER", costedSale("UNVALUED", { receiptNumber: "R-000003" }));
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await click("Open sale R-000003");
    expect(screen.getAllByText("Cost unknown").length).toBeGreaterThan(0);
    expect(screen.getByText("Margin incomplete")).toBeTruthy();
    expect(screen.getByText("Cost unknown for this sale.")).toBeTruthy();
    expect(screen.queryByText(/Margin:/u)).toBeNull();
  });

  it("shows a non-cash tender as Not verified with its reference", async () => {
    const sale = saleFixture({
      receiptNumber: "R-000003",
      tenders: [
        cashTender({
          method: "BANK_TRANSFER",
          reference: "TRF-9",
          verificationStatus: "NOT_VERIFIED",
          cashReceived: null,
          changeGiven: null,
        }),
      ],
    });
    const { harness } = withSale("OWNER", sale);
    await openBusiness(harness);
    await openSection("Sales");
    await openSalesTab("Sales");
    await click("Open sale R-000003");
    expect(screen.getByText("Not verified")).toBeTruthy();
    expect(screen.getByText(/TRF-9/u)).toBeTruthy();
  });
});

describe("ledger (read only)", () => {
  it("shows accounts and balances and the incomplete-valuation notice", async () => {
    const harness = salesApi("ACCOUNTANT", [itemFixture({ valuationStatus: "UNVALUED" })]);
    await openBusiness(harness);
    await openSection("Ledger");
    const [, accountRow] = within(screen.getByRole("table", { name: "Ledger accounts" })).getAllByRole("row");
    expect(
      within(accountRow as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["1000", "Cash on hand", "Asset", "Debit", "Cash on hand", "Active"]);
    expect(
      within(screen.getByRole("table", { name: "Account balances" })).getByText(/1000 Cash on hand/u),
    ).toBeTruthy();
    expect(screen.getByText(VALUATION_INCOMPLETE)).toBeTruthy();
    const probe = harness.api.requests.find((request) => request.query.includes("needsValuation=true"));
    expect(probe?.query).toBe("?limit=1&needsValuation=true");
    expect(
      harness.api.requests.every((request) => request.method === "GET" || request.path === "/__local/sign-in"),
    ).toBe(true);
  });

  it("says when completeness could not be checked, and nothing when complete", async () => {
    await openBusiness(salesApi("OWNER", "fail"));
    await openSection("Ledger");
    expect(screen.getByText(VALUATION_UNCHECKED)).toBeTruthy();
    expect(screen.queryByText(VALUATION_INCOMPLETE)).toBeNull();
  });
});

describe("needs valuation", () => {
  const UNVALUED = itemFixture({ name: "Rice 1kg", valuationStatus: "UNVALUED", balanceVersion: 4 });

  async function openNeedsValuation(role: string) {
    const harness = salesApi(role, [UNVALUED]);
    harness.api.on(`GET ${BASE}/inventory/items/${UNVALUED.variantId}`, json(200, UNVALUED));
    await openBusiness(harness);
    await openSection("Inventory");
    const nav = screen.getByRole("navigation", { name: "Inventory sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Needs valuation" }));
    await act(settle);
    return harness;
  }

  it("records an opening valuation with the balance version and a key", async () => {
    const harness = await openNeedsValuation("OWNER");
    const row = within(screen.getByRole("list", { name: "Stock needing valuation" })).getByRole("listitem");
    expect(row.textContent).toContain("Cost unknown");
    harness.api.on(
      `POST ${BASE}/inventory/valuations`,
      json(201, { valuationId: UNVALUED.variantId, kind: "INITIAL_OPENING" }),
    );
    await click(`Value stock of ${UNVALUED.name}`);
    type("Total value (NGN)", "0");
    type("Reason", "Opening count");
    await click("Record valuation");
    const [request] = harness.api.to(`POST ${BASE}/inventory/valuations`);
    expect(request?.body).toEqual({
      variantId: UNVALUED.variantId,
      expectedBalanceVersion: 4,
      newTotalValue: ngn("0"),
      reason: "Opening count",
    });
    expect(request?.headers.get(IDEMPOTENCY_KEY_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(screen.getByText("Opening valuation recorded.")).toBeTruthy();
    expectNothingPersisted();
  });

  it("reloads the item on VALUATION_STALE", async () => {
    const harness = await openNeedsValuation("MANAGER");
    harness.api.on(`POST ${BASE}/inventory/valuations`, apiError(409, "VALUATION_STALE"));
    await click(`Value stock of ${UNVALUED.name}`);
    type("Total value (NGN)", "500");
    type("Reason", "Count");
    await click("Record valuation");
    expect(screen.getByText(VALUATION_STALE_TEXT)).toBeTruthy();
    expect(harness.api.to(`GET ${BASE}/inventory/items/${UNVALUED.variantId}`).length).toBeGreaterThan(0);
  });

  it("lets the accountant see the list but not value stock", async () => {
    await openNeedsValuation("ACCOUNTANT");
    expect(screen.getByText("Rice 1kg")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Value stock of/u })).toBeNull();
  });

  it.each(["CASHIER", "STOCK_KEEPER"])("%s gets no Needs valuation tab", async (role) => {
    await openBusiness(salesApi(role));
    if (!sectionButtons().includes("Inventory")) return;
    await openSection("Inventory");
    const nav = screen.queryByRole("navigation", { name: "Inventory sections" });
    expect(nav === null ? null : within(nav).queryByRole("button", { name: "Needs valuation" })).toBeNull();
  });
});
