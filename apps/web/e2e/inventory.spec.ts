import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

// The disposable test database keeps data between runs, so each run uses new local subjects and values.
const run = randomBytes(6).toString("hex");
const ownerSubject = `e2e-inventory-owner-${run}`;
const keeperSubject = `e2e-inventory-keeper-${run}`;
const businessName = `Inventory Provisions ${run}`;
const product = "Rice 1kg";
const STALE_MESSAGE = "Some stock changed while you were counting. Recount the affected items before posting.";

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

function inventorySection(page: Page, name: "Stock" | "Stocktakes") {
  return page.getByRole("navigation", { name: "Inventory sections" }).getByRole("button", { name, exact: true });
}

/** Every inventory write is keyed or versioned, and never names a location (the API resolves it). */
function inventoryWrite(page: Page, method: "POST" | "PUT", path: RegExp) {
  return page.waitForRequest(
    (request) =>
      request.method() === method &&
      request.url().includes("/inventory/") &&
      path.test(new URL(request.url()).pathname),
  );
}

function expectNoLocation(body: unknown): void {
  expect(JSON.stringify(body ?? {})).not.toContain("locationId");
}

async function openItem(page: Page): Promise<void> {
  await inventorySection(page, "Stock").click();
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await expect(page.getByRole("heading", { level: 3, name: product })).toBeVisible();
}

function fact(page: Page, term: string) {
  return page.locator("dt", { hasText: new RegExp(`^${term}$`, "u") }).locator("xpath=following-sibling::dd[1]");
}

test("an owner runs stock, thresholds, reversals and stocktakes; a stock keeper counts blind", async ({
  browser,
  page,
}) => {
  // Two users and about seventy API round trips; each assertion keeps the default 5 s timeout.
  test.setTimeout(180_000);
  await page.goto("/");
  const ownerToken = await signInAndRegister(page, ownerSubject, "Ngozi Eze");
  await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
  await page.getByLabel("Business name").fill(businessName);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  // A stock-tracked product
  await businessSection(page, "Catalog").click();
  await page.getByRole("button", { name: "Create product" }).click();
  await page.getByLabel("Name", { exact: true }).fill(product);
  await page.getByLabel("Stock unit").selectOption("PIECE");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { level: 3, name: product })).toBeVisible();

  // Stock list
  await businessSection(page, "Inventory").click();
  await expect(page.getByRole("heading", { level: 2, name: "Inventory" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Stock items" })).toContainText(product);
  await openItem(page);

  // Opening stock: keyed, no location, never reversible
  await page.getByRole("button", { name: "Record opening stock" }).click();
  await page.getByLabel("Quantity (PIECE)").fill("20");
  const opening = inventoryWrite(page, "POST", /\/opening-stock$/u);
  await page.getByRole("button", { name: "Record opening stock", exact: true }).click();
  const openingRequest = await opening;
  expect(openingRequest.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
  expectNoLocation(openingRequest.postDataJSON());
  await expect(page.getByRole("heading", { level: 3, name: "Opening stock" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Reverse/u })).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(fact(page, "On hand")).toHaveText("20 PIECE");
  await expect(fact(page, "Low stock")).toHaveText("No");

  // Threshold set from version 0; LOW STOCK comes from the API
  await page.getByLabel("Threshold (PIECE)").fill("25");
  const setThreshold = inventoryWrite(page, "PUT", /\/threshold$/u);
  await page.getByRole("button", { name: "Set threshold" }).click();
  const setBody = (await setThreshold).postDataJSON() as unknown;
  expect(setBody).toMatchObject({ expectedVersion: 0 });
  expectNoLocation(setBody);
  await expect(page.getByText("Threshold saved.")).toBeVisible();
  await expect(fact(page, "Low-stock threshold")).toHaveText("25 PIECE");
  await expect(fact(page, "Low stock")).toHaveText("LOW STOCK");

  // Goods receipt, then its reversal (reason and confirmation)
  await page.getByRole("button", { name: "Receive stock" }).click();
  await page.getByLabel("Quantity (PIECE)").fill("10");
  await page.getByLabel("Reference (optional)").fill(`INV-${run}`);
  const receipt = inventoryWrite(page, "POST", /\/goods-receipts$/u);
  await page.getByRole("button", { name: "Receive stock", exact: true }).click();
  expectNoLocation((await receipt).postDataJSON());
  await expect(page.getByRole("heading", { level: 3, name: "Goods receipt" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Stock movements" })).toContainText("+10 PIECE");
  await page.getByRole("button", { name: "Reverse receipt" }).click();
  await expect(page.getByText("Enter a reason for reversing.")).toBeVisible();
  await page.getByLabel("Reason for reversing").fill("Delivered to the wrong shop");
  await page.getByRole("button", { name: "Reverse receipt" }).click();
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByText("The goods receipt was reversed.")).toBeVisible();
  await expect(fact(page, "Status")).toHaveText("Reversed");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(fact(page, "On hand")).toHaveText("20 PIECE");

  // Adjustment with an explicit direction
  await page.getByRole("button", { name: "Adjust stock" }).click();
  await page.getByRole("radio", { name: "Decrease" }).check();
  await page.getByLabel("Quantity (PIECE)").fill("2");
  await page.getByLabel("Reason", { exact: true }).selectOption("DATA_ENTRY_CORRECTION");
  const adjustment = inventoryWrite(page, "POST", /\/adjustments$/u);
  await page.getByRole("button", { name: "Adjust stock", exact: true }).click();
  expect((await adjustment).postDataJSON()).toMatchObject({
    reasonCode: "DATA_ENTRY_CORRECTION",
    lines: [{ direction: "DECREASE" }],
  });
  await expect(page.getByRole("heading", { level: 3, name: "Adjustment" })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(fact(page, "On hand")).toHaveText("18 PIECE");

  // Write-off, then its reversal
  await page.getByRole("button", { name: "Write off stock" }).click();
  await page.getByLabel("Quantity written off (PIECE)").fill("1");
  await page.getByLabel("Reason", { exact: true }).selectOption("DAMAGED");
  await page.getByRole("button", { name: "Write off stock", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Write-off" })).toBeVisible();
  await page.getByLabel("Reason for reversing").fill("Bag was not damaged after all");
  await page.getByRole("button", { name: "Reverse write-off" }).click();
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByText("The write-off was reversed.")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(fact(page, "On hand")).toHaveText("18 PIECE");
  const history = page.getByRole("table", { name: "Stock history" });
  for (const text of ["Opening stock", "Stock received", "Adjustment", "Write-off", "(reversal)"]) {
    await expect(history).toContainText(text);
  }

  // Server-side low-stock filter
  await page.getByRole("button", { name: "Back to stock" }).click();
  const filtered = page.waitForResponse(
    (response) => response.request().method() === "GET" && response.url().includes("lowStock=true"),
  );
  await page.getByLabel("Low stock only").check();
  expect((await filtered).status()).toBe(200);
  await expect(page.getByRole("list", { name: "Stock items" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Stock items" })).toContainText("LOW STOCK");
  await page.getByLabel("Low stock only").uncheck();
  await expect(page.getByLabel("Low stock only")).not.toBeChecked();
  await expect(page.getByRole("list", { name: "Stock items" })).toContainText(product);

  // Change the threshold (version 1), then clear it (version 2)
  await page.getByRole("button", { name: `Open ${product}` }).click();
  await page.getByLabel("New threshold (PIECE)").fill("5");
  const changeThreshold = inventoryWrite(page, "PUT", /\/threshold$/u);
  await page.getByRole("button", { name: "Change threshold" }).click();
  expect((await changeThreshold).postDataJSON()).toMatchObject({ expectedVersion: 1 });
  await expect(fact(page, "Low stock")).toHaveText("No");
  const clearThreshold = inventoryWrite(page, "POST", /\/threshold\/clear$/u);
  await page.getByRole("button", { name: "Clear threshold" }).click();
  expect((await clearThreshold).postDataJSON()).toMatchObject({ expectedVersion: 2 });
  await expect(page.getByText("Threshold cleared.")).toBeVisible();
  await expect(fact(page, "Low-stock threshold")).toHaveText("Not set");

  // Stocktake (FULL for an owner): count, then stock changes, so posting is STOCKTAKE_STALE
  await inventorySection(page, "Stocktakes").click();
  await page.getByRole("button", { name: "Start stocktake" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Stocktake" })).toBeVisible();
  await page.getByRole("textbox", { name: "Find an item to count" }).fill(product);
  await page.getByRole("button", { name: "Find item" }).click();
  await page.getByRole("button", { name: `Choose ${product}` }).click();
  await page.getByLabel("Counted quantity (PIECE)").fill("15");
  await page.getByRole("button", { name: "Save count" }).click();
  await expect(page.getByText(`Count saved for ${product}.`)).toBeVisible();
  const counted = page.getByRole("table", { name: "Counted items" });
  await expect(counted.getByRole("columnheader", { name: "Expected" })).toBeVisible();
  await expect(counted.getByRole("row", { name: new RegExp(product, "u") })).toContainText("18 PIECE");

  await openItem(page);
  await page.getByRole("button", { name: "Receive stock" }).click();
  await page.getByLabel("Quantity (PIECE)").fill("1");
  await page.getByRole("button", { name: "Receive stock", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Goods receipt" })).toBeVisible();

  await inventorySection(page, "Stocktakes").click();
  await page
    .getByRole("list", { name: "Stocktakes" })
    .getByRole("button", { name: /^Open stocktake started/u })
    .first()
    .click();
  await page.getByRole("button", { name: "Post stocktake" }).click();
  await page.getByRole("button", { name: "Confirm post" }).click();
  await expect(page.getByRole("alert").filter({ hasText: STALE_MESSAGE })).toBeVisible();
  await expect(counted.getByRole("row", { name: new RegExp(product, "u") })).toContainText(
    "Stock changed while counting. Recount.",
  );
  await expect(fact(page, "Status")).toHaveText("In progress");

  await page.getByRole("button", { name: `Recount ${product}` }).click();
  await page.getByLabel("Counted quantity (PIECE)").fill("15");
  const recount = inventoryWrite(page, "PUT", /\/stocktakes\/[^/]+\/lines\/[^/]+$/u);
  await page.getByRole("button", { name: "Save count" }).click();
  expect((await recount).postDataJSON()).toMatchObject({ expectedVersion: 1 });
  await expect(page.getByText(STALE_MESSAGE)).toHaveCount(0);
  await page.getByRole("button", { name: "Post stocktake" }).click();
  await page.getByRole("button", { name: "Confirm post" }).click();
  await expect(page.getByText("Stocktake posted. Stock now matches the counts.")).toBeVisible();
  await expect(fact(page, "Status")).toHaveText("Posted");
  await expect(fact(page, "Result")).toHaveText("1 stock correction, 0 with no difference");
  await openItem(page);
  await expect(fact(page, "On hand")).toHaveText("15 PIECE");
  await expect(page.getByRole("table", { name: "Stock history" })).toContainText("Stocktake correction");

  // A second stocktake; starting another meets the one in progress
  await inventorySection(page, "Stocktakes").click();
  await page.getByRole("button", { name: "Start stocktake" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Stocktake" })).toBeVisible();
  await page.getByRole("button", { name: "Back to stocktakes" }).click();
  await page.getByRole("button", { name: "Start stocktake" }).click();
  await expect(
    page.getByText("A stocktake is already in progress. Finish or cancel it before starting another."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open the stocktake in progress" }).click();
  await expect(fact(page, "Status")).toHaveText("In progress");
  await expectNothingStored(page, ownerToken);

  // Invite a stock keeper
  await businessSection(page, "Overview").click();
  const panel = page.getByRole("region", { name: "Invite someone" });
  await panel.getByLabel("Role").selectOption("STOCK_KEEPER");
  await panel.getByRole("button", { name: "Create invitation link" }).click();
  const link = await panel.getByLabel("Invitation link").inputValue();
  await panel.getByRole("button", { name: "Done" }).click();

  const keeperContext = await browser.newContext({ timezoneId: "Africa/Lagos" });
  const keeper = await keeperContext.newPage();
  await keeper.goto(link);
  const keeperToken = await signInAndRegister(keeper, keeperSubject, "Tunde Bello");
  await keeper.getByRole("button", { name: "Accept invitation" }).click();
  await expect(keeper.getByText("Invitation accepted. The business is now in your list.")).toBeVisible();
  await keeper.getByRole("button", { name: new RegExp(businessName, "u") }).click();
  await expect(keeper.getByRole("heading", { level: 2, name: businessName })).toBeVisible();

  // The stock keeper receives and counts, but cannot adjust, post or cancel, and never sees expected quantities
  await businessSection(keeper, "Inventory").click();
  await expect(keeper.getByRole("button", { name: "Receive stock" })).toBeVisible();
  for (const name of ["Record opening stock", "Adjust stock", "Write off stock"]) {
    await expect(keeper.getByRole("button", { name })).toHaveCount(0);
  }
  await inventorySection(keeper, "Stocktakes").click();
  await keeper
    .getByRole("list", { name: "Stocktakes" })
    .getByRole("listitem")
    .filter({ hasText: "In progress" })
    .getByRole("button", { name: /^Open stocktake started/u })
    .click();
  await expect(keeper.getByText("Expected quantities are not shown while counting.")).toBeVisible();
  await keeper.getByRole("textbox", { name: "Find an item to count" }).fill(product);
  await keeper.getByRole("button", { name: "Find item" }).click();
  await keeper.getByRole("button", { name: `Choose ${product}` }).click();
  await keeper.getByLabel("Counted quantity (PIECE)").fill("14");
  const blindCount = keeper.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /\/stocktakes\/[^/]+\/lines\/[^/]+$/u.test(new URL(response.url()).pathname),
  );
  await keeper.getByRole("button", { name: "Save count" }).click();
  const blindBody = JSON.stringify(await (await blindCount).json());
  expect(blindBody).not.toContain("expectedAtCount");
  expect(blindBody).not.toContain("variance");
  await expect(keeper.getByText(`Count saved for ${product}.`)).toBeVisible();
  const blind = keeper.getByRole("table", { name: "Counted items" });
  await expect(blind).toContainText("14 PIECE");
  await expect(blind.getByRole("columnheader", { name: "Expected" })).toHaveCount(0);
  await expect(blind.getByRole("columnheader", { name: "Difference" })).toHaveCount(0);
  await expect(blind).not.toContainText("15 PIECE");
  for (const name of ["Post stocktake", "Cancel stocktake"]) {
    await expect(keeper.getByRole("button", { name })).toHaveCount(0);
  }
  await expectNothingStored(keeper, keeperToken);
  await keeperContext.close();

  // The owner cancels the stocktake the keeper counted; no stock changes
  await businessSection(page, "Inventory").click();
  await inventorySection(page, "Stocktakes").click();
  await page
    .getByRole("list", { name: "Stocktakes" })
    .getByRole("listitem")
    .filter({ hasText: "In progress" })
    .getByRole("button", { name: /^Open stocktake started/u })
    .click();
  await expect(page.getByRole("table", { name: "Counted items" })).toContainText("14 PIECE");
  await page.getByRole("button", { name: "Cancel stocktake" }).click();
  await page.getByLabel("Reason (optional)").fill("Counted on the wrong day");
  await page.getByRole("button", { name: "Confirm cancel" }).click();
  await expect(page.getByText("Stocktake cancelled. No stock was changed.")).toBeVisible();
  await expect(fact(page, "Status")).toHaveText("Cancelled");
  await openItem(page);
  await expect(fact(page, "On hand")).toHaveText("15 PIECE");
  await expectNothingStored(page, ownerToken);
});
