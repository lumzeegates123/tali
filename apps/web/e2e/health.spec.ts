import { expect, test } from "@playwright/test";
import { E2E } from "../playwright.config";

test.describe("web health flow against the real API", () => {
  test("the browser calls the Tali API and shows it ready, with the echoed correlation ID", async ({ page }) => {
    const readiness = page.waitForResponse(`${E2E.apiOrigin}/health/ready`);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Tali" })).toBeVisible();
    await expect(page.getByTestId("environment-name")).toHaveText("local");

    const response = await readiness;
    expect(response.status()).toBe(200);
    const sentCorrelationId = response.request().headers()["x-correlation-id"];
    expect(sentCorrelationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers()["x-correlation-id"]).toBe(sentCorrelationId);

    await expect(page.getByText("Tali API is ready")).toBeVisible();
    await expect(page.getByText(sentCorrelationId ?? "missing")).toBeVisible();
  });

  test("shows the unavailable state when the API cannot be reached", async ({ page }) => {
    await page.route(`${E2E.apiOrigin}/**`, (route) => route.abort("connectionrefused"));
    await page.goto("/");
    await expect(page.locator('[data-health="failed"]')).toContainText("Tali API unavailable");
  });

  test("shows the not-ready state when the API reports its database down", async ({ page }) => {
    await page.route(`${E2E.apiOrigin}/health/ready`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": E2E.webOrigin },
        body: JSON.stringify({ status: "not_ready", checks: { database: "down" } }),
      }),
    );
    await page.goto("/");
    await expect(page.getByText("Tali API is not ready")).toBeVisible();
  });

  test("recovers after the API becomes reachable again", async ({ page }) => {
    await page.route(`${E2E.apiOrigin}/**`, (route) => route.abort("connectionrefused"));
    await page.goto("/");
    await expect(page.locator('[data-health="failed"]')).toContainText("Tali API unavailable");
    await page.unroute(`${E2E.apiOrigin}/**`);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByText("Tali API is ready")).toBeVisible();
  });
});
