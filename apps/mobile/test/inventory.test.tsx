import type * as NodeCrypto from "node:crypto";
import type { MobilePublicConfig } from "@tali/config/public";
import type { InventoryItemResponse } from "@tali/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { BackHandler } from "react-native";
import { IDEMPOTENCY_KEY_HEADER } from "../src/api/tali-api-client";
import { createSessionStore, SessionProvider } from "../src/auth/session-context";
import { installSecureRandom } from "../src/ids/secure-random";
import { STALE_MESSAGE } from "../src/inventory/stocktake-detail-screen";
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

jest.mock("expo-crypto", () => ({
  getRandomValues: <T extends ArrayBufferView>(array: T): T =>
    jest.requireActual<typeof NodeCrypto>("node:crypto").webcrypto.getRandomValues(array as never),
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
}));

jest.setTimeout(30_000);

const LOCAL: MobilePublicConfig = { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" };
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const INV = `${BASE}/inventory`;
const BALANCES = `GET ${INV}/balances`;
const STOCKTAKES = `GET ${INV}/stocktakes`;
const pieces = (quantityMinor: string) => ({ quantityMinor, unit: "PIECE" });
const page = (items: readonly unknown[], nextCursor: string | null = null) => json(200, { items, nextCursor });
const ITEM = itemFixture({ name: "Peak Milk 400g", onHand: pieces("12") });
const originalFetch = globalThis.fetch;

beforeAll(() => {
  installSecureRandom();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

function withItem(api: FakeTaliApi, item: InventoryItemResponse): FakeTaliApi {
  return api
    .on(`GET ${INV}/items/${item.variantId}`, json(200, item))
    .on(`GET ${INV}/items/${item.variantId}/movements`, page([]))
    .on(`GET ${BASE}/products/${item.productId}/packs`, page([]));
}

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

/** Non-Android platform: no device registration, so no keystore is touched by these UI tests. */
async function openInventory(api: FakeTaliApi): Promise<void> {
  globalThis.fetch = api.fetch;
  const store = createSessionStore(LOCAL, "ios");
  await render(
    <SessionProvider store={store}>
      <OnboardingApp config={LOCAL} />
    </SessionProvider>,
  );
  await fireEvent.changeText(screen.getByLabelText("Local subject"), "local-user-ada");
  await fireEvent.press(screen.getByRole("button", { name: "Sign in (local development)" }));
  await fireEvent.press(await screen.findByRole("button", { name: `Open ${BUSINESS_A.name}` }));
  await fireEvent.press(await screen.findByRole("tab", { name: "Inventory" }));
  await screen.findByRole("header", { name: "Stock" });
  await settle();
}

async function press(name: string | RegExp) {
  await fireEvent.press(await screen.findByRole("button", { name }));
  await settle();
}

async function openStocktakes() {
  await fireEvent.press(screen.getByRole("tab", { name: "Stocktakes" }));
  await screen.findByRole("header", { name: "Stocktakes" });
  await settle();
}

describe("mobile stock list", () => {
  it("adds an Inventory tab and shows LOW STOCK only from the API boolean, never for archived items", async () => {
    const low = itemFixture({ name: "Low item", onHand: pieces("9"), threshold: pieces("2"), lowStock: true });
    const atThreshold = itemFixture({
      name: "At threshold",
      onHand: pieces("1"),
      threshold: pieces("5"),
      lowStock: false,
    });
    const archived = itemFixture({ name: "Old item", productStatus: "ARCHIVED", lowStock: true });
    await openInventory(inventoryApi("OWNER", [low, atThreshold, archived]));
    expect(screen.getAllByRole("tab").map((tab) => tab.props["accessibilityLabel"] as string)).toEqual([
      "Overview",
      "Catalog",
      "Inventory",
      "Stock",
      "Stocktakes",
    ]);
    const card = (name: string) => screen.getByRole("button", { name: `Open ${name}` });
    expect(within(card("Low item")).queryByText("LOW STOCK")).not.toBeNull();
    expect(within(card("At threshold")).queryByText("LOW STOCK")).toBeNull();
    expect(within(card("At threshold")).getByText("On hand: 1 PIECE")).toBeTruthy();
    expect(within(card("Old item")).queryByText("LOW STOCK")).toBeNull();
    expect(within(card("Old item")).getByText("Archived")).toBeTruthy();
  });

  it("searches on the server and filters with lowStock=true, sending no locationId", async () => {
    const api = inventoryApi();
    await openInventory(api);
    await fireEvent.changeText(screen.getByLabelText("Search name, SKU or barcode"), "milk");
    await press("Search");
    await fireEvent.press(screen.getByRole("checkbox", { name: "Low stock only" }));
    await settle();
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

describe("mobile item detail, thresholds and hardware back", () => {
  it("registers hardware back in the item view and returns to the list", async () => {
    const listeners: Parameters<typeof BackHandler.addEventListener>[1][] = [];
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      listeners.push(handler);
      return {
        remove: () => {
          listeners.splice(listeners.indexOf(handler), 1);
        },
      };
    });
    await openInventory(inventoryApi());
    expect(listeners).toHaveLength(0);
    await press(`Open ${ITEM.name}`);
    await screen.findByRole("header", { name: ITEM.name });
    expect(listeners).toHaveLength(1);
    let consumed: boolean | null | undefined;
    await act(() => {
      consumed = listeners[0]?.({ type: "hardwareBackPress", timeStamp: 0 });
    });
    expect(consumed).toBe(true);
    await screen.findByRole("header", { name: "Stock" });
    expect(listeners).toHaveLength(0);
  });

  it("sets with version 0, sends the stored version next, and reloads without retrying on VERSION_CONFLICT", async () => {
    const withThreshold = { ...ITEM, threshold: pieces("5"), thresholdVersion: 3, lowStock: true };
    const PUT = `PUT ${INV}/items/${ITEM.variantId}/threshold`;
    const saved = {
      variantId: ITEM.variantId,
      locationId: LOCATION_ID,
      threshold: pieces("5"),
      version: 3,
      changed: true,
    };
    const api = inventoryApi()
      .on(`GET ${INV}/items/${ITEM.variantId}`, json(200, ITEM), json(200, withThreshold), json(200, withThreshold))
      .on(PUT, json(200, saved), apiError(409, "VERSION_CONFLICT"));
    await openInventory(api);
    await press(`Open ${ITEM.name}`);
    await fireEvent.changeText(await screen.findByLabelText("Threshold (PIECE)"), "5");
    await press("Set threshold");
    expect(await screen.findByText("Threshold saved.")).toBeTruthy();
    expect(screen.getByText("LOW STOCK")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("New threshold (PIECE)"), "6");
    await press("Change threshold");
    expect(await screen.findByText(/The threshold was changed by someone else/u)).toBeTruthy();
    expect(api.to(PUT).map((request) => request.body)).toEqual([
      { expectedVersion: 0, threshold: pieces("5") },
      { expectedVersion: 3, threshold: pieces("6") },
    ]);
    expect(api.to(`GET ${INV}/items/${ITEM.variantId}`)).toHaveLength(3);
  });
});

describe("mobile stock documents", () => {
  it("records an adjustment with an explicit direction and keeps the form after INSUFFICIENT_STOCK", async () => {
    const POST = `POST ${INV}/adjustments`;
    const adjustment = adjustmentFixture(ITEM.variantId);
    const api = inventoryApi()
      .on(POST, apiError(409, "INSUFFICIENT_STOCK"), json(201, adjustment))
      .on(`GET ${INV}/adjustments/${adjustment.document.id}`, json(200, adjustment));
    await openInventory(api);
    await press(`Open ${ITEM.name}`);
    await press("Adjust stock");
    await fireEvent.press(screen.getByRole("radio", { name: "Decrease" }));
    await fireEvent.changeText(screen.getByLabelText("Quantity (PIECE)"), "3");
    await fireEvent.press(screen.getByRole("radio", { name: "Data entry correction" }));
    await press("Adjust stock");
    expect(await screen.findByText(/There is not enough stock for this change/u)).toBeTruthy();
    expect(screen.getByLabelText("Quantity (PIECE)").props["value"]).toBe("3");
    await fireEvent.press(screen.getByRole("radio", { name: "Increase" }));
    await press("Adjust stock");
    expect(await screen.findByRole("header", { name: "Adjustment" })).toBeTruthy();
    expect(api.to(POST)[0]?.body).toEqual({
      lines: [{ variantId: ITEM.variantId, direction: "DECREASE", ...pieces("3") }],
      reasonCode: "DATA_ENTRY_CORRECTION",
    });
    expect(api.to(POST)[1]?.body).toMatchObject({ lines: [{ direction: "INCREASE" }] });
  });

  it("rejects fractional pieces, then keeps the same key when a receipt is resubmitted after a network failure", async () => {
    const POST = `POST ${INV}/goods-receipts`;
    const receipt = receiptFixture(ITEM.variantId);
    const api = inventoryApi()
      .on(POST, networkError, json(201, receipt))
      .on(`GET ${INV}/goods-receipts/${receipt.document.id}`, json(200, receipt));
    await openInventory(api);
    await press(`Open ${ITEM.name}`);
    await press("Receive stock");
    await fireEvent.changeText(screen.getByLabelText("Quantity (PIECE)"), "1.5");
    await press("Receive stock");
    expect(screen.getByText("Error: Enter a whole number of PIECE, for example 12.")).toBeTruthy();
    expect(api.to(POST)).toHaveLength(0);
    await fireEvent.changeText(screen.getByLabelText("Quantity (PIECE)"), "24");
    await press("Receive stock");
    expect(screen.getByText(/could not confirm whether this was saved/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard this submission" })).toBeTruthy();
    await press("Submit again");
    expect(await screen.findByRole("header", { name: "Goods receipt" })).toBeTruthy();
    const [first, second] = api.to(POST);
    expect(second?.headers.get(IDEMPOTENCY_KEY_HEADER)).toBe(first?.headers.get(IDEMPOTENCY_KEY_HEADER));
  });

  it("reverses a receipt only after a reason and a confirmation, and never offers to reverse opening stock", async () => {
    const receipt = receiptFixture(ITEM.variantId);
    const opening = openingFixture(ITEM.variantId);
    const REVERSE = `POST ${INV}/goods-receipts/${receipt.document.id}/reverse`;
    const reversed = {
      ...receipt.document,
      status: "REVERSED",
      reversedAt: receipt.document.occurredAt,
      reversalReason: "Wrong",
    };
    const api = inventoryApi()
      .on(
        `GET ${INV}/items/${ITEM.variantId}/movements`,
        page([
          movementFixture({ source: { kind: "GOODS_RECEIPT", id: receipt.document.id } }),
          movementFixture({ type: "OPENING", source: { kind: "OPENING_BATCH", id: opening.document.id } }),
        ]),
      )
      .on(
        `GET ${INV}/goods-receipts/${receipt.document.id}`,
        json(200, receipt),
        json(200, { ...receipt, document: reversed }),
      )
      .on(`GET ${INV}/opening-batches/${opening.document.id}`, json(200, opening))
      .on(REVERSE, json(200, { document: reversed, reversalMovements: [], changed: true }));
    await openInventory(api);
    await press(`Open ${ITEM.name}`);
    await press("View goods receipt");
    await press("Reverse receipt");
    expect(screen.getByText("Error: Enter a reason for reversing.")).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText("Reason for reversing"), "Wrong");
    await press("Reverse receipt");
    expect(api.to(REVERSE)).toHaveLength(0);
    await press("Confirm reversal");
    expect(api.to(REVERSE)[0]?.body).toEqual({ reason: "Wrong" });
    expect(await screen.findByText("The goods receipt was reversed.")).toBeTruthy();
    await press("Back");
    await press("View opening stock");
    expect(await screen.findByRole("header", { name: "Opening stock" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reverse/u })).toBeNull();
  });
});

describe("mobile stocktakes", () => {
  function stocktakeApi(role: string, visibility: "FULL" | "BLIND") {
    const stocktake = stocktakeFixture(visibility, { countedLineCount: 1 });
    const line = visibility === "FULL" ? fullLine(ITEM.variantId) : blindLine(ITEM.variantId);
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
    await press(/^Open stocktake started/u);
    await screen.findByRole("header", { name: "Stocktake" });
    await settle();
  }

  it("BLIND: renders no expected quantity or difference and offers no post", async () => {
    const { api } = stocktakeApi("STOCK_KEEPER", "BLIND");
    await openStocktake(api);
    expect(screen.getByText(ITEM.name)).toBeTruthy();
    expect(screen.getByText("Counted: 10 PIECE")).toBeTruthy();
    expect(screen.queryByText(/^Expected:|^Difference:|987/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Post stocktake" })).toBeNull();
    expect(screen.getByRole("button", { name: `Recount ${ITEM.name}` })).toBeTruthy();
  });

  it("FULL: shows the contract fields, recounts with the line version, marks stale lines and treats a replay as success", async () => {
    const { api, stocktake, line, ROUTE } = stocktakeApi("OWNER", "FULL");
    const PUT = `PUT ${ROUTE}/lines/${ITEM.variantId}`;
    const POST = `POST ${ROUTE}/post`;
    api
      .on(PUT, json(200, { stocktake: { ...stocktake, version: 2 }, line: { ...line, version: 2 }, changed: true }))
      .on(
        POST,
        apiError(409, "STOCKTAKE_STALE", "stale", { staleVariantIds: [ITEM.variantId], staleLineCount: 1 }),
        json(200, { stocktake: { ...stocktake, status: "POSTED", version: 2 }, movements: [], changed: false }),
      );
    await openStocktake(api);
    expect(screen.getByText("Expected: 987 PIECE")).toBeTruthy();
    await press(`Recount ${ITEM.name}`);
    await fireEvent.changeText(screen.getByLabelText("Counted quantity (PIECE)"), "11");
    await press("Save count");
    expect(api.to(PUT)[0]?.body).toEqual({ count: pieces("11"), expectedVersion: 1 });

    await press("Post stocktake");
    expect(api.to(POST)).toHaveLength(0);
    await press("Confirm post");
    expect(await screen.findByText(STALE_MESSAGE)).toBeTruthy();
    expect(screen.getByText("Stock changed while counting. Recount.")).toBeTruthy();
    await settle();
    expect(api.to(POST)).toHaveLength(1);
    await press("Post stocktake");
    await press("Confirm post");
    expect(await screen.findByText("This stocktake was already posted.")).toBeTruthy();
  });

  it("guides to the stocktake in progress when starting one conflicts", async () => {
    const { api } = stocktakeApi("STOCK_KEEPER", "BLIND");
    api.on(`POST ${INV}/stocktakes`, apiError(409, "CONFLICT"));
    await openInventory(api);
    await openStocktakes();
    await press("Start stocktake");
    expect(screen.getByText(/A stocktake is already in progress/u)).toBeTruthy();
    await press("Open the stocktake in progress");
    expect(api.to(STOCKTAKES).at(-1)?.query).toBe("?limit=1&status=DRAFT");
    expect(await screen.findByRole("header", { name: "Stocktake" })).toBeTruthy();
  });
});
