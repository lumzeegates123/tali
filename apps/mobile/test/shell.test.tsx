import { fireEvent, render, screen } from "@testing-library/react-native";
import { TaliApiClient } from "../src/api/tali-api-client";
import { readMobileConfig } from "../src/config/mobile-config";
import { ApiHealth } from "../src/health/api-health";
import { AppShell } from "../src/shell/app-shell";
import { deferredFetch, jsonFetch, unreachableFetch } from "./support/fake-fetch";

const localEnv = { EXPO_PUBLIC_TALI_ENV: "local", EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:3000" };

function healthClient(fetchDouble: typeof fetch): TaliApiClient {
  return new TaliApiClient({ baseUrl: "http://10.0.2.2:3000", createCorrelationId: () => "c-1", fetch: fetchDouble });
}

describe("mobile shell", () => {
  it("renders the shell and the non-production environment panel", async () => {
    await render(<AppShell result={readMobileConfig(localEnv)} />);
    expect(screen.getByText("Tali")).toBeTruthy();
    expect(screen.getByText("Environment: local")).toBeTruthy();
    expect(screen.getByText("Cognito client settings: not configured")).toBeTruthy();
  });

  it("hides the environment panel in production", async () => {
    await render(
      <AppShell
        result={readMobileConfig({
          EXPO_PUBLIC_TALI_ENV: "production",
          EXPO_PUBLIC_API_BASE_URL: "https://api.example.test",
        })}
      />,
    );
    expect(screen.queryByTestId("environment-panel")).toBeNull();
  });

  it("shows a configuration error, naming keys but never values, when public config is invalid", async () => {
    await render(
      <AppShell
        result={readMobileConfig({
          EXPO_PUBLIC_TALI_ENV: "production",
          EXPO_PUBLIC_API_BASE_URL: "http://plain.example.test",
        })}
      />,
    );
    expect(screen.getByTestId("configuration-problem")).toBeTruthy();
    expect(screen.getByText(/EXPO_PUBLIC_API_BASE_URL/u)).toBeTruthy();
    expect(screen.queryByText(/plain\.example\.test/u)).toBeNull();
  });

  it("shows a configuration error when public config is missing", async () => {
    await render(<AppShell result={readMobileConfig({})} />);
    expect(screen.getByTestId("configuration-problem")).toBeTruthy();
    expect(screen.getByText(/EXPO_PUBLIC_TALI_ENV/u)).toBeTruthy();
  });
});

describe("mobile API health screen", () => {
  it("shows loading until the API answers, then ready", async () => {
    const pending = deferredFetch();
    await render(<ApiHealth client={healthClient(pending.fetch)} />);
    expect(screen.getByTestId("health-loading")).toBeTruthy();
    pending.release(
      new Response(JSON.stringify({ status: "ready", checks: { database: "up" } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-correlation-id": "c-1" },
      }),
    );
    expect(await screen.findByText("Tali API is ready")).toBeTruthy();
    expect(screen.getByText("Correlation ID: c-1")).toBeTruthy();
  });

  it("shows not ready for a 503 readiness response", async () => {
    await render(
      <ApiHealth client={healthClient(jsonFetch(503, { status: "not_ready", checks: { database: "down" } }).fetch)} />,
    );
    expect(await screen.findByText("Tali API is not ready")).toBeTruthy();
    expect(screen.getByText("Database: down")).toBeTruthy();
  });

  it("shows the API as unavailable and retries on request", async () => {
    let fetchDouble: typeof fetch = unreachableFetch;
    await render(<ApiHealth client={healthClient((input, init) => fetchDouble(input, init))} />);
    expect(await screen.findByText("Tali API unavailable")).toBeTruthy();
    fetchDouble = jsonFetch(200, { status: "ready", checks: { database: "up" } }).fetch;
    await fireEvent.press(screen.getByText("Check again"));
    expect(await screen.findByText("Tali API is ready")).toBeTruthy();
  });

  it("shows the standard error envelope", async () => {
    await render(
      <ApiHealth
        client={healthClient(jsonFetch(500, { error: { code: "INTERNAL", message: "Something went wrong" } }).fetch)}
      />,
    );
    expect(await screen.findByText("Tali API error")).toBeTruthy();
    expect(screen.getByText("INTERNAL: Something went wrong")).toBeTruthy();
  });

  it("shows an unexpected response when the body breaks the contract", async () => {
    await render(<ApiHealth client={healthClient(jsonFetch(200, { status: "ok" }).fetch)} />);
    expect(await screen.findByText("Unexpected API response")).toBeTruthy();
  });
});
