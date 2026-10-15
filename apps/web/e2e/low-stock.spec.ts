import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

// The disposable test database keeps data between runs, so each run uses a new local subject and business.
const run = randomBytes(6).toString("hex");
const ownerSubject = `e2e-low-stock-owner-${run}`;
const businessName = `Low Stock Provisions ${run}`;
const product = "Sugar 500g";

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

function businessSection(page: Page, name: "Overview" | "Catalog" | "Inventory") {
  return page.getByRole("navigation", { name: "Business sections" }).getByRole("button", { name, exact: true });
}

function fact(page: Page, term: string) {
  return page.locator("dt", { hasText: new RegExp(`^${term}$`, "u") }).locator("xpath=following-sibling::dd[1]");
}

function stockRow(page: Page) {
  return page.getByRole("list", { name: "Stock items" }).getByRole("listitem").filter({ hasText: product });
}

/** What the API says, read directly with the owner's token; the UI badge must agree with it. */
async function apiItem(page: Page, token: string, lowStockOnly = false) {
  const headers = { authorization: `Bearer ${token}` };
  const memberships = (await (await page.request.get(`${E2E.apiOrigin}/v1/me/businesses`, { headers })).json()) as {
    items: { business: { id: string; name: string } }[];
  };
  const businessId = memberships.items.find((entry) => entry.business.name === businessName)?.business.id;
  expect(businessId).toBeDefined();
  const query = lowStockOnly ? "?lowStock=true" : `?q=${encodeURIComponent(product)}`;
  const response = await page.request.get(
    `${E2E.apiOrigin}/v1/businesses/${businessId ?? ""}/inventory/balances${query}`,
    { headers },
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    items: { name: string; lowStock: boolean; productStatus: string; onHand: { quantityMinor: string } }[];
  };
  return body.items.filter((item) => item.name === product);
}

/** The list badge and the item fact both match the API boolean, and the on-hand quantity is as expected. */
async function expectLowStock(page: Page, token: string, lowStock: boolean, onHand: string): Promise<void> {
  const [item] = await apiItem(page, token);
  expect(item).toMatchObject({ lowStock, onHand: { quantityMinor: onHand } });
  await page.getByRole("button", { name: "Back to stock" }).click();
  await expect(stockRow(page)).toContainText(`On hand: ${onHand} PIECE`);
  await expect(stockRow(page).getByText("LOW STOCK")).toHaveCount(lowStock ? 1 : 0);
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await expect(page.getByRole("heading", { level: 3, name: product })).toBeVisible();
  await expect(fact(page, "On hand")).toHaveText(`${onHand} PIECE`);
  await expect(fact(page, "Low stock")).toHaveText(lowStock ? "LOW STOCK" : "No");
}

async function adjustDown(page: Page, quantity: string): Promise<void> {
  await page.getByRole("button", { name: "Adjust stock" }).click();
  await page.getByRole("radio", { name: "Decrease" }).check();
  await page.getByLabel("Quantity (PIECE)").fill(quantity);
  await page.getByLabel("Reason", { exact: true }).selectOption("DATA_ENTRY_CORRECTION");
  await page.getByRole("button", { name: "Adjust stock", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Adjustment" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
}

test("LOW STOCK follows the API through threshold, adjustment, receipt and archive", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const token = await signInAndRegister(page, ownerSubject, "Amaka Obi");
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  await businessSection(page, "Catalog").click();
  await page.getByRole("button", { name: "Create product" }).click();
  await page.getByLabel("Name", { exact: true }).fill(product);
  await page.getByLabel("Stock unit").selectOption("PIECE");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { level: 3, name: product })).toBeVisible();

  await businessSection(page, "Inventory").click();
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await expect(page.getByRole("heading", { level: 3, name: product })).toBeVisible();

  // Threshold 10, opening 15: not low
  await page.getByLabel("Threshold (PIECE)").fill("10");
  await page.getByRole("button", { name: "Set threshold" }).click();
  await expect(page.getByText("Threshold saved.")).toBeVisible();
  await page.getByRole("button", { name: "Record opening stock" }).click();
  await page.getByLabel("Quantity (PIECE)").fill("15");
  await page.getByRole("button", { name: "Record opening stock", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Opening stock" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expectLowStock(page, token, false, "15");

  // Decrease 5: on hand equals the threshold, so low
  await adjustDown(page, "5");
  await expectLowStock(page, token, true, "10");

  // Receive 3: above the threshold again, so the badge clears
  await page.getByRole("button", { name: "Receive stock" }).click();
  await page.getByLabel("Quantity (PIECE)").fill("3");
  await page.getByRole("button", { name: "Receive stock", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Goods receipt" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expectLowStock(page, token, false, "13");

  // Decrease to 5: low, and in the low-stock filter
  await adjustDown(page, "8");
  await expectLowStock(page, token, true, "5");
  expect(await apiItem(page, token, true)).toHaveLength(1);

  // Archive: still listed and marked Archived, never LOW STOCK, absent from lowStock=true
  await businessSection(page, "Catalog").click();
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await page.getByRole("button", { name: "Archive product" }).click();
  await expect(page.getByText("Product archived.")).toBeVisible();
  await businessSection(page, "Inventory").click();
  await expect(stockRow(page)).toContainText("Archived");
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await expectLowStock(page, token, false, "5");
  expect((await apiItem(page, token))[0]?.productStatus).toBe("ARCHIVED");
  expect(await apiItem(page, token, true)).toHaveLength(0);
  await page.getByRole("button", { name: "Back to stock" }).click();
  const filtered = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().includes("lowStock=true"),
  );
  await page.getByLabel("Low stock only").check();
  expect((await filtered).status()).toBe(200);
  await expect(stockRow(page)).toHaveCount(0);
  await expectNothingStored(page, token);
});
