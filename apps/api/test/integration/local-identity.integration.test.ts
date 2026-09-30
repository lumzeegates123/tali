import { loadServerConfig, type ServerConfig } from "@tali/config/server";
import { createDatabase } from "@tali/database";
import { readTenancySnapshot, resetTenancyTables } from "@tali/database/testing";
import { ErrorEnvelopeSchema, LocalSignInResponseSchema } from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CompositionError, createApiRuntime, LOCAL_SIGN_IN_LIMIT } from "../../src/composition/api-runtime.js";
import { JsonLogger } from "../../src/observability/logger.js";
import { startApi, TEST_ENV, type ApiHarness } from "../support/api-harness.js";
import { bearer } from "../support/tenancy-client.js";

const LOCAL_ENV = { TALI_ENV: "local", IDENTITY_PROVIDER: "local" } as const;
const PRODUCTION_ENV = {
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
} as const;

describe("local sign-in (TALI_ENV=local, IDENTITY_PROVIDER=local)", () => {
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());

  beforeAll(async () => {
    api = await startApi({ env: LOCAL_ENV, composeIdentity: true });
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    await resetTenancyTables();
  });

  it("composes the real LocalIdentityProvider and mounts the route", () => {
    expect(api.runtime.identityProvider.constructor.name).toBe("LocalIdentityProvider");
    expect(api.runtime.localSignIn).toBeDefined();
  });

  it("signs in, then registers through the normal path, then reads /v1/me", async () => {
    const before = await readTenancySnapshot();
    const signIn = await http().post("/__local/sign-in").send({ subject: "local-user-amina" }).expect(200);
    expect(signIn.headers["cache-control"]).toBe("no-store");
    const { accessToken, tokenType, expiresAt } = LocalSignInResponseSchema.parse(signIn.body);
    expect(Object.keys(signIn.body as object).sort()).toEqual(["accessToken", "expiresAt", "tokenType"]);
    expect(tokenType).toBe("Bearer");
    const lifetimeMs = Date.parse(expiresAt) - Date.now();
    expect(lifetimeMs).toBeGreaterThan(3_500_000);
    expect(lifetimeMs).toBeLessThanOrEqual(3_600_000);

    // Signing in created nothing and bypassed nothing.
    expect(await readTenancySnapshot()).toEqual(before);
    const unregistered = await http().get("/v1/me").set(bearer(accessToken)).expect(403);
    expect(ErrorEnvelopeSchema.parse(unregistered.body).error.code).toBe("USER_NOT_REGISTERED");

    const registered = await http()
      .post("/v1/me/registration")
      .set(bearer(accessToken))
      .send({ displayName: "Amina" })
      .expect(201);
    const me = await http().get("/v1/me").set(bearer(accessToken)).expect(200);
    expect(me.body).toEqual(registered.body);

    const snapshot = await readTenancySnapshot();
    expect(snapshot.externalIdentities).toEqual([
      expect.objectContaining({ provider: "LOCAL", providerSubject: "local-user-amina" }),
    ]);
    expect(snapshot.memberships).toEqual([]);
    expect(snapshot.businesses).toEqual([]);

    const logs = JSON.stringify(api.logs);
    expect(logs).not.toContain(accessToken);
    expect(logs).not.toContain(accessToken.split(".")[2]);
    expect(logs).not.toContain("local-user-amina");
    expect(logs).not.toContain("Amina");
  });

  it("rejects a tampered local token", async () => {
    const { accessToken } = LocalSignInResponseSchema.parse(
      (await http().post("/__local/sign-in").send({ subject: "local-user-baraka" }).expect(200)).body,
    );
    const [header, payload, signature] = accessToken.split(".") as [string, string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>),
        sub: "local-user-admin",
      }),
    ).toString("base64url");
    for (const token of [`${header}.${forgedPayload}.${signature}`, `${header}.${payload}.`, `${header}.${payload}`]) {
      const response = await http().get("/v1/me").set(bearer(token)).expect(401);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("accepts a strict, bounded subject only", async () => {
    for (const body of [
      {},
      { subject: "" },
      { subject: "x".repeat(65) },
      { subject: "has space" },
      { subject: "-leading-dash" },
      { subject: "ok", role: "OWNER" },
      { subject: "ok", businessId: "b" },
      { subject: 42 },
    ]) {
      const response = await http().post("/__local/sign-in").send(body).expect(400);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("VALIDATION_FAILED");
    }
    await http().post("/__local/sign-in?subject=x").send({ subject: "ok" }).expect(400);
  });
});

describe("local sign-in rate limit", () => {
  let api: ApiHarness;
  beforeAll(async () => {
    api = await startApi({ env: LOCAL_ENV, composeIdentity: true });
  });
  afterAll(async () => {
    await api.close();
  });

  it("answers 429 RATE_LIMITED after the per-client budget, without issuing a token", async () => {
    const http = () => request(api.app.getHttpServer());
    for (let attempt = 0; attempt < LOCAL_SIGN_IN_LIMIT.limit; attempt += 1) {
      await http().post("/__local/sign-in").send({ subject: "local-user-rate" }).expect(200);
    }
    const limited = await http().post("/__local/sign-in").send({ subject: "local-user-rate" }).expect(429);
    expect(ErrorEnvelopeSchema.parse(limited.body).error.code).toBe("RATE_LIMITED");
    expect(JSON.stringify(limited.body)).not.toMatch(/accessToken/);
  });
});

describe("non-local safety", () => {
  it("the sign-in route does not exist in the test environment", async () => {
    const api = await startApi();
    try {
      const response = await request(api.app.getHttpServer())
        .post("/__local/sign-in")
        .send({ subject: "local-user-x" })
        .expect(404);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("NOT_FOUND");
      expect(api.runtime.localSignIn).toBeUndefined();
    } finally {
      await api.close();
    }
  });

  it("the sign-in route does not exist in a deployed environment", async () => {
    const api = await startApi({ config: loadServerConfig(PRODUCTION_ENV) });
    try {
      await request(api.app.getHttpServer()).post("/__local/sign-in").send({ subject: "local-user-x" }).expect(404);
    } finally {
      await api.close();
    }
  });

  it("server configuration refuses the local provider outside TALI_ENV=local", () => {
    for (const env of ["test", "development", "staging", "production"]) {
      expect(() => loadServerConfig({ ...PRODUCTION_ENV, TALI_ENV: env, IDENTITY_PROVIDER: "local" })).toThrow(
        /IDENTITY_PROVIDER/,
      );
    }
  });

  it("composition independently rejects local and fake providers in deployed environments", async () => {
    const deployed = loadServerConfig(PRODUCTION_ENV);
    const logger = new JsonLogger({ service: "t", level: "error", sink: () => undefined });
    for (const env of ["development", "staging", "production"] as const) {
      for (const provider of ["local", "fake"] as const) {
        const forged = { ...deployed, env, identity: { provider } } as unknown as ServerConfig;
        await expect(createApiRuntime(forged, { logger })).rejects.toBeInstanceOf(CompositionError);
      }
    }
    const localInTest = { ...loadServerConfig(TEST_ENV), identity: { provider: "local" } } as unknown as ServerConfig;
    await expect(createApiRuntime(localInTest, { logger })).rejects.toThrow(/IDENTITY_PROVIDER=local is not allowed/);
  });
});

describe("DEPENDENCY_UNAVAILABLE", () => {
  let api: ApiHarness;
  beforeAll(async () => {
    api = await startApi({
      database: createDatabase({
        connectionString: "postgresql://tali_app:unused@127.0.0.1:1/tali_test",
        applicationName: "tali-unreachable-probe",
      }),
    });
  });
  afterAll(async () => {
    await api.close();
  });

  it("answers 503 with no database detail when PostgreSQL is unreachable", async () => {
    const token = api.identity.issueToken("unreachable-subject");
    const http = () => request(api.app.getHttpServer());
    for (const send of [
      () => http().get("/v1/me").set(bearer(token)),
      () => http().post("/v1/me/registration").set(bearer(token)).send({ displayName: "Nobody" }),
    ]) {
      const response = await send();
      expect(response.status).toBe(503);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(JSON.stringify(response.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|prisma|tali_app|postgres/i);
    }
  });
});
