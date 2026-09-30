import { CORRELATION_HEADER, TaliApiClient } from "../src/api/tali-api-client";
import { hangingFetch, jsonFetch, unreachableFetch } from "./support/fake-fetch";

const ready = { status: "ready", checks: { database: "up" } };

function client(fetchDouble: typeof fetch, timeoutMs?: number): TaliApiClient {
  return new TaliApiClient({
    baseUrl: "http://10.0.2.2:3000/",
    createCorrelationId: () => "corr-mobile-1",
    fetch: fetchDouble,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("mobile TaliApiClient", () => {
  it("calls /health/ready on the configured base URL with a correlation ID", async () => {
    const double = jsonFetch(200, ready, { [CORRELATION_HEADER]: "corr-mobile-1" });
    const result = await client(double.fetch).getReadiness();
    expect(result).toEqual({ ok: true, status: 200, value: ready, correlationId: "corr-mobile-1" });
    expect(double.requests[0]?.url).toBe("http://10.0.2.2:3000/health/ready");
    expect(double.requests[0]?.init?.headers).toMatchObject({ [CORRELATION_HEADER]: "corr-mobile-1" });
    expect(double.requests[0]?.init).not.toHaveProperty("cache");
  });

  it("treats a 503 readiness body as a not-ready contract response", async () => {
    const body = { status: "not_ready", checks: { database: "down" } };
    const result = await client(jsonFetch(503, body).fetch).getReadiness();
    expect(result).toMatchObject({ ok: true, status: 503, value: body });
  });

  it("maps the standard error envelope", async () => {
    const envelope = { error: { code: "INTERNAL", message: "Something went wrong" } };
    const result = await client(jsonFetch(500, envelope, { [CORRELATION_HEADER]: "c-9" }).fetch).getReadiness();
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "api-error",
        status: 500,
        code: "INTERNAL",
        message: "Something went wrong",
        correlationId: "c-9",
        fields: [],
      },
    });
  });

  it("rejects bodies that do not match the shared contract", async () => {
    const result = await client(jsonFetch(200, { status: "ok" }).fetch).getReadiness();
    expect(result).toEqual({ ok: false, failure: { kind: "invalid-response", status: 200, correlationId: undefined } });
  });

  it("reports an unreachable API as unavailable", async () => {
    const result = await client(unreachableFetch).getReadiness();
    expect(result).toEqual({ ok: false, failure: { kind: "unavailable", reason: "network" } });
  });

  it("reports a timeout as unavailable", async () => {
    const result = await client(hangingFetch, 20).getReadiness();
    expect(result).toEqual({ ok: false, failure: { kind: "unavailable", reason: "timeout" } });
  });
});
