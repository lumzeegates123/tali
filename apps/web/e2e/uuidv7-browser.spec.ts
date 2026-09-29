import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

interface RuntimeReport {
  readonly status: string;
  readonly uuidV7?: Record<string, unknown>;
  readonly sample?: string;
  readonly reason?: string;
}

async function readReport(page: Page): Promise<RuntimeReport> {
  const output = page.getByTestId("runtime-checks");
  await expect(output).toHaveAttribute("data-status", "idle");
  await page.getByRole("button", { name: "Run UUIDv7 checks" }).click();
  await expect(output).not.toHaveAttribute("data-status", "idle");
  return JSON.parse((await output.textContent()) ?? "{}") as RuntimeReport;
}

test.describe("UUIDv7 in the browser (Next.js production bundle)", () => {
  test("generates valid, unique, strictly increasing UUIDv7 values from Web Crypto only", async ({ page }) => {
    await page.goto("/diagnostics/runtime");
    const report = await readReport(page);
    expect(report.status).toBe("complete");
    expect(report.uuidV7).toEqual({
      count: 10_000,
      allUuidV7: true,
      allRfcVariant: true,
      allCanonical: true,
      unique: true,
      strictlyIncreasing: true,
      // One getRandomValues call per ID (uuid@14 draws 16 bytes per call); zero Math.random calls.
      randomSourceCalls: { getRandomValues: 10_000, mathRandom: 0 },
      passed: true,
    });
    expect(report.sample).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  test("refuses to generate when Web Crypto is unavailable (no insecure fallback)", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "crypto", { value: undefined, configurable: true });
    });
    await page.goto("/diagnostics/runtime");
    const report = await readReport(page);
    expect(report.status).toBe("refused");
    expect(report.reason).toMatch(/secure random source/u);
  });
});
