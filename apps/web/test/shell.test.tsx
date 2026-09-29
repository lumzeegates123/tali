import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiHealth } from "../src/health/api-health";
import { TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { readWebConfig } from "../src/lib/config/web-config";
import { AppShell } from "../src/shell/app-shell";
import { deferredFetch, jsonFetch, unreachableFetch } from "./support/fake-fetch";

const VALID_ENV = { NEXT_PUBLIC_TALI_ENV: "local", NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3910" };

function healthWith(fetchDouble: typeof fetch) {
  const client = new TaliApiClient({
    baseUrl: "http://api.test",
    createCorrelationId: () => "c-1",
    fetch: fetchDouble,
  });
  return render(<ApiHealth client={client} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web shell", () => {
  it("renders the shell, environment diagnostics and the API health section", async () => {
    vi.stubGlobal("fetch", jsonFetch(200, { status: "ready", checks: { database: "up" } }).fetch);
    render(<AppShell result={readWebConfig(VALID_ENV)} />);
    expect(screen.getByRole("heading", { level: 1, name: "Tali" })).toBeDefined();
    expect(screen.getByTestId("environment-name").textContent).toBe("local");
    expect(screen.getByText("http://127.0.0.1:3910")).toBeDefined();
    expect(await screen.findByText("Tali API is ready")).toBeDefined();
  });

  it("hides environment diagnostics in production", () => {
    vi.stubGlobal("fetch", deferredFetch().fetch);
    render(
      <AppShell
        result={readWebConfig({
          NEXT_PUBLIC_TALI_ENV: "production",
          NEXT_PUBLIC_API_BASE_URL: "https://api.example.com",
        })}
      />,
    );
    expect(screen.queryByTestId("environment-name")).toBeNull();
    expect(screen.getByRole("heading", { name: "API health" })).toBeDefined();
  });

  it("shows a configuration error, names keys but not values, and never calls the API", () => {
    const fetchSpy = vi.fn(unreachableFetch);
    vi.stubGlobal("fetch", fetchSpy);
    const result = readWebConfig({ NEXT_PUBLIC_TALI_ENV: "prod", NEXT_PUBLIC_API_BASE_URL: "not-a-url-secret" });
    expect(result.ok).toBe(false);
    render(<AppShell result={result} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Configuration error");
    expect(alert.textContent).toContain("NEXT_PUBLIC_TALI_ENV");
    expect(alert.textContent).toContain("NEXT_PUBLIC_API_BASE_URL");
    expect(alert.textContent).not.toContain("not-a-url-secret");
    expect(screen.queryByRole("heading", { name: "API health" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats missing public configuration as a configuration error", () => {
    expect(readWebConfig({})).toMatchObject({ ok: false });
  });
});

describe("API health states", () => {
  it("shows the loading state until the API answers", async () => {
    const deferred = deferredFetch();
    healthWith(deferred.fetch);
    expect(screen.getByRole("status").textContent).toBe("Checking the Tali API…");
    expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(true);
    deferred.release(
      new Response(JSON.stringify({ status: "ready", checks: { database: "up" } }), {
        status: 200,
        headers: { "x-correlation-id": "echo-7" },
      }),
    );
    expect(await screen.findByText("Tali API is ready")).toBeDefined();
    expect(screen.getByText("echo-7")).toBeDefined();
  });

  it("shows the healthy state", async () => {
    healthWith(jsonFetch(200, { status: "ready", checks: { database: "up" } }).fetch);
    expect(await screen.findByText("Tali API is ready")).toBeDefined();
    expect(screen.getByText("up")).toBeDefined();
  });

  it("shows the not-ready state when the database is down", async () => {
    healthWith(jsonFetch(503, { status: "not_ready", checks: { database: "down" } }).fetch);
    expect(await screen.findByText("Tali API is not ready")).toBeDefined();
    expect(screen.getByText("down")).toBeDefined();
  });

  it("shows the unavailable state when the API cannot be reached", async () => {
    healthWith(unreachableFetch);
    expect((await screen.findByRole("alert")).textContent).toContain("Tali API unavailable");
  });

  it("shows a standard API error", async () => {
    healthWith(jsonFetch(500, { error: { code: "INTERNAL_ERROR", message: "Something went wrong" } }).fetch);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Tali API error");
    expect(alert.textContent).toContain("INTERNAL_ERROR: Something went wrong");
  });
});
