import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

// The disposable test database keeps data between runs, so each run uses new local subjects and values.
const run = randomBytes(6).toString("hex");
const ownerSubject = `e2e-catalog-owner-${run}`;
const cashierSubject = `e2e-catalog-cashier-${run}`;
const businessName = `Catalog Provisions ${run}`;
const sku = `MALT-${run}`;
const barcode = `BC-${run}`;

test.use({ timezoneId: "Africa/Lagos" });

async function signInAndRegister(page: Page, subject: string, displayName: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Local development sign-in" })).toBeVisible();
  const signInResponse = page.waitForResponse(`${E2E.apiOrigin}/__local/sign-in`);
  await page.getByLabel("Local subject").fill(subject);
  await page.getByRole("button", { name: "Sign in (local development)" }).click();
  const body = (await (await signInResponse).json()) as { accessToken: string };
  await expect(page.getByRole("heading", { name: "Set up your profile" })).toBeVisible();
  await page.getByLabel("Your name").fill(displayName);
  await page.getByRole("button", { name: "Continue" }).click();
  return body.accessToken;
}

async function expectNothingStored(page: Page, secret: string): Promise<void> {
  expect(await page.context().cookies()).toEqual([]);
  const stored = await page.evaluate(async () => {
    const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    return {
      local: window.localStorage.length,
      session: window.sessionStorage.length,
      cookie: document.cookie,
      indexedDb: databases.length,
    };
  });
  expect(stored).toEqual({ local: 0, session: 0, cookie: "", indexedDb: 0 });
  expect(await page.content()).not.toContain(secret);
}

async function openCatalog(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Business sections" }).getByRole("button", { name: "Catalog" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Catalog" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Products" })).toBeVisible();
}

test("an owner manages the catalog end to end and an invited cashier sees it read-only", async ({ browser, page }) => {
  // Two users and about forty API round trips; each assertion keeps the default 5 s timeout.
  test.setTimeout(120_000);
  await page.goto("/");
  const ownerToken = await signInAndRegister(page, ownerSubject, "Ngozi Eze");
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  await openCatalog(page);
  await expect(page.getByText("No products yet.")).toBeVisible();

  // Category
  await page.getByRole("navigation", { name: "Catalog sections" }).getByRole("button", { name: "Categories" }).click();
  await page.getByLabel("Category name").fill("Drinks");
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.getByText("Category Drinks created.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Categories" })).toContainText("Drinks");

  // Product with SKU, barcode, unit and category
  await page.getByRole("navigation", { name: "Catalog sections" }).getByRole("button", { name: "Products" }).click();
  await page.getByRole("button", { name: "Create product" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Malt 33cl");
  await page.getByLabel("Category").selectOption({ label: "Drinks" });
  await page.getByLabel("SKU (optional)").fill(sku);
  await page.getByLabel("Barcode (optional)").fill(barcode);
  await page.getByLabel("Stock unit").selectOption("PIECE");
  const created = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/products"),
  );
  await page.getByRole("button", { name: "Create product" }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  expect(createdResponse.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(page.getByRole("heading", { level: 3, name: "Malt 33cl" })).toBeVisible();
  await expect(page.getByText("Drinks", { exact: true })).toBeVisible();

  // Search by SKU (server-side)
  await page.getByRole("button", { name: "Back to products" }).click();
  await page.getByLabel("Search name, SKU or barcode").fill(sku);
  const searched = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().includes(`q=${sku}`),
  );
  await page.getByRole("button", { name: "Search" }).click();
  expect((await searched).status()).toBe(200);
  await expect(page.getByRole("list", { name: "Products" })).toContainText(sku);

  // Edit
  await page.getByRole("button", { name: "Open Malt 33cl" }).click();
  await page.getByRole("button", { name: "Edit product" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Malt 33cl bottle");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Malt 33cl bottle" })).toBeVisible();

  // Price and history
  await page.getByLabel("New selling price (NGN)").fill("350.00");
  const priced = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith("/price"));
  await page.getByRole("button", { name: "Set price" }).click();
  expect((await priced).postDataJSON()).toMatchObject({ price: { amountMinor: "35000", currency: "NGN" } });
  await expect(page.getByText("Price saved.")).toBeVisible();
  await expect(page.getByText("Current price: 350.00 NGN")).toBeVisible();
  const history = page.getByRole("region", { name: "Price changes (by version)" });
  await expect(history.getByRole("row", { name: /350\.00 NGN/u })).toContainText("1");

  // Pack, then retire it
  const packs = page.getByRole("region", { name: "Packs" });
  await packs.getByLabel("Pack name").fill("Crate");
  await packs.getByLabel("Quantity per pack, in PIECE").fill("24");
  await packs.getByRole("button", { name: "Add pack" }).click();
  await expect(packs.getByRole("row", { name: /Crate/u })).toContainText("24 PIECE");
  await packs.getByRole("button", { name: "Retire Crate" }).click();
  await expect(packs.getByText("No packs.")).toBeVisible();

  // Archive and reactivate
  await page.getByRole("button", { name: "Archive product" }).click();
  await expect(page.getByText("Product archived.")).toBeVisible();
  await page.getByRole("button", { name: "Reactivate product" }).click();
  await expect(page.getByText("Product reactivated.")).toBeVisible();
  await expectNothingStored(page, ownerToken);

  // Invite a cashier from the Overview section
  await page.getByRole("navigation", { name: "Business sections" }).getByRole("button", { name: "Overview" }).click();
  const panel = page.getByRole("region", { name: "Invite someone" });
  await panel.getByLabel("Role").selectOption("CASHIER");
  await panel.getByRole("button", { name: "Create invitation link" }).click();
  const link = await panel.getByLabel("Invitation link").inputValue();
  await panel.getByRole("button", { name: "Done" }).click();

  const cashierContext = await browser.newContext({ timezoneId: "Africa/Lagos" });
  const cashier = await cashierContext.newPage();
  await cashier.goto(link);
  const cashierToken = await signInAndRegister(cashier, cashierSubject, "Tunde Bello");
  await cashier.getByRole("button", { name: "Accept invitation" }).click();
  await expect(cashier.getByText("Invitation accepted. The business is now in your list.")).toBeVisible();
  await cashier.getByRole("button", { name: new RegExp(businessName, "u") }).click();
  await expect(cashier.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  // Read-only catalog for the cashier
  await openCatalog(cashier);
  await expect(cashier.getByRole("list", { name: "Products" })).toContainText("Malt 33cl bottle");
  await expect(cashier.getByRole("button", { name: "Create product" })).toHaveCount(0);
  await cashier.getByRole("button", { name: "Open Malt 33cl bottle" }).click();
  await expect(cashier.getByRole("heading", { level: 3, name: "Malt 33cl bottle" })).toBeVisible();
  await expect(cashier.getByText("Current price: 350.00 NGN")).toBeVisible();
  for (const name of ["Edit product", "Archive product", "Set price", "Add pack"]) {
    await expect(cashier.getByRole("button", { name })).toHaveCount(0);
  }
  await cashier
    .getByRole("navigation", { name: "Catalog sections" })
    .getByRole("button", { name: "Categories" })
    .click();
  await expect(cashier.getByRole("list", { name: "Categories" })).toContainText("Drinks");
  await expect(cashier.getByRole("button", { name: "Create category" })).toHaveCount(0);
  await expect(cashier.getByRole("button", { name: "Rename Drinks" })).toHaveCount(0);
  await expectNothingStored(cashier, cashierToken);
  await cashierContext.close();
});
