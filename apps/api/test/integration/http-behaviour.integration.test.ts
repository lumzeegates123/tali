import type { IdentityProvider } from "@tali/application";
import { loadServerConfig } from "@tali/config/server";
import { ErrorEnvelopeSchema } from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, TEST_ENV, type ApiHarness } from "../support/api-harness.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("HTTP behaviour", () => {
  let api: ApiHarness;
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  const http = () => request(api.app.getHttpServer());

  describe("correlation ID", () => {
    it("echoes a well-formed inbound x-correlation-id", async () => {
      const response = await http().get("/health/live").set("x-correlation-id", "client-req-42").expect(200);
      expect(response.headers["x-correlation-id"]).toBe("client-req-42");
    });

    it("generates one when absent", async () => {
      const response = await http().get("/health/live").expect(200);
      expect(response.headers["x-correlation-id"]).toMatch(UUID);
    });

    it("replaces a malformed or oversized inbound value instead of echoing it", async () => {
      for (const bad of ["has spaces", "<script>", "x".repeat(200)]) {
        const response = await http().get("/health/live").set("x-correlation-id", bad).expect(200);
        expect(response.headers["x-correlation-id"]).toMatch(UUID);
      }
    });

    it("stamps request logs with the correlation ID", async () => {
      await http().get("/health/live").set("x-correlation-id", "log-check-1").expect(200);
      expect(
        api.logs.some((entry) => entry["msg"] === "request completed" && entry["correlationId"] === "log-check-1"),
      ).toBe(true);
    });

    it("is present on error responses too", async () => {
      const response = await http().get("/does-not-exist").set("x-correlation-id", "err-1").expect(404);
      expect(response.headers["x-correlation-id"]).toBe("err-1");
    });
  });

  describe("error envelope", () => {
    it("unknown routes return 404 in the standard envelope", async () => {
      const response = await http().get("/does-not-exist").expect(404);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("NOT_FOUND");
    });

    it("an ApplicationError maps to its status and code (401 UNAUTHENTICATED)", async () => {
      const response = await http().get("/__test/identity").expect(401);
      expect(ErrorEnvelopeSchema.parse(response.body)).toEqual({
        error: { code: "UNAUTHENTICATED", message: "A bearer access token is required" },
      });
    });

    it("never includes stack traces", async () => {
      const response = await http().get("/does-not-exist").expect(404);
      expect(JSON.stringify(response.body)).not.toMatch(/\bat \S+:\d+|stack/);
    });
  });

  describe("identity guard boundary (test-only route)", () => {
    it("rejects a missing, malformed or unknown token with 401", async () => {
      await http().get("/__test/identity").expect(401);
      await http().get("/__test/identity").set("authorization", "Basic abc").expect(401);
      await http().get("/__test/identity").set("authorization", "Bearer unknown-token").expect(401);
    });

    it("accepts a token verified by the IdentityProvider port and exposes only the identity", async () => {
      const token = api.identity.issueToken("user-subject-1");
      const response = await http().get("/__test/identity").set("authorization", `Bearer ${token}`).expect(200);
      expect(response.body).toEqual({ provider: "fake", subject: "user-subject-1" });
    });

    it("rejects a revoked token", async () => {
      const token = api.identity.issueToken("user-subject-2");
      api.identity.revoke(token);
      await http().get("/__test/identity").set("authorization", `Bearer ${token}`).expect(401);
    });
  });
});

describe("unexpected errors", () => {
  const failing: IdentityProvider = {
    async verifyAccessToken() {
      throw new Error("boom: password=hunter2 at postgres://internal-host");
    },
  };
  let api: ApiHarness;
  beforeAll(async () => {
    api = await startApi({ identityProvider: failing });
  });
  afterAll(async () => {
    await api.close();
  });

  it("return 500 INTERNAL_ERROR with a generic message and log the detail server-side only", async () => {
    const response = await request(api.app.getHttpServer())
      .get("/__test/identity")
      .set("authorization", "Bearer anything")
      .expect(500);
    expect(response.body).toEqual({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
    expect(JSON.stringify(response.body)).not.toMatch(/hunter2|internal-host|boom/);
    const logged = api.logs.find((entry) => entry["msg"] === "request failed");
    expect(logged?.["status"]).toBe(500);
  });
});

describe("CORS for the web client", () => {
  const WEB_ORIGIN = "http://127.0.0.1:3911";
  let api: ApiHarness;
  beforeAll(async () => {
    api = await startApi({ env: { API_CORS_ORIGINS: WEB_ORIGIN } });
  });
  afterAll(async () => {
    await api.close();
  });

  it("allows a configured origin to send and read the correlation ID", async () => {
    const preflight = await request(api.app.getHttpServer())
      .options("/health/ready")
      .set("origin", WEB_ORIGIN)
      .set("access-control-request-method", "GET")
      .set("access-control-request-headers", "x-correlation-id")
      .expect(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(preflight.headers["access-control-allow-headers"]).toMatch(/x-correlation-id/i);

    const response = await request(api.app.getHttpServer())
      .get("/health/ready")
      .set("origin", WEB_ORIGIN)
      .set("x-correlation-id", "web-cors-1")
      .expect(200);
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(response.headers["access-control-expose-headers"]).toMatch(/x-correlation-id/i);
    expect(response.headers["x-correlation-id"]).toBe("web-cors-1");
  });

  it("does not grant an unlisted origin", async () => {
    const response = await request(api.app.getHttpServer())
      .get("/health/live")
      .set("origin", "http://evil.example")
      .expect(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("test-only routes in deployed environments", () => {
  it("the identity probe route does not exist when TALI_ENV is deployed", async () => {
    const config = loadServerConfig({
      ...TEST_ENV,
      TALI_ENV: "production",
      IDENTITY_PROVIDER: "cognito",
      COGNITO_REGION: "eu-west-1",
      COGNITO_USER_POOL_ID: "eu-west-1_Example123",
      COGNITO_CLIENT_IDS: "exampleclientid",
      OBJECT_STORAGE_PROVIDER: "s3",
      S3_REGION: "eu-west-1",
      S3_BUCKET: "tali-example-bucket",
      QUEUE_PROVIDER: "sqs",
      SQS_REGION: "eu-west-1",
      SQS_QUEUE_URL: "https://sqs.eu-west-1.amazonaws.com/000000000000/tali-example",
    });
    expect(config.api.testRoutesEnabled).toBe(false);
    const api = await startApi({ config });
    try {
      const token = api.identity.issueToken("someone");
      const response = await request(api.app.getHttpServer())
        .get("/__test/identity")
        .set("authorization", `Bearer ${token}`)
        .expect(404);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("NOT_FOUND");
    } finally {
      await api.close();
    }
  });
});
