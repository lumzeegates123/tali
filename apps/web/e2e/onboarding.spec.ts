import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

// The disposable test database keeps data between runs, so each run signs in as a new local subject.
const subject = `e2e-owner-${randomBytes(6).toString("hex")}`;

test.use({ timezoneId: "Africa/Lagos" });

async function signIn(page: Page, localSubject: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Local development sign-in" })).toBeVisible();
  const signInResponse = page.waitForResponse(`${E2E.apiOrigin}/__local/sign-in`);
  await page.getByLabel("Local subject").fill(localSubject);
  await page.getByRole("button", { name: "Sign in (local development)" }).click();
  const body = (await (await signInResponse).json()) as { accessToken: string };
  expect(body.accessToken.length).toBeGreaterThan(20);
  return body.accessToken;
}

async function expectNothingPersisted(page: Page, token: string): Promise<void> {
  expect(await page.context().cookies()).toEqual([]);
  const stored = await page.evaluate(() => ({
    local: Object.keys(window.localStorage),
    session: Object.keys(window.sessionStorage),
    cookie: document.cookie,
  }));
  expect(stored).toEqual({ local: [], session: [], cookie: "" });
  expect(page.url()).not.toContain(token);
  expect(await page.content()).not.toContain(token);
}

test.describe("web onboarding against the real API", () => {
  test.describe.configure({ mode: "serial" });

  test("a new local user registers, creates a business, sees its overview and members, and signs out", async ({
    page,
  }) => {
    await page.goto("/");
    const token = await signIn(page, subject);

    await expect(page.getByRole("heading", { name: "Set up your profile" })).toBeVisible();
    await page.getByLabel("Your name").fill("Ada Okafor");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Create your first business" })).toBeVisible();
    await expect(page.getByLabel("Time zone")).toHaveValue("Africa/Lagos");
    await page.getByLabel("Business name").fill("Ada Provisions");
    const createRequest = page.waitForRequest(
      (request) => request.method() === "POST" && request.url() === `${E2E.apiOrigin}/v1/businesses`,
    );
    const createResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url() === `${E2E.apiOrigin}/v1/businesses`,
    );
    await page.getByRole("button", { name: "Create business" }).click();

    const sent = await createRequest;
    expect(sent.headers()["idempotency-key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(sent.headers()["authorization"]).toBe(`Bearer ${token}`);
    expect(sent.postDataJSON()).toEqual({ name: "Ada Provisions", currencyCode: "NGN", timeZone: "Africa/Lagos" });
    expect((await createResponse).status()).toBe(201);

    await expect(page.getByRole("heading", { level: 2, name: "Ada Provisions" })).toBeVisible();
    const details = page.getByRole("region", { name: "Ada Provisions" }).locator("dl");
    await expect(details).toContainText("NGN");
    await expect(details).toContainText("Africa/Lagos");
    await expect(details).toContainText("Owner");

    const members = page.getByRole("table");
    await expect(members.getByRole("row", { name: /Ada Okafor/u })).toContainText("Owner");
    await expect(members.getByRole("row", { name: /Ada Okafor/u })).toContainText("Active");
    await expect(page.getByText("Signed in as Ada Okafor")).toBeVisible();

    await expectNothingPersisted(page, token);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("You have signed out.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Local development sign-in" })).toBeVisible();
    await expectNothingPersisted(page, token);
  });

  test("a returning user picks the business, and a reload loses the in-memory session", async ({ page }) => {
    await page.goto("/");
    const token = await signIn(page, subject);

    await expect(page.getByRole("heading", { name: "Choose a business" })).toBeVisible();
    await page.getByRole("button", { name: /Ada Provisions/u }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Ada Provisions" })).toBeVisible();
    await expectNothingPersisted(page, token);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Local development sign-in" })).toBeVisible();
    await expect(page.getByText("Signed in as")).toHaveCount(0);
    await expectNothingPersisted(page, token);
  });

  test("the API rejecting the bearer token ends the session with a safe message", async ({ page }) => {
    await page.goto("/");
    await signIn(page, subject);
    await expect(page.getByRole("heading", { name: "Choose a business" })).toBeVisible();

    await page.route(`${E2E.apiOrigin}/v1/businesses/**`, (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: { "access-control-allow-origin": E2E.webOrigin },
        body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Authentication is required" } }),
      }),
    );
    await page.getByRole("button", { name: /Ada Provisions/u }).click();
    await expect(page.getByText("Your session has ended. Sign in again.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Local development sign-in" })).toBeVisible();
  });
});
