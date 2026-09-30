import { describe, expect, it } from "vitest";
import { CORRELATION_HEADER, TaliApiClient } from "../src/lib/api-client/tali-api-client";
import { hangingFetch, jsonFetch, unreachableFetch } from "./support/fake-fetch";

const READY = { status: "ready", checks: { database: "up" } };
const NOT_READY = { status: "not_ready", checks: { database: "down" } };

function client(fetchDouble: typeof fetch, timeoutMs?: number): TaliApiClient {
  return new TaliApiClient({
    baseUrl: "http://api.test/",
    createCorrelationId: () => "web-correlation-1",
    fetch: fetchDouble,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("TaliApiClient.getReadiness", () => {
  it("calls GET /health/ready with a correlation ID and returns the shared readiness contract", async () => {
    const double = jsonFetch(200, READY, { [CORRELATION_HEADER]: "server-echo-1" });
    const result = await client(double.fetch).getReadiness();
    expect(result).toEqual({ ok: true, status: 200, value: READY, correlationId: "server-echo-1" });
    expect(double.requests).toHaveLength(1);
    expect(double.requests[0]?.url).toBe("http://api.test/health/ready");
    expect(new Headers(double.requests[0]?.init?.headers).get(CORRELATION_HEADER)).toBe("web-correlation-1");
  });

  it("treats 503 not_ready as a valid contract response, not a failure", async () => {
    const result = await client(jsonFetch(503, NOT_READY).fetch).getReadiness();
    expect(result).toMatchObject({ ok: true, status: 503, value: NOT_READY });
  });

  it("maps the standard error envelope", async () => {
    const envelope = { error: { code: "INTERNAL_ERROR", message: "Something went wrong" } };
    const result = await client(jsonFetch(500, envelope, { [CORRELATION_HEADER]: "c-500" }).fetch).getReadiness();
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "api-error",
        status: 500,
        code: "INTERNAL_ERROR",
        message: "Something went wrong",
        correlationId: "c-500",
        fields: [],
      },
    });
  });

  it("rejects a response that does not match the contract", async () => {
    const extraField = { ...READY, secret: "unexpected" };
    expect(await client(jsonFetch(200, extraField).fetch).getReadiness()).toEqual({
      ok: false,
      failure: { kind: "invalid-response", status: 200, correlationId: undefined },
    });
    expect(await client(jsonFetch(404, "not json envelope").fetch).getReadiness()).toMatchObject({
      ok: false,
      failure: { kind: "invalid-response", status: 404 },
    });
  });

  it("reports an unreachable API as unavailable", async () => {
    expect(await client(unreachableFetch).getReadiness()).toEqual({
      ok: false,
      failure: { kind: "unavailable", reason: "network" },
    });
  });

  it("times out a hanging request", async () => {
    expect(await client(hangingFetch, 20).getReadiness()).toEqual({
      ok: false,
      failure: { kind: "unavailable", reason: "timeout" },
    });
  });
});
