import type { WebPublicConfig } from "@tali/config/public";
import { isUuidV7 } from "@tali/domain/kernel";
import type { ProductResponse } from "@tali/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "../src/lib/api-client/tali-api-client";
import { OnboardingApp } from "../src/onboarding/onboarding-app";
import {
  categoryFixture,
  NGN,
  packFixture,
  priceEntryFixture,
  productFixture,
  UNITS,
} from "./support/catalog-fixtures";
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

const LOCAL: WebPublicConfig = { env: "local", apiBaseUrl: "http://api.test", authMode: "local" };
const BASE = `/v1/businesses/${BUSINESS_A.id}`;
const CATEGORY = categoryFixture({ name: "Drinks" });
const PRODUCT = productFixture({ name: "Malt 33cl", sku: "MALT-33", barcode: "5012345678900" });
const EMPTY_PAGE = { items: [], nextCursor: null };

function catalogApi(role = "OWNER", product: ProductResponse = PRODUCT): FakeTaliApi {
  return registeredUserApi()
    .on(
      "GET /v1/me/businesses",
      json(200, { items: [{ business: BUSINESS_A, membership: { ...MEMBERSHIP_A, role } }], nextCursor: null }),
    )
    .on(`GET ${BASE}/currency`, json(200, NGN))
    .on(`GET ${BASE}/catalog/units`, json(200, UNITS))
    .on(`GET ${BASE}/products`, json(200, { items: [product], nextCursor: null }))
    .on(`GET ${BASE}/categories`, json(200, { items: [CATEGORY], nextCursor: null }))
    .on(`GET ${BASE}/products/${product.id}`, json(200, product))
    .on(`GET ${BASE}/products/${product.id}/prices`, json(200, EMPTY_PAGE))
    .on(`GET ${BASE}/products/${product.id}/packs`, json(200, EMPTY_PAGE));
}

async function openCatalog(api: FakeTaliApi) {
  vi.stubGlobal("fetch", api.fetch);
  render(<OnboardingApp config={LOCAL} invitationLink={false} />);
  fireEvent.change(screen.getByLabelText("Local subject"), { target: { value: "local-user-ada" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in (local development)" }));
  fireEvent.click(await screen.findByRole("button", { name: /Ada Provisions/u }));
  const nav = await screen.findByRole("navigation", { name: "Business sections" });
  fireEvent.click(within(nav).getByRole("button", { name: "Catalog" }));
  await act(settle);
}

async function openProduct(name = PRODUCT.name) {
  fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
  await act(settle);
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

describe("catalog navigation", () => {
  it("switches between Overview and Catalog without a Team tab", async () => {
    await openCatalog(catalogApi());
    const nav = screen.getByRole("navigation", { name: "Business sections" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Overview", "Catalog"]);
    expect(within(nav).getByRole("button", { name: "Catalog" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Catalog" })).toBeDefined();
    expect(screen.getByRole("list", { name: "Products" }).textContent).toContain("Malt 33cl");

    fireEvent.click(within(nav).getByRole("button", { name: "Overview" }));
    await act(settle);
    expect(await screen.findByRole("heading", { name: BUSINESS_A.name })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Catalog" })).toBeNull();
  });
});

describe("role affordances (UX only)", () => {
  it.each([
    ["OWNER", true, true],
    ["MANAGER", true, true],
    ["STOCK_KEEPER", true, false],
    ["CASHIER", false, false],
    ["ACCOUNTANT", false, false],
  ])("%s: manage=%s price=%s", async (role, canManage, canPrice) => {
    await openCatalog(catalogApi(role));
    expect(screen.queryByRole("button", { name: "Create product" }) !== null).toBe(canManage);

    await openProduct();
    expect(await screen.findByRole("heading", { name: PRODUCT.name })).toBeDefined();
    expect(screen.getByText(/Current price:/u)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit product" }) !== null).toBe(canManage);
    expect(screen.queryByRole("button", { name: "Archive product" }) !== null).toBe(canManage);
    expect(screen.queryByRole("button", { name: "Add pack" }) !== null).toBe(canManage);
    expect(screen.queryByRole("button", { name: "Set price" }) !== null).toBe(canPrice);

    fireEvent.click(screen.getByRole("button", { name: "Back to products" }));
    await act(settle);
    const nav = await screen.findByRole("navigation", { name: "Catalog sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Categories" }));
    await act(settle);
    expect(screen.queryByRole("button", { name: "Create category" }) !== null).toBe(canManage);
    expect(screen.queryByRole("button", { name: `Rename ${CATEGORY.name}` }) !== null).toBe(canManage);
  });

  it("still shows a server PERMISSION_DENIED when the UI allowed the action", async () => {
    const api = catalogApi("OWNER").on(
      `POST ${BASE}/products/${PRODUCT.id}/archive`,
      apiError(403, "PERMISSION_DENIED"),
    );
    await openCatalog(api);
    await openProduct();
    fireEvent.click(await screen.findByRole("button", { name: "Archive product" }));
    await act(settle);
    expect(screen.getByRole("alert").textContent).toContain("This is not available with your access.");
    expect(screen.getByRole("heading", { name: PRODUCT.name })).toBeDefined();
  });
});

describe("product search", () => {
  it("searches server-side, filters by status and replaces the list", async () => {
    const api = catalogApi().on(
      `GET ${BASE}/products`,
      json(200, { items: [PRODUCT], nextCursor: null }),
      json(200, EMPTY_PAGE),
      json(200, EMPTY_PAGE),
    );
    await openCatalog(api);
    const search = screen.getByRole("search");
    fireEvent.change(within(search).getByLabelText("Search name, SKU or barcode"), { target: { value: "MALT-33" } });
    fireEvent.click(within(search).getByRole("button", { name: "Search" }));
    await act(settle);
    expect(api.to(`GET ${BASE}/products`).at(-1)?.query).toBe("?status=ACTIVE&q=MALT-33");
    expect(screen.getByText("No products match this search.")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Products" })).toBeNull();

    fireEvent.click(within(search).getByLabelText("Archived"));
    await act(settle);
    expect(api.to(`GET ${BASE}/products`).at(-1)?.query).toBe("?status=ARCHIVED&q=MALT-33");
  });

  it("appends Show more pages and keeps loaded items when a page fails", async () => {
    const second = productFixture({ name: "Peak Milk 400g" });
    const api = catalogApi().on(
      `GET ${BASE}/products`,
      json(200, { items: [PRODUCT], nextCursor: "c1" }),
      networkError,
      json(200, { items: [PRODUCT, second], nextCursor: null }),
    );
    await openCatalog(api);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await act(settle);
    expect(screen.getByRole("list", { name: "Products" }).textContent).toContain("Malt 33cl");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    await act(settle);
    const rows = within(screen.getByRole("list", { name: "Products" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(api.to(`GET ${BASE}/products`).at(-1)?.query).toBe("?after=c1&status=ACTIVE");
  });
});

describe("creating and editing products", () => {
  it("creates with an exact price and reuses the idempotency key after an unknown outcome", async () => {
    const created = productFixture({
      name: "Zobo 50cl",
      categoryId: CATEGORY.id,
      sellingPrice: { amountMinor: "35000", currency: "NGN" },
      priceVersion: 1,
    });
    const api = catalogApi()
      .on(`POST ${BASE}/products`, networkError, json(201, created))
      .on(`GET ${BASE}/products/${created.id}`, json(200, created))
      .on(`GET ${BASE}/products/${created.id}/prices`, json(200, { items: [priceEntryFixture()], nextCursor: null }))
      .on(`GET ${BASE}/products/${created.id}/packs`, json(200, EMPTY_PAGE));
    await openCatalog(api);
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Zobo 50cl" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: CATEGORY.id } });
    fireEvent.change(screen.getByLabelText("Stock unit"), { target: { value: "PIECE" } });
    fireEvent.change(screen.getByLabelText("Selling price (optional)"), { target: { value: "350.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    await act(settle);

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Try again" }));
    await act(settle);
    expect(await screen.findByRole("heading", { name: "Zobo 50cl" })).toBeDefined();
    expect(screen.getByText("Current price: 350.00 NGN")).toBeDefined();

    const sent = api.to(`POST ${BASE}/products`);
    const body = {
      name: "Zobo 50cl",
      categoryId: CATEGORY.id,
      stockUnit: "PIECE",
      trackInventory: true,
      initialPrice: { amountMinor: "35000", currency: "NGN" },
    };
    expect(sent.map((request) => request.body)).toEqual([body, body]);
    const keys = sent.map((request) => request.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "");
    expect(isUuidV7(keys[0] ?? "")).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expectNothingPersisted();
  });

  it("rejects an inexact price before sending anything", async () => {
    const api = catalogApi();
    await openCatalog(api);
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Zobo" } });
    fireEvent.change(screen.getByLabelText("Stock unit"), { target: { value: "PIECE" } });
    fireEvent.change(screen.getByLabelText("Selling price (optional)"), { target: { value: "350.505" } });
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    await act(settle);
    expect(screen.getByText(/at most 2 decimal places/u, { selector: ".field-error" })).toBeDefined();
    expect(api.to(`POST ${BASE}/products`)).toHaveLength(0);
  });

  it("keeps the draft on VERSION_CONFLICT and resubmits with the reloaded version", async () => {
    const latest = { ...PRODUCT, version: 2, sku: "MALT-33-B" };
    const saved = { ...latest, version: 3, name: "Malt 33cl can" };
    const api = catalogApi()
      .on(`GET ${BASE}/products/${PRODUCT.id}`, json(200, PRODUCT), json(200, latest), json(200, saved))
      .on(`PATCH ${BASE}/products/${PRODUCT.id}`, apiError(409, "VERSION_CONFLICT"), json(200, saved));
    await openCatalog(api);
    await openProduct();
    fireEvent.click(await screen.findByRole("button", { name: "Edit product" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Malt 33cl can" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(settle);
    expect(screen.getByRole("alert").textContent).toContain("This record changed since you opened it.");

    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await act(settle);
    expect(screen.getByText(/Latest saved values \(version 2\)/u)).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("Malt 33cl can");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(settle);

    expect(api.to(`PATCH ${BASE}/products/${PRODUCT.id}`).map((request) => request.body)).toEqual([
      { expectedVersion: 1, name: "Malt 33cl can" },
      { expectedVersion: 2, name: "Malt 33cl can" },
    ]);
    expect(await screen.findByRole("heading", { name: "Malt 33cl can" })).toBeDefined();
  });

  it("says when an edit has no changes", async () => {
    const api = catalogApi();
    await openCatalog(api);
    await openProduct();
    fireEvent.click(await screen.findByRole("button", { name: "Edit product" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("No changes to save.")).toBeDefined();
    expect(api.to(`PATCH ${BASE}/products/${PRODUCT.id}`)).toHaveLength(0);
  });

  it("archives and reactivates with the loaded version", async () => {
    const archived = { ...PRODUCT, status: "ARCHIVED" as const, version: 2 };
    const api = catalogApi()
      .on(`POST ${BASE}/products/${PRODUCT.id}/archive`, json(200, archived))
      .on(`POST ${BASE}/products/${PRODUCT.id}/reactivate`, json(200, { ...PRODUCT, version: 3 }));
    await openCatalog(api);
    await openProduct();
    fireEvent.click(await screen.findByRole("button", { name: "Archive product" }));
    await act(settle);
    expect(screen.getByText("Product archived.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reactivate product" }));
    await act(settle);
    expect(screen.getByText("Product reactivated.")).toBeDefined();
    expect(api.to(`POST ${BASE}/products/${PRODUCT.id}/archive`)[0]?.body).toEqual({ expectedVersion: 1 });
    expect(api.to(`POST ${BASE}/products/${PRODUCT.id}/reactivate`)[0]?.body).toEqual({ expectedVersion: 2 });
  });
});

describe("price and price history", () => {
  it("sets an exact price and reloads the history by version", async () => {
    const priced = { ...PRODUCT, version: 2, priceVersion: 1, sellingPrice: { amountMinor: "35000", currency: "NGN" } };
    const api = catalogApi()
      .on(`PUT ${BASE}/products/${PRODUCT.id}/price`, json(200, priced))
      .on(
        `GET ${BASE}/products/${PRODUCT.id}/prices`,
        json(200, EMPTY_PAGE),
        json(200, { items: [priceEntryFixture({ reason: "Supplier increase" })], nextCursor: null }),
      );
    await openCatalog(api);
    await openProduct();
    expect(await screen.findByText("No price has been set.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("New selling price (NGN)"), { target: { value: "350.00" } });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "Supplier increase" } });
    fireEvent.click(screen.getByRole("button", { name: "Set price" }));
    await act(settle);

    expect(api.to(`PUT ${BASE}/products/${PRODUCT.id}/price`)[0]?.body).toEqual({
      expectedVersion: 1,
      price: { amountMinor: "35000", currency: "NGN" },
      reason: "Supplier increase",
    });
    expect(screen.getByText("Price saved.")).toBeDefined();
    const history = screen.getByRole("region", { name: "Price changes (by version)" });
    const row = within(history).getByRole("row", { name: /Supplier increase/u });
    expect(row.textContent).toContain("1");
    expect(row.textContent).toContain("350.00 NGN");
  });

  it("rejects a zero price locally", async () => {
    const api = catalogApi();
    await openCatalog(api);
    await openProduct();
    fireEvent.change(await screen.findByLabelText("New selling price (NGN)"), { target: { value: "0.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Set price" }));
    expect(screen.getByText("Error: The price must be more than zero.")).toBeDefined();
    expect(api.to(`PUT ${BASE}/products/${PRODUCT.id}/price`)).toHaveLength(0);
  });
});

describe("packs", () => {
  it("adds a pack with an exact factor in the stock unit and retires it", async () => {
    const product = productFixture({ name: "Rice", stockUnit: "KG" });
    const bag = packFixture({ name: "Bag", factorMinor: "1500" });
    const api = catalogApi("OWNER", product)
      .on(
        `GET ${BASE}/products/${product.id}/packs`,
        json(200, EMPTY_PAGE),
        json(200, { items: [bag], nextCursor: null }),
        json(200, EMPTY_PAGE),
      )
      .on(`POST ${BASE}/products/${product.id}/packs`, json(201, bag))
      .on(`POST ${BASE}/packs/${bag.id}/retire`, json(200, { ...bag, status: "RETIRED" }));
    await openCatalog(api);
    await openProduct("Rice");
    const packs = await screen.findByRole("region", { name: "Packs" });
    fireEvent.change(within(packs).getByLabelText("Pack name"), { target: { value: "Bag" } });
    fireEvent.change(within(packs).getByLabelText("Quantity per pack, in KG"), { target: { value: "1.5" } });
    fireEvent.click(within(packs).getByRole("button", { name: "Add pack" }));
    await act(settle);

    const sent = api.to(`POST ${BASE}/products/${product.id}/packs`)[0];
    expect(sent?.body).toEqual({ name: "Bag", factorMinor: "1500" });
    expect(isUuidV7(sent?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "")).toBe(true);
    expect(within(packs).getByRole("row", { name: /Bag/u }).textContent).toContain("1.500 KG");

    fireEvent.click(within(packs).getByRole("button", { name: "Retire Bag" }));
    await act(settle);
    expect(api.to(`POST ${BASE}/packs/${bag.id}/retire`)[0]?.body).toEqual({});
    expect(within(packs).getByText("No packs.")).toBeDefined();
  });

  it("rejects a factor finer than the unit scale", async () => {
    const api = catalogApi();
    await openCatalog(api);
    await openProduct();
    const packs = await screen.findByRole("region", { name: "Packs" });
    fireEvent.change(within(packs).getByLabelText("Pack name"), { target: { value: "Half" } });
    fireEvent.change(within(packs).getByLabelText("Quantity per pack, in PIECE"), { target: { value: "0.5" } });
    fireEvent.click(within(packs).getByRole("button", { name: "Add pack" }));
    expect(api.to(`POST ${BASE}/products/${PRODUCT.id}/packs`)).toHaveLength(0);
  });
});

describe("categories", () => {
  it("creates, renames and archives a category", async () => {
    const created = categoryFixture({ name: "Snacks" });
    const renamed = { ...CATEGORY, name: "Soft drinks", version: 2 };
    const api = catalogApi()
      .on(`POST ${BASE}/categories`, json(201, created))
      .on(`PATCH ${BASE}/categories/${CATEGORY.id}`, json(200, renamed))
      .on(`POST ${BASE}/categories/${CATEGORY.id}/archive`, json(200, { ...renamed, status: "ARCHIVED", version: 3 }));
    await openCatalog(api);
    const nav = screen.getByRole("navigation", { name: "Catalog sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Categories" }));
    await act(settle);

    fireEvent.change(screen.getByLabelText("Category name"), { target: { value: "Snacks" } });
    fireEvent.click(screen.getByRole("button", { name: "Create category" }));
    await act(settle);
    expect(screen.getByText("Category Snacks created.")).toBeDefined();
    const post = api.to(`POST ${BASE}/categories`)[0];
    expect(post?.body).toEqual({ name: "Snacks" });
    expect(isUuidV7(post?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "")).toBe(true);

    api.on(`GET ${BASE}/categories`, json(200, { items: [renamed], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: `Rename ${CATEGORY.name}` }));
    fireEvent.change(screen.getByLabelText(`New name for ${CATEGORY.name}`), { target: { value: "Soft drinks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await act(settle);
    expect(api.to(`PATCH ${BASE}/categories/${CATEGORY.id}`)[0]?.body).toEqual({
      expectedVersion: 1,
      name: "Soft drinks",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Archive Soft drinks" }));
    await act(settle);
    expect(api.to(`POST ${BASE}/categories/${CATEGORY.id}/archive`)[0]?.body).toEqual({ expectedVersion: 2 });
  });

  it("keeps the typed name on VERSION_CONFLICT and saves it with the reloaded version", async () => {
    const latest = { ...CATEGORY, name: "Beverages", version: 2 };
    const PATCH = `PATCH ${BASE}/categories/${CATEGORY.id}`;
    const api = catalogApi()
      .on(PATCH, apiError(409, "VERSION_CONFLICT"), json(200, { ...latest, name: "Soft Drinks", version: 3 }))
      .on(`GET ${BASE}/categories/${CATEGORY.id}`, json(200, latest));
    await openCatalog(api);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Catalog sections" })).getByRole("button", { name: "Categories" }),
    );
    await act(settle);
    expect(CATEGORY.version).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Rename Drinks" }));
    fireEvent.change(screen.getByLabelText("New name for Drinks"), { target: { value: "Soft Drinks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await act(settle);
    expect(api.to(PATCH)).toHaveLength(1);
    expect(api.to(PATCH)[0]?.body).toEqual({ expectedVersion: 1, name: "Soft Drinks" });

    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    await act(settle);
    expect(api.to(`GET ${BASE}/categories/${CATEGORY.id}`)).toHaveLength(1);
    expect(api.to(PATCH)).toHaveLength(1);
    expect(screen.getByLabelText<HTMLInputElement>("New name for Beverages").value).toBe("Soft Drinks");
    expect(screen.getByRole("status").textContent).toContain("Latest saved name (version 2): Beverages.");

    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await act(settle);
    expect(api.to(PATCH)).toHaveLength(2);
    expect(api.to(PATCH)[1]?.body).toEqual({ expectedVersion: 2, name: "Soft Drinks" });
  });

  it("a rename NOT_FOUND is a neutral notice and returns to the reloaded category list", async () => {
    const api = catalogApi().on(`PATCH ${BASE}/categories/${CATEGORY.id}`, apiError(404, "NOT_FOUND"));
    await openCatalog(api);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Catalog sections" })).getByRole("button", { name: "Categories" }),
    );
    await act(settle);
    const listed = api.to(`GET ${BASE}/categories`).length;

    fireEvent.click(screen.getByRole("button", { name: "Rename Drinks" }));
    fireEvent.change(screen.getByLabelText("New name for Drinks"), { target: { value: "Soft Drinks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await act(settle);

    expect(
      screen.getByText("This item is not available. It may have been removed, or you may no longer have access to it."),
    ).toBeDefined();
    expect(screen.queryByLabelText("New name for Drinks")).toBeNull();
    expect(api.to(`GET ${BASE}/categories`).length).toBeGreaterThan(listed);
    expect(screen.getByRole("navigation", { name: "Business sections" })).toBeDefined();
  });
});

describe("NOT_FOUND semantics", () => {
  it("a missing product is a neutral notice; the business stays selected", async () => {
    const api = catalogApi().on(`GET ${BASE}/products/${PRODUCT.id}`, apiError(404, "NOT_FOUND"));
    await openCatalog(api);
    await openProduct();
    expect(
      screen.getByText("This item is not available. It may have been removed, or you may no longer have access to it."),
    ).toBeDefined();
    expect(screen.getByRole("heading", { name: "Products" })).toBeDefined();
    expect(screen.queryByText("This business is no longer available to you.")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Business sections" })).toBeDefined();
  });

  it("a business-scope NOT_FOUND offers Switch business without changing the selection itself", async () => {
    const api = catalogApi().on(`GET ${BASE}/products`, apiError(404, "NOT_FOUND"));
    await openCatalog(api);
    expect(screen.getByRole("alert").textContent).toContain("This business is no longer available to you.");
    expect(screen.getByRole("navigation", { name: "Business sections" })).toBeDefined();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Switch business" }));
    await act(settle);
    expect(await screen.findByRole("button", { name: /Ada Provisions/u })).toBeDefined();
  });
});

describe("credential boundary and persistence", () => {
  it("never renders the access token or an idempotency key and persists nothing", async () => {
    const api = catalogApi().on(`POST ${BASE}/categories`, json(201, categoryFixture({ name: "Snacks" })));
    await openCatalog(api);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Catalog sections" })).getByRole("button", { name: "Categories" }),
    );
    await act(settle);
    fireEvent.change(screen.getByLabelText("Category name"), { target: { value: "Snacks" } });
    fireEvent.click(screen.getByRole("button", { name: "Create category" }));
    await act(settle);
    const key = api.to(`POST ${BASE}/categories`)[0]?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? "";
    expect(key).not.toBe("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(key);
    expectNothingPersisted();
  });
});
