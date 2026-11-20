import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

// The disposable test database keeps data between runs, so each run uses a new local subject and business.
const run = randomBytes(6).toString("hex");
const ownerSubject = `e2e-sales-owner-${run}`;
const businessName = `Sales Provisions ${run}`;
const product = "Peak Milk 400g";
const TENDER_UNWOUND = "I confirm that the original tender has been returned or unwound as applicable.";

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

function businessSection(page: Page, name: "Overview" | "Catalog" | "Inventory" | "Sales" | "Ledger") {
  return page.getByRole("navigation", { name: "Business sections" }).getByRole("button", { name, exact: true });
}

function inventorySection(page: Page, name: "Stock" | "Needs valuation") {
  return page.getByRole("navigation", { name: "Inventory sections" }).getByRole("button", { name, exact: true });
}

function salesSection(page: Page, name: "Sell" | "Sales") {
  return page.getByRole("navigation", { name: "Sales sections" }).getByRole("button", { name, exact: true });
}

function fact(page: Page, term: string) {
  return page.locator("dt", { hasText: new RegExp(`^${term}$`, "u") }).locator("xpath=following-sibling::dd[1]");
}

async function openItem(page: Page): Promise<void> {
  await businessSection(page, "Inventory").click();
  await inventorySection(page, "Stock").click();
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await expect(page.getByRole("heading", { level: 3, name: product, exact: true })).toBeVisible();
}

test("an owner values stock, sells for cash, reverses the sale and reads the ledger", async ({ page }) => {
  // One user and about forty API round trips; each assertion keeps the default 5 s timeout.
  test.setTimeout(180_000);
  await page.goto("/");
  const ownerToken = await signInAndRegister(page, ownerSubject, "Amaka Obi");
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  // A stock-tracked product with a selling price
  await businessSection(page, "Catalog").click();
  await page.getByRole("button", { name: "Create product" }).click();
  await page.getByLabel("Name", { exact: true }).fill(product);
  await page.getByLabel("Stock unit").selectOption("PIECE");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { level: 3, name: product, exact: true })).toBeVisible();
  await page.getByLabel("New selling price (NGN)").fill("500.00");
  await page.getByRole("button", { name: "Set price" }).click();
  await expect(page.getByText("Price saved.")).toBeVisible();

  // Opening stock without a cost leaves the item needing valuation
  await openItem(page);
  await page.getByRole("button", { name: "Record opening stock" }).click();
  await page.getByLabel("Quantity (PIECE)").fill("20");
  const opening = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/inventory/opening-stock"),
  );
  await page.getByRole("button", { name: "Record opening stock", exact: true }).click();
  expect((await opening).status()).toBe(201);
  await expect(page.getByRole("heading", { level: 3, name: "Opening stock", exact: true })).toBeVisible();

  // Valuation through the UI: keyed, at the balance version shown; the item leaves Needs valuation
  await inventorySection(page, "Needs valuation").click();
  const needing = page.getByRole("list", { name: "Stock needing valuation" });
  await expect(needing).toContainText(product);
  await expect(needing).toContainText("Cost unknown");
  await page.getByRole("button", { name: `Value stock of ${product}` }).click();
  await page.getByLabel("Total value (NGN)").fill("2000.00");
  await page.getByLabel("Reason", { exact: true }).fill("Opening count valued at supplier invoice");
  const valuation = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith("/inventory/valuations"),
  );
  await page.getByRole("button", { name: "Record valuation" }).click();
  const valuationRequest = await valuation;
  expect(valuationRequest.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(valuationRequest.postDataJSON()).toMatchObject({
    newTotalValue: { amountMinor: "200000", currency: "NGN" },
    reason: "Opening count valued at supplier invoice",
  });
  await expect(page.getByText("Opening valuation recorded.")).toBeVisible();
  await expect(page.getByText("No stock needs valuation.")).toBeVisible();

  // Sell 2 for cash; the receipt shows only what Tali calculated
  await businessSection(page, "Sales").click();
  await expect(page.getByText("Final total is calculated by Tali when the sale is recorded.")).toBeVisible();
  await page.getByLabel("Find a product").fill("milk");
  const search = page.waitForRequest(
    (request) => request.method() === "GET" && /\/products\?.*status=ACTIVE/u.test(request.url()),
  );
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect(new URL((await search).url()).searchParams.get("q")).toBe("milk");
  await page.getByRole("button", { name: `Add ${product}` }).click();
  await page.getByLabel("Quantity (PIECE)").fill("2");
  await page.getByLabel("Amount (NGN)").fill("1000.00");
  await page.getByLabel("Cash received (NGN, optional)").fill("1500.00");
  const sale = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/sales"));
  await page.getByRole("button", { name: "Record sale" }).click();
  const saleRequest = await sale;
  const saleBody = saleRequest.postDataJSON() as { saleId: string };
  expect(Object.keys(saleBody).sort()).toEqual(["lines", "saleId", "tenders"]);
  expect(saleRequest.headers()["idempotency-key"]).toBe(saleBody.saleId);
  await expect(page.getByText("Sale recorded.")).toBeVisible();
  const receiptNumber = (await fact(page, "Receipt number").textContent()) ?? "";
  expect(receiptNumber).not.toBe("");
  await expect(fact(page, "Status")).toHaveText("Posted");
  await expect(fact(page, "Total")).toHaveText("1,000.00 NGN");
  await expect(fact(page, "Cost of goods sold")).toHaveText("200.00 NGN");
  const tenders = page.getByRole("list", { name: "Tenders" });
  await expect(tenders).toContainText("Cash received: 1,500.00 NGN");
  await expect(tenders).toContainText("Change: 500.00 NGN");

  // Stock went down by a Sale movement
  await openItem(page);
  await expect(fact(page, "On hand")).toHaveText("18 PIECE");
  const history = page.getByRole("table", { name: "Stock history" });
  await expect(history.getByRole("row", { name: /Sale/u }).first()).toContainText("-2 PIECE");

  // Sales history and detail, then the full reversal (an error correction, not a refund)
  await businessSection(page, "Sales").click();
  await salesSection(page, "Sales").click();
  await page.getByRole("button", { name: `Open sale ${receiptNumber}` }).click();
  await expect(fact(page, "Receipt number")).toHaveText(receiptNumber);
  await page.getByLabel("Reason for the correction").fill("Rang up the wrong customer basket");
  await page.getByRole("button", { name: "Reverse sale" }).click();
  await expect(page.getByText("Confirm that the original tender has been returned or unwound.")).toBeVisible();
  await page.getByLabel(TENDER_UNWOUND).check();
  const reversal = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(`/sales/${saleBody.saleId}/reversal`),
  );
  await page.getByRole("button", { name: "Reverse sale" }).click();
  const reversalRequest = await reversal;
  expect(reversalRequest.postDataJSON()).toEqual({
    reason: "Rang up the wrong customer basket",
    tenderUnwoundConfirmed: true,
  });
  expect(reversalRequest.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(reversalRequest.headers()["idempotency-key"]).not.toBe(saleBody.saleId);
  await expect(page.getByText("Sale reversed.")).toBeVisible();
  await expect(fact(page, "Status")).toHaveText("Reversed");
  await expect(page.getByRole("button", { name: "Reverse sale" })).toHaveCount(0);

  // Stock is restored by a Sale (reversal) movement
  await openItem(page);
  await expect(fact(page, "On hand")).toHaveText("20 PIECE");
  await expect(page.getByRole("table", { name: "Stock history" })).toContainText("Sale (reversal)");

  // Read-only ledger; valuation is complete, so no incomplete notice
  await businessSection(page, "Ledger").click();
  await expect(page.getByRole("table", { name: "Ledger accounts" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Account balances" })).toBeVisible();
  await expect(page.getByText("Inventory valuation completeness could not be checked.")).toHaveCount(0);
  await expect(page.getByText(/Inventory value is incomplete/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Post|Edit|Delete/u })).toHaveCount(0);

  await expectNothingStored(page, ownerToken);
});
