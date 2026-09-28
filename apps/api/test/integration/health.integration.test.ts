import { LivenessResponseSchema, ReadinessResponseSchema } from "@tali/shared";
import { createDatabase } from "@tali/database";
import { testDatabaseUrls } from "@tali/database/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type ApiHarness } from "../support/api-harness.js";

describe("health (real PostgreSQL)", () => {
  let api: ApiHarness;
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it("GET /health/live returns 200 { status: ok }", async () => {
    const response = await request(api.app.getHttpServer()).get("/health/live").expect(200);
    expect(LivenessResponseSchema.parse(response.body)).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns 200 when PostgreSQL is reachable", async () => {
    const response = await request(api.app.getHttpServer()).get("/health/ready").expect(200);
    expect(ReadinessResponseSchema.parse(response.body)).toEqual({ status: "ready", checks: { database: "up" } });
  });
});

describe("health with PostgreSQL unreachable", () => {
  let api: ApiHarness;
  beforeAll(async () => {
    const url = new URL(testDatabaseUrls().app);
    url.port = "1";
    api = await startApi({ database: createDatabase({ connectionString: url.toString(), connectionTimeoutMs: 500 }) });
  });
  afterAll(async () => {
    await api.close();
  });

  it("GET /health/ready returns 503 not_ready without leaking the cause", async () => {
    const response = await request(api.app.getHttpServer()).get("/health/ready").expect(503);
    expect(ReadinessResponseSchema.parse(response.body)).toEqual({ status: "not_ready", checks: { database: "down" } });
    expect(JSON.stringify(response.body)).not.toMatch(/ECONNREFUSED|postgres|127\.0\.0\.1|password/i);
  });

  it("GET /health/live still returns 200: liveness never depends on the database", async () => {
    await request(api.app.getHttpServer()).get("/health/live").expect(200, { status: "ok" });
  });

  it("logs the readiness failure server-side", () => {
    expect(
      api.logs.some((entry) => entry["msg"] === "readiness check failed" && entry["dependency"] === "database"),
    ).toBe(true);
  });
});
