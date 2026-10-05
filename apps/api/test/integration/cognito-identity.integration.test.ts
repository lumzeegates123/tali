import { randomUUID } from "node:crypto";
import { readTenancySnapshot, resetTenancyTables, tenancyFixtures } from "@tali/database/testing";
import {
  SYNTHETIC_MOBILE_CLIENT_ID,
  SYNTHETIC_WEB_CLIENT_ID,
  SyntheticCognitoPool,
} from "@tali/integrations/aws/cognito/testing";
import {
  CreateBusinessResponseSchema,
  CreateInvitationResponseSchema,
  CurrentUserResponseSchema,
  ErrorEnvelopeSchema,
  MyBusinessesResponseSchema,
} from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startApi, TEST_ENV, type ApiHarness } from "../support/api-harness.js";
import { bearer } from "../support/tenancy-client.js";

/*
 * Cognito-shaped end-to-end tests (ADR-003 section 15): tokens are signed by a
 * synthetic pool's in-memory RSA keys and verified by the real
 * CognitoIdentityProvider composed from configuration; the JWKS is served by
 * an injected fetch, so nothing contacts Cognito or AWS. Authorization comes
 * only from Tali's database.
 */

const EMAIL = "pilot.owner@example.test";
const code = (body: unknown) => ErrorEnvelopeSchema.parse(body).error.code;

describe("Cognito identity through the API", () => {
  let pool: SyntheticCognitoPool;
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());

  const accessToken = (sub: string, claims: Record<string, unknown> = {}) =>
    pool.accessToken(sub, new Date(), { email: EMAIL, ...claims });

  async function register(sub: string, displayName: string, claims: Record<string, unknown> = {}) {
    const token = await accessToken(sub, claims);
    const response = await http().post("/v1/me/registration").set(bearer(token)).send({ displayName }).expect(201);
    return { token, userId: CurrentUserResponseSchema.parse(response.body).id };
  }

  beforeAll(async () => {
    pool = await SyntheticCognitoPool.create();
    api = await startApi({
      env: {
        IDENTITY_PROVIDER: "cognito",
        COGNITO_REGION: pool.region,
        COGNITO_USER_POOL_ID: pool.userPoolId,
        COGNITO_CLIENT_IDS: pool.clientIds.join(","),
      },
      composeIdentity: true,
      cognitoJwksFetch: pool.fetch,
    });
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    await resetTenancyTables();
  });

  it("composes the CognitoIdentityProvider from configuration", () => {
    expect(api.runtime.identityProvider.constructor.name).toBe("CognitoIdentityProvider");
    expect(api.runtime.localSignIn).toBeUndefined();
  });

  it("registers a new Cognito subject explicitly, links COGNITO, and copies no email or claim", async () => {
    const sub = randomUUID();
    const token = await accessToken(sub, { phone_number: "+2340000000001", "cognito:groups": ["OWNER"] });
    const before = await readTenancySnapshot();
    expect(code((await http().get("/v1/me").set(bearer(token)).expect(403)).body)).toBe("USER_NOT_REGISTERED");
    // Authentication alone created nothing.
    expect(await readTenancySnapshot()).toEqual(before);

    const registered = await http()
      .post("/v1/me/registration")
      .set(bearer(token))
      .send({ displayName: "Pilot Owner" })
      .expect(201);
    const me = await http().get("/v1/me").set(bearer(token)).expect(200);
    expect(me.body).toEqual(registered.body);
    const businesses = await http().get("/v1/me/businesses").set(bearer(token)).expect(200);
    expect(MyBusinessesResponseSchema.parse(businesses.body).items).toEqual([]);

    const snapshot = await readTenancySnapshot();
    expect(snapshot.externalIdentities).toEqual([
      expect.objectContaining({ provider: "COGNITO", providerSubject: sub }),
    ]);
    expect(snapshot.platformAudit.map((record) => record.action).sort()).toEqual([
      "identity.linked",
      "user.registered",
    ]);
    const persisted = JSON.stringify(snapshot);
    for (const leaked of [EMAIL, "+2340000000001", "OWNER", "cognito:groups", token]) {
      expect(persisted).not.toContain(leaked);
    }
    // Registration again with the same subject is the natural-key replay, not a second user.
    await http().post("/v1/me/registration").set(bearer(token)).send({ displayName: "Pilot Owner" }).expect(200);
    expect((await readTenancySnapshot()).users).toHaveLength(1);
  });

  it("accepts the web and mobile app clients and refuses an unknown third client", async () => {
    const sub = randomUUID();
    await register(sub, "Client Check");
    for (const clientId of [SYNTHETIC_WEB_CLIENT_ID, SYNTHETIC_MOBILE_CLIENT_ID]) {
      await http()
        .get("/v1/me")
        .set(bearer(await accessToken(sub, { client_id: clientId })))
        .expect(200);
    }
    const third = await http()
      .get("/v1/me")
      .set(bearer(await accessToken(sub, { client_id: "unknownthirdclient00000003" })))
      .expect(401);
    expect(code(third.body)).toBe("UNAUTHENTICATED");
  });

  it("refuses ID tokens, other issuers, expired tokens and unpublished keys with the same 401", async () => {
    const sub = randomUUID();
    await register(sub, "Token Check");
    const now = Math.floor(Date.now() / 1000);
    const rejected = [
      await accessToken(sub, { token_use: "id", aud: SYNTHETIC_WEB_CLIENT_ID }),
      await accessToken(sub, { iss: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_SyntheticPool1" }),
      await accessToken(sub, { iat: now - 3600, auth_time: now - 3600, exp: now - 600 }),
      await pool.accessToken(sub, new Date(), {}, { unpublishedKey: true }),
    ];
    const bodies = new Set<string>();
    for (const token of rejected) {
      const response = await http().get("/v1/me").set(bearer(token)).expect(401);
      bodies.add(JSON.stringify(response.body));
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toContain("UNAUTHENTICATED");
  });

  it("an unregistered subject with OWNER and ADMIN groups is still USER_NOT_REGISTERED outside registration", async () => {
    const token = await accessToken(randomUUID(), {
      "cognito:groups": ["OWNER", "ADMIN"],
      "custom:role": "OWNER",
      "custom:businessId": randomUUID(),
    });
    for (const send of [
      () => http().get("/v1/me").set(bearer(token)),
      () => http().get("/v1/me/businesses").set(bearer(token)),
      () => http().get(`/v1/businesses/${randomUUID()}`).set(bearer(token)),
      () =>
        http()
          .post("/v1/businesses")
          .set(bearer(token))
          .set("idempotency-key", randomUUID())
          .send({ name: "Group Shop", currencyCode: "NGN", timeZone: "Africa/Lagos" }),
    ]) {
      const response = await send();
      expect(response.status).toBe(403);
      expect(code(response.body)).toBe("USER_NOT_REGISTERED");
    }
  });

  it("a CASHIER membership stays CASHIER whatever Cognito groups or custom claims say", async () => {
    const owner = await register(randomUUID(), "Shop Owner");
    const created = await http()
      .post("/v1/businesses")
      .set(bearer(owner.token))
      .set("idempotency-key", randomUUID())
      .send({ name: "Claims Shop", currencyCode: "NGN", timeZone: "Africa/Lagos" })
      .expect(201);
    const business = CreateBusinessResponseSchema.parse(created.body).business;
    const other = await http()
      .post("/v1/businesses")
      .set(bearer(owner.token))
      .set("idempotency-key", randomUUID())
      .send({ name: "Other Shop", currencyCode: "NGN", timeZone: "Africa/Lagos" })
      .expect(201);
    const otherBusiness = CreateBusinessResponseSchema.parse(other.body).business;
    const invitation = await http()
      .post(`/v1/businesses/${business.id}/invitations`)
      .set(bearer(owner.token))
      .set("idempotency-key", randomUUID())
      .send({ role: "CASHIER" })
      .expect(201);
    const invitationToken = CreateInvitationResponseSchema.parse(invitation.body);
    if (!invitationToken.tokenAvailable) throw new Error("expected a fresh invitation token");

    const elevated = {
      "cognito:groups": ["OWNER", "ADMIN"],
      "custom:role": "OWNER",
      "custom:businessId": otherBusiness.id,
      scope: "aws.cognito.signin.user.admin admin",
    };
    const cashierSub = randomUUID();
    const cashier = await register(cashierSub, "Shop Cashier", elevated);
    await http()
      .post("/v1/invitations/accept")
      .set(bearer(cashier.token))
      .send({ token: invitationToken.token })
      .expect(200);

    const token = await accessToken(cashierSub, elevated);
    const mine = MyBusinessesResponseSchema.parse(
      (await http().get("/v1/me/businesses").set(bearer(token)).expect(200)).body,
    );
    expect(mine.items.map((item) => [item.business.id, item.membership.role])).toEqual([[business.id, "CASHIER"]]);
    expect(code((await http().get(`/v1/businesses/${business.id}/members`).set(bearer(token)).expect(403)).body)).toBe(
      "PERMISSION_DENIED",
    );
    expect(
      code(
        (
          await http()
            .patch(`/v1/businesses/${business.id}`)
            .set(bearer(token))
            .send({ name: "Taken Over" })
            .expect(403)
        ).body,
      ),
    ).toBe("PERMISSION_DENIED");
    // A custom businessId claim grants nothing in that business.
    expect(code((await http().get(`/v1/businesses/${otherBusiness.id}`).set(bearer(token)).expect(404)).body)).toBe(
      "NOT_FOUND",
    );
    const snapshot = await readTenancySnapshot();
    expect(snapshot.memberships.find((membership) => membership.userId === cashier.userId)?.role).toBe("CASHIER");
  });

  it("a DISABLED Tali user is refused even though the Cognito token is valid", async () => {
    const sub = randomUUID();
    const user = await register(sub, "Disabled Later", { "cognito:groups": ["OWNER"] });
    await tenancyFixtures.setUserStatus(user.userId, "DISABLED");
    const token = await accessToken(sub, { "cognito:groups": ["OWNER"] });
    for (const send of [
      () => http().get("/v1/me").set(bearer(token)),
      () => http().get("/v1/me/businesses").set(bearer(token)),
      () => http().post("/v1/me/registration").set(bearer(token)).send({ displayName: "Again" }),
    ]) {
      const response = await send();
      expect(response.status).toBe(403);
      expect(code(response.body)).toBe("USER_DISABLED");
    }
  });

  it("never logs tokens, full subjects or claims", async () => {
    const sub = randomUUID();
    const { token } = await register(sub, "Quiet User", { "cognito:groups": ["OWNER"] });
    await http()
      .get("/v1/me")
      .set(bearer(`${token}tampered`))
      .expect(401);
    const logs = JSON.stringify(api.logs);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(token.split(".")[2]);
    expect(logs).not.toContain(sub);
    expect(logs).not.toContain(EMAIL);
    expect(logs).not.toContain("cognito:groups");
  });

  it("fetched only the trusted JWKS URL, a bounded number of times", () => {
    expect(new Set(pool.requestedUrls)).toEqual(new Set([pool.jwksUrl]));
    expect(pool.fetchCount).toBeLessThanOrEqual(2);
  });
});

describe("Cognito composition safety", () => {
  it("refuses a replacement JWKS fetch outside local and test", async () => {
    const pool = await SyntheticCognitoPool.create();
    const { loadServerConfig } = await import("@tali/config/server");
    const { createApiRuntime, CompositionError } = await import("../../src/composition/api-runtime.js");
    const { JsonLogger } = await import("../../src/observability/logger.js");
    const config = loadServerConfig({
      ...TEST_ENV,
      TALI_ENV: "production",
      IDENTITY_PROVIDER: "cognito",
      COGNITO_REGION: pool.region,
      COGNITO_USER_POOL_ID: pool.userPoolId,
      COGNITO_CLIENT_IDS: pool.clientIds.join(","),
      OBJECT_STORAGE_PROVIDER: "s3",
      S3_REGION: "eu-west-1",
      S3_BUCKET: "tali-synthetic-bucket",
      QUEUE_PROVIDER: "sqs",
      SQS_REGION: "eu-west-1",
      SQS_QUEUE_URL: "https://sqs.eu-west-1.amazonaws.com/000000000000/tali-synthetic",
    });
    const logger = new JsonLogger({ service: "t", level: "error", sink: () => undefined });
    await expect(createApiRuntime(config, { logger, cognitoJwksFetch: pool.fetch })).rejects.toBeInstanceOf(
      CompositionError,
    );
    const runtime = await createApiRuntime(config, { logger });
    try {
      expect(runtime.identityProvider.constructor.name).toBe("CognitoIdentityProvider");
    } finally {
      await runtime.close();
    }
    expect(pool.fetchCount).toBe(0);
  });
});
