import type { WebPublicConfig } from "@tali/config/public";
import type { InventoryItemResponse } from "@tali/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "../src/lib/api-client/tali-api-client";
import { STALE_MESSAGE } from "../src/inventory/stocktake-detail";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import { UNITS } from "./support/catalog-fixtures";
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
import {
  adjustmentFixture,
  blindLine,
  fullLine,
  itemFixture,
  LOCATION_ID,
  movementFixture,
  openingFixture,
  receiptFixture,
  stocktakeFixture,
} from "./support/inventory-fixtures";

const LOCAL: WebPublicConfig = { env: "local", apiBaseUrl: "http://api.test", authMode: "local" };
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const INV = `${BASE}/inventory`;
const BALANCES = `GET ${INV}/balances`;
const STOCKTAKES = `GET ${INV}/stocktakes`;
const pieces = (quantityMinor: string) => ({ quantityMinor, unit: "PIECE" });
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });
const ITEM = itemFixture({ name: "Peak Milk 400g", onHand: pieces("12") });

function inventoryApi(role = "OWNER", items: readonly InventoryItemResponse[] = [ITEM]): FakeTaliApi {
  const api = registeredUserApi()
    .on(
      "GET /v1/me/businesses",
      json(200, { items: [{ business: BUSINESS_A, membership: { ...MEMBERSHIP_A, role } }], nextCursor: null }),
    )
    .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
    .on(BALANCES, page(items))
    .on(STOCKTAKES, page([]));
  for (const item of items) withItem(api, item);
  return api;
}

function thresholdBody(
  item: InventoryItemResponse,
  threshold: { quantityMinor: string; unit: string } | null,
  version: number,
) {
  return { variantId: item.variantId, locationId: LOCATION_ID, threshold, version, changed: true };
}

function withItem(api: FakeTaliApi, item: InventoryItemResponse): FakeTaliApi {
  return api
    .on(`GET ${INV}/items/${item.variantId}`, json(200, item))
    .on(`GET ${INV}/items/${item.variantId}/movements`, page([]))
    .on(`GET ${BASE}/products/${item.productId}/packs`, page([]));
}

async function openInventory(api: FakeTaliApi) {
  vi.stubGlobal("fetch", api.fetch);
  render(<OnboardingApp config={LOCAL} invitationLink={false} />);
  fireEvent.change(screen.getByLabelText("Local subject"), { target: { value: "local-user-ada" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in (local development)" }));
  fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
  const nav = await screen.findByRole("navigation", { name: "Business sections" });
  fireEvent.click(within(nav).getByRole("button", { name: "Inventory" }));
  await act(settle);
}

async function click(name: string | RegExp) {
  fireEvent.click(await screen.findByRole("button", { name }));
  await act(settle);
}

async function openStocktakes() {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Inventory sections" })).getByRole("button", { name: "Stocktakes" }),
  );
  await act(settle);
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
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

describe("stock list", () => {
  it("shows LOW STOCK only from the API boolean and never for archived items", async () => {
    const low = itemFixture({ name: "Low item", onHand: pieces("9"), threshold: pieces("2"), lowStock: true });
    const atThreshold = itemFixture({
      name: "At threshold",
      onHand: pieces("1"),
      threshold: pieces("5"),
      lowStock: false,
    });
    const archived = itemFixture({ name: "Old item", productStatus: "ARCHIVED", lowStock: true });
    await openInventory(inventoryApi("OWNER", [low, atThreshold, archived]));
    const rows = within(screen.getByRole("list", { name: "Stock items" })).getAllByRole("listitem");
    const badges = rows.map((row) => within(row).queryByText("LOW STOCK") !== null);
    expect(badges).toEqual([true, false, false]);
    expect(rows[2]?.textContent).toContain("Archived");
    expect(rows[1]?.textContent).toContain("On hand: 1 PIECE");
    expectNothingPersisted();
  });

  it("searches on the server and filters with lowStock=true, sending no locationId", async () => {
    const api = inventoryApi();
    await openInventory(api);
    type("Search name, SKU or barcode", "milk");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await act(settle);
    fireEvent.click(screen.getByRole("checkbox", { name: "Low stock only" }));
    await act(settle);
    expect(api.to(BALANCES).map((request) => request.query)).toEqual(["", "?q=milk", "?q=milk&lowStock=true"]);
    expect(api.requests.some((request) => /locationId/u.test(request.query))).toBe(false);
    expect(api.to(BALANCES)[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it.each([
    ["OWNER", ["Receive stock", "Record opening stock", "Adjust stock", "Write off stock"], true],
    ["MANAGER", ["Receive stock", "Record opening stock", "Adjust stock", "Write off stock"], true],
    ["STOCK_KEEPER", ["Receive stock"], true],
    ["CASHIER", [], false],
    ["ACCOUNTANT", [], false],
  ])("%s sees only the actions its role allows", async (role, actions, canCount) => {
    await openInventory(inventoryApi(role));
    for (const label of ["Receive stock", "Record opening stock", "Adjust stock", "Write off stock"]) {
      expect(screen.queryByRole("button", { name: label }) !== null).toBe(actions.includes(label));
    }
    await openStocktakes();
    expect(screen.queryByRole("button", { name: "Start stocktake" }) !== null).toBe(canCount);
  });
});

describe("item detail and thresholds", () => {
  it("shows on hand and history from the API with links to the source document", async () => {
    const receiptId = "0190a000-0000-7000-8000-0000000000f1";
    const api = inventoryApi().on(
      `GET ${INV}/items/${ITEM.variantId}/movements`,
      page([movementFixture({ source: { kind: "GOODS_RECEIPT", id: receiptId } })]),
    );
    api.on(`GET ${INV}/goods-receipts/${receiptId}`, json(200, receiptFixture(ITEM.variantId, receiptId)));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    expect(screen.getByRole("heading", { name: ITEM.name })).toBeDefined();
    const history = screen.getByRole("table", { name: "Stock history" });
    expect(history.textContent).toContain("+24 PIECE");
    expect(history.textContent).toContain("36 PIECE");
    await click("View goods receipt");
    expect(screen.getByRole("heading", { name: "Goods receipt" })).toBeDefined();
  });

  it("sets with version 0, sends the stored version next, and reloads without retrying on VERSION_CONFLICT", async () => {
    const withThreshold = { ...ITEM, threshold: pieces("5"), thresholdVersion: 3, lowStock: true };
    const PUT = `PUT ${INV}/items/${ITEM.variantId}/threshold`;
    const api = inventoryApi()
      .on(`GET ${INV}/items/${ITEM.variantId}`, json(200, ITEM), json(200, withThreshold), json(200, withThreshold))
      .on(PUT, json(200, thresholdBody(ITEM, pieces("5"), 3)), apiError(409, "VERSION_CONFLICT"));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    type("Threshold (PIECE)", "5");
    await click("Set threshold");
    expect(await screen.findByText("Threshold saved.")).toBeDefined();
    expect(screen.getByText("LOW STOCK")).toBeDefined();
    type("New threshold (PIECE)", "1.5");
    await click("Change threshold");
    expect(screen.getByText("Enter a whole number of PIECE, for example 12.")).toBeDefined();
    expect(api.to(PUT)).toHaveLength(1);
    type("New threshold (PIECE)", "6");
    await click("Change threshold");
    expect(await screen.findByText(/The threshold was changed by someone else/u)).toBeDefined();
    expect(api.to(PUT).map((request) => request.body)).toEqual([
      { expectedVersion: 0, threshold: pieces("5") },
      { expectedVersion: 3, threshold: pieces("6") },
    ]);
    expect(api.to(`GET ${INV}/items/${ITEM.variantId}`)).toHaveLength(3);
  });

  it("clears with the stored version", async () => {
    const withThreshold = { ...ITEM, threshold: pieces("5"), thresholdVersion: 2 };
    const CLEAR = `POST ${INV}/items/${ITEM.variantId}/threshold/clear`;
    const api = withItem(inventoryApi(), withThreshold).on(CLEAR, json(200, thresholdBody(ITEM, null, 3)));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    await click("Clear threshold");
    expect(await screen.findByText("Threshold cleared.")).toBeDefined();
    expect(api.to(CLEAR)[0]?.body).toEqual({ expectedVersion: 2 });
  });

  it("hides the threshold panel without inventory:threshold", async () => {
    await openInventory(inventoryApi("CASHIER"));
    await click(`Open ${ITEM.name}`);
    expect(screen.queryByRole("heading", { name: "Low-stock threshold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Adjust stock" })).toBeNull();
  });
});

describe("stock documents", () => {
  it("records an adjustment with an explicit direction and keeps the form after INSUFFICIENT_STOCK", async () => {
    const POST = `POST ${INV}/adjustments`;
    const adjustment = adjustmentFixture(ITEM.variantId);
    const api = inventoryApi()
      .on(POST, apiError(409, "INSUFFICIENT_STOCK"), json(201, adjustment))
      .on(`GET ${INV}/adjustments/${adjustment.document.id}`, json(200, adjustment));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    await click("Adjust stock");
    fireEvent.click(screen.getByRole("radio", { name: "Decrease" }));
    type("Quantity (PIECE)", "3");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "DATA_ENTRY_CORRECTION" } });
    fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
    await act(settle);
    expect(await screen.findByText(/There is not enough stock for this change/u)).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Quantity (PIECE)").value).toBe("3");
    fireEvent.click(screen.getByRole("radio", { name: "Increase" }));
    fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
    await act(settle);
    expect(await screen.findByRole("heading", { name: "Adjustment" })).toBeDefined();
    const bodies = api.to(POST).map((request) => request.body);
    expect(bodies[0]).toEqual({
      lines: [{ variantId: ITEM.variantId, direction: "DECREASE", ...pieces("3") }],
      reasonCode: "DATA_ENTRY_CORRECTION",
    });
    expect(bodies[1]).toMatchObject({ lines: [{ direction: "INCREASE" }] });
    const keys = api.to(POST).map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("rejects fractional pieces before sending", async () => {
    const api = inventoryApi();
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    await click("Receive stock");
    type("Quantity (PIECE)", "1.5");
    fireEvent.click(screen.getByRole("button", { name: "Receive stock" }));
    await act(settle);
    expect(screen.getByText("Enter a whole number of PIECE, for example 12.")).toBeDefined();
    expect(api.to(`POST ${INV}/goods-receipts`)).toHaveLength(0);
  });

  it("keeps the same key when a receipt is resubmitted after a network failure", async () => {
    const POST = `POST ${INV}/goods-receipts`;
    const receipt = receiptFixture(ITEM.variantId);
    const api = inventoryApi()
      .on(POST, networkError, json(201, receipt))
      .on(`GET ${INV}/goods-receipts/${receipt.document.id}`, json(200, receipt));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    await click("Receive stock");
    type("Quantity (PIECE)", "24");
    type("Reference (optional)", "INV-1");
    fireEvent.click(screen.getByRole("button", { name: "Receive stock" }));
    await act(settle);
    expect(screen.getAllByText(/could not confirm whether this was saved/u).length).toBeGreaterThan(0);
    expect(screen.getByLabelText<HTMLInputElement>("Quantity (PIECE)").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Discard this submission" })).toBeDefined();
    await click("Submit again");
    expect(await screen.findByRole("heading", { name: "Goods receipt" })).toBeDefined();
    const [first, second] = api.to(POST);
    expect(second?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(first?.headers.get(IDEMPOTENCY_KEY_HEADER));
    expect(second?.body).toEqual({ lines: [{ variantId: ITEM.variantId, ...pieces("24") }], reference: "INV-1" });
  });

  it("reverses a write-off only after a reason and a confirmation", async () => {
    const writeOff = adjustmentFixture(ITEM.variantId, "WRITE_OFF");
    const REVERSE = `POST ${INV}/adjustments/${writeOff.document.id}/reverse`;
    const reversed = {
      ...writeOff,
      document: {
        ...writeOff.document,
        status: "REVERSED",
        reversedAt: writeOff.document.occurredAt,
        reversalReason: "Found it",
      },
    };
    const api = inventoryApi()
      .on(`POST ${INV}/write-offs`, json(201, writeOff))
      .on(`GET ${INV}/adjustments/${writeOff.document.id}`, json(200, writeOff), json(200, reversed))
      .on(REVERSE, json(200, { document: reversed.document, reversalMovements: [], changed: true }));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    await click("Write off stock");
    type("Quantity written off (PIECE)", "2");
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "DAMAGED" } });
    fireEvent.click(screen.getByRole("button", { name: "Write off stock" }));
    await act(settle);
    expect(await screen.findByRole("heading", { name: "Write-off" })).toBeDefined();
    expect(api.to(`POST ${INV}/write-offs`)[0]?.body).toEqual({
      lines: [{ variantId: ITEM.variantId, ...pieces("2") }],
      reasonCode: "DAMAGED",
    });
    await click("Reverse write-off");
    expect(screen.getByText("Enter a reason for reversing.")).toBeDefined();
    type("Reason for reversing", "Found it");
    await click("Reverse write-off");
    expect(api.to(REVERSE)).toHaveLength(0);
    await click("Confirm reversal");
    expect(api.to(REVERSE)[0]?.body).toEqual({ reason: "Found it" });
    expect(await screen.findByText("The write-off was reversed.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reverse write-off" })).toBeNull();
  });

  it("never offers to reverse opening stock", async () => {
    const opening = openingFixture(ITEM.variantId);
    const api = inventoryApi()
      .on(
        `GET ${INV}/items/${ITEM.variantId}/movements`,
        page([movementFixture({ type: "OPENING", source: { kind: "OPENING_BATCH", id: opening.document.id } })]),
      )
      .on(`GET ${INV}/opening-batches/${opening.document.id}`, json(200, opening));
    await openInventory(api);
    await click(`Open ${ITEM.name}`);
    await click("View opening stock");
    expect(screen.getByRole("heading", { name: "Opening stock" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Reverse/u })).toBeNull();
  });
});

describe("stocktakes", () => {
  function stocktakeApi(role: string, visibility: "FULL" | "BLIND", lineFor: typeof blindLine | typeof fullLine) {
    const stocktake = stocktakeFixture(visibility, { countedLineCount: 1 });
    const line = lineFor(ITEM.variantId);
    const ROUTE = `${INV}/stocktakes/${stocktake.stocktakeId}`;
    const api = inventoryApi(role)
      .on(STOCKTAKES, page([stocktake]))
      .on(`GET ${ROUTE}`, json(200, stocktake))
      .on(`GET ${ROUTE}/lines`, page([line]));
    return { api, stocktake, line, ROUTE };
  }

  async function openStocktake(api: FakeTaliApi) {
    await openInventory(api);
    await openStocktakes();
    fireEvent.click(screen.getByRole("button", { name: /^Open stocktake started/u }));
    await act(settle);
  }

  it("BLIND: renders no expected quantity or difference and no post for a stock keeper", async () => {
    const { api } = stocktakeApi("STOCK_KEEPER", "BLIND", blindLine);
    await openStocktake(api);
    const table = screen.getByRole("table", { name: "Counted items" });
    expect(table.textContent).toContain(ITEM.name);
    expect(table.textContent).toContain("10 PIECE");
    expect(within(table).queryByRole("columnheader", { name: "Expected" })).toBeNull();
    expect(within(table).queryByRole("columnheader", { name: "Difference" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/987|Not posted/u);
    expect(screen.queryByRole("button", { name: "Post stocktake" })).toBeNull();
    expect(screen.getByRole("button", { name: `Recount ${ITEM.name}` })).toBeDefined();
  });

  it("FULL: shows the contract fields and recounts with the line version", async () => {
    const { api, stocktake, line, ROUTE } = stocktakeApi("OWNER", "FULL", fullLine);
    const PUT = `PUT ${ROUTE}/lines/${ITEM.variantId}`;
    api.on(
      PUT,
      json(200, {
        stocktake: { ...stocktake, version: 2 },
        line: { ...line, version: 2, countedQuantity: pieces("11") },
        changed: true,
      }),
    );
    await openStocktake(api);
    const table = screen.getByRole("table", { name: "Counted items" });
    expect(within(table).getByRole("columnheader", { name: "Expected" })).toBeDefined();
    expect(table.textContent).toContain("987 PIECE");
    await click(`Recount ${ITEM.name}`);
    type("Counted quantity (PIECE)", "11");
    await click("Save count");
    expect(api.to(PUT)[0]?.body).toEqual({ count: pieces("11"), expectedVersion: 1 });
    expect(await screen.findByText(`Count saved for ${ITEM.name}.`)).toBeDefined();
  });

  it("removes a line with its version", async () => {
    const { api, stocktake, line, ROUTE } = stocktakeApi("STOCK_KEEPER", "BLIND", blindLine);
    const REMOVE = `POST ${ROUTE}/lines/${ITEM.variantId}/remove`;
    api.on(REMOVE, json(200, { stocktake, line: { ...line, status: "REMOVED", version: 2 }, changed: true }));
    await openStocktake(api);
    await click(`Remove ${ITEM.name}`);
    expect(api.to(REMOVE)[0]?.body).toEqual({ expectedVersion: 1 });
    expect(await screen.findByText(`${ITEM.name} removed from this stocktake.`)).toBeDefined();
    expect(screen.getByRole("button", { name: `Recount ${ITEM.name}` }).textContent).toBe("Count again");
  });

  it("posts after confirmation, marks stale lines on STOCKTAKE_STALE without resubmitting, and treats a replay as success", async () => {
    const { api, stocktake, ROUTE } = stocktakeApi("OWNER", "FULL", fullLine);
    const POST = `POST ${ROUTE}/post`;
    const posted = { ...stocktake, status: "POSTED", version: 2 };
    api.on(
      POST,
      apiError(409, "STOCKTAKE_STALE", "stale", { staleVariantIds: [ITEM.variantId], staleLineCount: 3 }),
      json(200, { stocktake: posted, movements: [], changed: false }),
    );
    await openStocktake(api);
    await click("Post stocktake");
    expect(api.to(POST)).toHaveLength(0);
    await click("Confirm post");
    expect(screen.getByRole("alert").textContent).toContain(STALE_MESSAGE);
    expect(screen.getByText("3 items are affected; the first 1 are marked below.")).toBeDefined();
    expect(screen.getByText("Stock changed while counting. Recount.")).toBeDefined();
    expect(api.to(`GET ${ROUTE}`)).toHaveLength(2);
    await act(settle);
    expect(api.to(POST)).toHaveLength(1);

    await click("Post stocktake");
    await click("Confirm post");
    expect(api.to(POST).map((request) => request.body)).toEqual([{ expectedVersion: 1 }, { expectedVersion: 1 }]);
    expect(await screen.findByText("This stocktake was already posted.")).toBeDefined();
  });

  it("cancels after confirmation with an optional reason", async () => {
    const { api, stocktake, ROUTE } = stocktakeApi("MANAGER", "FULL", fullLine);
    const CANCEL = `POST ${ROUTE}/cancel`;
    api.on(
      CANCEL,
      json(200, {
        stocktake: { ...stocktake, status: "CANCELLED", cancelledAt: stocktake.createdAt, version: 2 },
        changed: true,
      }),
    );
    await openStocktake(api);
    await click("Cancel stocktake");
    type("Reason (optional)", "Started by mistake");
    await click("Confirm cancel");
    expect(api.to(CANCEL)[0]?.body).toEqual({ expectedVersion: 1, reason: "Started by mistake" });
    expect(await screen.findByText("Stocktake cancelled. No stock was changed.")).toBeDefined();
  });

  it("guides to the stocktake in progress when starting one conflicts", async () => {
    const { api, stocktake } = stocktakeApi("STOCK_KEEPER", "BLIND", blindLine);
    api.on(`POST ${INV}/stocktakes`, apiError(409, "CONFLICT"));
    await openInventory(api);
    await openStocktakes();
    await click("Start stocktake");
    expect(screen.getByText(/A stocktake is already in progress/u)).toBeDefined();
    await click("Open the stocktake in progress");
    expect(api.to(STOCKTAKES).at(-1)?.query).toBe("?limit=1&status=DRAFT");
    expect(await screen.findByRole("heading", { name: "Stocktake" })).toBeDefined();
    expect(api.to(`GET ${INV}/stocktakes/${stocktake.stocktakeId}`)).toHaveLength(1);
    expectNothingPersisted();
  });
});
