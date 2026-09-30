import { randomUUID } from "node:crypto";
import { readTenancySnapshot, resetTenancyTables } from "@tali/database/testing";
import {
  BusinessResponseSchema,
  CreateBusinessResponseSchema,
  CurrentUserResponseSchema,
  ErrorEnvelopeSchema,
  LocationsResponseSchema,
  MembersResponseSchema,
  MyBusinessesResponseSchema,
} from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENT_REPLAYED_HEADER } from "../../src/business/businesses.controller.js";
import { startApi, type ApiHarness } from "../support/api-harness.js";
import { anyUuid, bearer, createBusinessAs, matches, registerActor } from "../support/tenancy-client.js";

/** Field names that must never appear in any Slice 3 response body. */
const INTERNAL_FIELDS =
  /providerSubject|provider_subject|fingerprint|"version"|membershipVersion|createdByUserId|created_at|createdAt|updatedAt|actor|audit|businessId"|userId"|prisma|deviceId|correlationId/i;

describe("Slice 3 tenancy API on real PostgreSQL", () => {
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    await resetTenancyTables();
  });

  describe("POST /v1/me/registration", () => {
    it("creates exactly one user, one external identity and the platform audit record", async () => {
      const token = api.identity.issueToken("reg-subject-1");
      const response = await http()
        .post("/v1/me/registration")
        .set(bearer(token))
        .set("x-correlation-id", "reg-corr-1")
        .send({ displayName: "Wanjiru" })
        .expect(201);

      const body = CurrentUserResponseSchema.parse(response.body);
      expect(Object.keys(response.body as object).sort()).toEqual(["displayName", "id"]);
      expect(body).toEqual({ id: anyUuid(), displayName: "Wanjiru" });
      expect(response.headers["x-correlation-id"]).toBe("reg-corr-1");

      const snapshot = await readTenancySnapshot();
      expect(snapshot.users).toEqual([{ id: body.id, displayName: "Wanjiru", status: "ACTIVE" }]);
      expect(snapshot.externalIdentities).toEqual([
        { id: anyUuid(), userId: body.id, provider: "LOCAL", providerSubject: "reg-subject-1" },
      ]);
      expect(snapshot.platformAudit.map((record) => record.action).sort()).toEqual([
        "identity.linked",
        "user.registered",
      ]);
      for (const record of snapshot.platformAudit) {
        expect(record).toMatchObject({
          subjectUserId: body.id,
          actorUserId: body.id,
          sourceChannel: "api",
          correlationId: "reg-corr-1",
          idempotencyKey: null,
        });
        expect(record.payloadText).not.toMatch(/reg-subject-1|token|Bearer/);
      }
      expect(
        api.logs.some(
          (entry) =>
            entry["msg"] === "user.registered" &&
            entry["userId"] === body.id &&
            entry["correlationId"] === "reg-corr-1",
        ),
      ).toBe(true);
      expect(JSON.stringify(api.logs)).not.toMatch(/Wanjiru|reg-subject-1/);
    });

    it("is naturally idempotent: a repeat returns 200 with the same user and writes nothing", async () => {
      const token = api.identity.issueToken("reg-subject-2");
      const first = await http().post("/v1/me/registration").set(bearer(token)).send({ displayName: "Otieno" });
      expect(first.status).toBe(201);
      const before = await readTenancySnapshot();

      const again = await http()
        .post("/v1/me/registration")
        .set(bearer(api.identity.issueToken("reg-subject-2")))
        .send({ displayName: "A Different Name" })
        .expect(200);
      expect(again.body).toEqual(first.body);
      expect(await readTenancySnapshot()).toEqual(before);
    });

    it("accepts displayName only and never an Idempotency-Key requirement", async () => {
      const token = api.identity.issueToken("reg-subject-3");
      for (const body of [
        {},
        { displayName: "" },
        { displayName: "x".repeat(401) },
        { displayName: "Ok", userId: randomUUID() },
        { displayName: "Ok", role: "OWNER" },
        { displayName: "Ok", provider: "COGNITO" },
      ]) {
        const response = await http().post("/v1/me/registration").set(bearer(token)).send(body).expect(400);
        expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("VALIDATION_FAILED");
      }
      await http().post("/v1/me/registration?x=1").set(bearer(token)).send({ displayName: "Ok" }).expect(400);
      expect((await readTenancySnapshot()).users).toEqual([]);
    });

    it("ignores client-supplied source channel and device headers", async () => {
      const token = api.identity.issueToken("reg-subject-4");
      await http()
        .post("/v1/me/registration")
        .set(bearer(token))
        .set("x-source-channel", "whatsapp")
        .set("x-device-id", randomUUID())
        .send({ displayName: "Achieng" })
        .expect(201);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.platformAudit[0]?.sourceChannel).toBe("api");
    });
  });

  describe("GET /v1/me", () => {
    it("returns the registered caller only", async () => {
      const actor = await registerActor(api, "me-subject-1", "Kamau");
      const response = await http().get("/v1/me").set(bearer(actor.token)).expect(200);
      expect(CurrentUserResponseSchema.parse(response.body)).toEqual({ id: actor.userId, displayName: "Kamau" });
      expect(Object.keys(response.body as object).sort()).toEqual(["displayName", "id"]);
    });
  });

  describe("POST /v1/businesses", () => {
    it("creates the business, one ACTIVE default location, an OWNER membership, audit and a completed idempotency record", async () => {
      const owner = await registerActor(api, "biz-owner-1", "Njeri");
      const key = randomUUID();
      const response = await http()
        .post("/v1/businesses")
        .set(bearer(owner.token))
        .set("idempotency-key", key)
        .set("x-correlation-id", "biz-corr-1")
        .send({ name: "Duka la Njeri", currencyCode: "KES", timeZone: "Africa/Nairobi" })
        .expect(201);

      const body = CreateBusinessResponseSchema.parse(response.body);
      expect(response.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
      expect(body.business).toEqual({
        id: anyUuid(),
        name: "Duka la Njeri",
        currencyCode: "KES",
        timeZone: "Africa/Nairobi",
      });
      expect(body.defaultLocation).toMatchObject({ isDefault: true, status: "ACTIVE" });
      expect(body.membership).toEqual({ id: anyUuid(), role: "OWNER", status: "ACTIVE" });
      expect(JSON.stringify(response.body)).not.toMatch(INTERNAL_FIELDS);

      const snapshot = await readTenancySnapshot();
      expect(snapshot.businesses).toEqual([
        {
          id: body.business.id,
          name: "Duka la Njeri",
          currencyCode: "KES",
          timeZone: "Africa/Nairobi",
          status: "ACTIVE",
          createdByUserId: owner.userId,
        },
      ]);
      expect(snapshot.locations).toEqual([
        {
          id: body.defaultLocation.id,
          businessId: body.business.id,
          name: body.defaultLocation.name,
          isDefault: true,
          status: "ACTIVE",
        },
      ]);
      expect(snapshot.memberships).toEqual([
        {
          id: body.membership.id,
          businessId: body.business.id,
          userId: owner.userId,
          role: "OWNER",
          status: "ACTIVE",
          version: 1,
        },
      ]);
      expect(snapshot.businessAudit.length).toBeGreaterThanOrEqual(3);
      for (const record of snapshot.businessAudit) {
        expect(record).toMatchObject({
          businessId: body.business.id,
          actorUserId: owner.userId,
          sourceChannel: "api",
          correlationId: "biz-corr-1",
          deviceId: null,
        });
      }
      expect(snapshot.userIdempotency).toEqual([
        expect.objectContaining({
          userId: owner.userId,
          idempotencyKey: key,
          fingerprintHex: matches(/^[0-9a-f]{64}$/),
          fingerprintVersion: 1,
          resourceId: body.business.id,
        }),
      ]);
      expect(
        api.logs.some((entry) => entry["msg"] === "business.created" && entry["businessId"] === body.business.id),
      ).toBe(true);
    });

    it("replays the same key and body with the original result and no second effect", async () => {
      const owner = await registerActor(api, "biz-owner-2", "Mwangi");
      const key = randomUUID();
      const first = await createBusinessAs(api, owner, { name: "Mwangi Provisions" }, key);
      const before = await readTenancySnapshot();

      const replay = await http()
        .post("/v1/businesses")
        .set(bearer(owner.token))
        .set("idempotency-key", key)
        .send({ name: "Mwangi Provisions", currencyCode: "KES", timeZone: "Africa/Nairobi" })
        .expect(201);
      expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe("true");
      expect(CreateBusinessResponseSchema.parse(replay.body)).toEqual(first);
      expect(await readTenancySnapshot()).toEqual(before);
    });

    it("rejects the same key with a different body as 409 IDEMPOTENCY_KEY_REUSED and writes nothing", async () => {
      const owner = await registerActor(api, "biz-owner-3", "Chebet");
      const key = randomUUID();
      await createBusinessAs(api, owner, { name: "Chebet Store" }, key);
      const before = await readTenancySnapshot();

      const response = await http()
        .post("/v1/businesses")
        .set(bearer(owner.token))
        .set("idempotency-key", key)
        .send({ name: "Another Store", currencyCode: "KES", timeZone: "Africa/Nairobi" })
        .expect(409);
      expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await readTenancySnapshot()).toEqual(before);
    });

    it("scopes keys per user: another user's identical key is an independent request", async () => {
      const first = await registerActor(api, "biz-owner-4", "Wairimu");
      const second = await registerActor(api, "biz-owner-5", "Kiprono");
      const key = randomUUID();
      const a = await createBusinessAs(api, first, { name: "Shop" }, key);
      const b = await createBusinessAs(api, second, { name: "Shop" }, key);
      expect(a.business.id).not.toBe(b.business.id);
      expect((await readTenancySnapshot()).businesses).toHaveLength(2);
    });

    it("requires a UUID Idempotency-Key", async () => {
      const owner = await registerActor(api, "biz-owner-6", "Akinyi");
      const body = { name: "Keyless", currencyCode: "KES", timeZone: "Africa/Nairobi" };
      const missing = await http().post("/v1/businesses").set(bearer(owner.token)).send(body).expect(400);
      expect(ErrorEnvelopeSchema.parse(missing.body).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      for (const bad of ["not-a-uuid", "", "x".repeat(129)]) {
        const response = await http()
          .post("/v1/businesses")
          .set(bearer(owner.token))
          .set("idempotency-key", bad)
          .send(body);
        expect(response.status).toBe(400);
        expect(ErrorEnvelopeSchema.parse(response.body).error.code).toMatch(
          /^(VALIDATION_FAILED|IDEMPOTENCY_KEY_REQUIRED)$/,
        );
      }
      expect((await readTenancySnapshot()).businesses).toEqual([]);
    });

    it("rejects unknown fields, over-length values, bad currency or time zone and query parameters, writing nothing", async () => {
      const owner = await registerActor(api, "biz-owner-7", "Muthoni");
      const valid = { name: "Valid", currencyCode: "KES", timeZone: "Africa/Nairobi" };
      const cases: { body: Record<string, unknown>; code: string }[] = [
        { body: { ...valid, businessId: randomUUID() }, code: "VALIDATION_FAILED" },
        { body: { ...valid, ownerUserId: randomUUID() }, code: "VALIDATION_FAILED" },
        { body: { ...valid, status: "ACTIVE" }, code: "VALIDATION_FAILED" },
        { body: { ...valid, name: "x".repeat(481) }, code: "VALIDATION_FAILED" },
        { body: { ...valid, name: "" }, code: "VALIDATION_FAILED" },
        { body: { ...valid, currencyCode: "kes" }, code: "VALIDATION_FAILED" },
        { body: { ...valid, timeZone: "Not/AZone" }, code: "VALIDATION_FAILED" },
        { body: { ...valid, timeZone: "x".repeat(65) }, code: "VALIDATION_FAILED" },
        { body: { name: "Valid" }, code: "VALIDATION_FAILED" },
      ];
      for (const { body, code } of cases) {
        const response = await http()
          .post("/v1/businesses")
          .set(bearer(owner.token))
          .set("idempotency-key", randomUUID())
          .send(body);
        expect({ body, status: response.status }).toEqual({ body, status: 400 });
        expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe(code);
      }
      await http()
        .post("/v1/businesses?businessId=x")
        .set(bearer(owner.token))
        .set("idempotency-key", randomUUID())
        .send(valid)
        .expect(400);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.businesses).toEqual([]);
      expect(snapshot.userIdempotency).toEqual([]);
    });

    it("rejects a currency that is not in the reference table without leaking database detail", async () => {
      const owner = await registerActor(api, "biz-owner-8", "Kariuki");
      const response = await http()
        .post("/v1/businesses")
        .set(bearer(owner.token))
        .set("idempotency-key", randomUUID())
        .send({ name: "Unknown Currency", currencyCode: "XTS", timeZone: "Africa/Nairobi" });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(JSON.stringify(response.body)).not.toMatch(/prisma|P2\d{3}|foreign key|constraint|currencies/i);
      expect((await readTenancySnapshot()).businesses).toEqual([]);
    });

    it("works for currencies with different minor-unit exponents", async () => {
      const owner = await registerActor(api, "biz-owner-9", "Halima");
      for (const currencyCode of ["JPY", "BHD", "NGN"]) {
        const created = await createBusinessAs(api, owner, { name: `Shop ${currencyCode}`, currencyCode });
        expect(created.business.currencyCode).toBe(currencyCode);
      }
    });
  });

  describe("body parsing", () => {
    it("answers malformed JSON with VALIDATION_FAILED and an oversized body with 413, quoting nothing", async () => {
      const owner = await registerActor(api, "parse-subject-1", "Baraka");
      const malformed = await http()
        .post("/v1/me/registration")
        .set(bearer(owner.token))
        .set("content-type", "application/json")
        .send('{"displayName": "secret-body-text",');
      expect(malformed.status).toBe(400);
      expect(ErrorEnvelopeSchema.parse(malformed.body).error.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(malformed.body)).not.toContain("secret-body-text");

      const huge = await http()
        .post("/v1/businesses")
        .set(bearer(owner.token))
        .set("idempotency-key", randomUUID())
        .send({ name: "x".repeat(20_000), currencyCode: "KES", timeZone: "Africa/Nairobi" });
      expect(huge.status).toBe(413);
      expect(ErrorEnvelopeSchema.parse(huge.body).error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("lists", () => {
    it("GET /v1/me/businesses lists only the caller's businesses with keyset pagination", async () => {
      const owner = await registerActor(api, "list-owner-1", "Zawadi");
      const other = await registerActor(api, "list-owner-2", "Imani");
      const created = [];
      for (const name of ["One", "Two", "Three"]) created.push(await createBusinessAs(api, owner, { name }));
      await createBusinessAs(api, other, { name: "Not Mine" });

      const firstPage = MyBusinessesResponseSchema.parse(
        (await http().get("/v1/me/businesses?limit=2").set(bearer(owner.token)).expect(200)).body,
      );
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const secondPage = MyBusinessesResponseSchema.parse(
        (
          await http()
            .get(`/v1/me/businesses?limit=2&after=${encodeURIComponent(firstPage.nextCursor ?? "")}`)
            .set(bearer(owner.token))
            .expect(200)
        ).body,
      );
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();
      const listed = [...firstPage.items, ...secondPage.items].map((entry) => entry.business.id).sort();
      expect(listed).toEqual(created.map((entry) => entry.business.id).sort());
      for (const entry of [...firstPage.items, ...secondPage.items]) {
        expect(entry.membership.role).toBe("OWNER");
      }
      expect(JSON.stringify(firstPage)).not.toMatch(INTERNAL_FIELDS);
    });

    it("rejects bad pagination and unexpected query parameters", async () => {
      const owner = await registerActor(api, "list-owner-3", "Neema");
      const created = await createBusinessAs(api, owner, { name: "Paged" });
      const base = `/v1/businesses/${created.business.id}`;
      for (const path of [
        "/v1/me/businesses?limit=0",
        "/v1/me/businesses?limit=101",
        "/v1/me/businesses?limit=-1",
        "/v1/me/businesses?limit=abc",
        "/v1/me/businesses?limit=1000",
        "/v1/me/businesses?limit=1&limit=2",
        "/v1/me/businesses?after=",
        `/v1/me/businesses?after=${"x".repeat(257)}`,
        "/v1/me/businesses?after=not-a-cursor",
        "/v1/me/businesses?sort=name",
        "/v1/me?x=1",
        `${base}?x=1`,
        `${base}/locations?limit=0`,
        `${base}/locations?businessId=${randomUUID()}`,
        `${base}/members?limit=101`,
        `${base}/members?role=OWNER`,
      ]) {
        const response = await http().get(path).set(bearer(owner.token));
        expect({ path, status: response.status }).toEqual({ path, status: 400 });
        expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("business reads return strict contracts", async () => {
      const owner = await registerActor(api, "read-owner-1", "Faraji");
      const created = await createBusinessAs(api, owner, { name: "Faraji Mart" });
      const base = `/v1/businesses/${created.business.id}`;

      const business = await http().get(base).set(bearer(owner.token)).expect(200);
      expect(BusinessResponseSchema.parse(business.body)).toEqual(created.business);
      expect(Object.keys(business.body as object).sort()).toEqual(["currencyCode", "id", "name", "timeZone"]);

      const locations = LocationsResponseSchema.parse(
        (await http().get(`${base}/locations`).set(bearer(owner.token)).expect(200)).body,
      );
      expect(locations).toEqual({ items: [created.defaultLocation], nextCursor: null });

      const members = await http().get(`${base}/members`).set(bearer(owner.token)).expect(200);
      expect(MembersResponseSchema.parse(members.body)).toEqual({
        items: [{ id: created.membership.id, displayName: "Faraji", role: "OWNER", status: "ACTIVE" }],
        nextCursor: null,
      });
      for (const body of [business.body, locations, members.body]) {
        expect(JSON.stringify(body)).not.toMatch(INTERNAL_FIELDS);
        expect(JSON.stringify(body)).not.toContain("read-owner-1");
      }
    });
  });
});
