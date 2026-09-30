import { randomUUID } from "node:crypto";
import { readTenancySnapshot, resetTenancyTables, tenancyFixtures } from "@tali/database/testing";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import { ErrorEnvelopeSchema, MembersResponseSchema, MembershipRoleWireSchema } from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startApi, type ApiHarness } from "../support/api-harness.js";
import { metadataRoutes } from "../support/route-inventory.js";
import { anyString, bearer, createBusinessAs, registerActor, type RegisteredActor } from "../support/tenancy-client.js";

const code = (body: unknown) => ErrorEnvelopeSchema.parse(body).error.code;

describe("Slice 3 authentication and tenant isolation", () => {
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });

  /**
   * userA owns business A, userB owns business B, userAB owns neither but is
   * a MANAGER in A and a CASHIER in B; `disabled` was a MANAGER in A before
   * being disabled; `unregistered` holds a valid token but never registered.
   */
  interface World {
    readonly userA: RegisteredActor;
    readonly userB: RegisteredActor;
    readonly userAB: RegisteredActor;
    readonly disabled: RegisteredActor;
    readonly unregisteredToken: string;
    readonly businessA: string;
    readonly businessB: string;
    readonly membershipAB_A: string;
  }
  let world: World;

  beforeEach(async () => {
    await resetTenancyTables();
    const userA = await registerActor(api, "user-a", "Amani");
    const userB = await registerActor(api, "user-b", "Baraka");
    const userAB = await registerActor(api, "user-ab", "Chausiku");
    const disabled = await registerActor(api, "user-disabled", "Dalila");
    const businessA = (await createBusinessAs(api, userA, { name: "Business A" })).business.id;
    const businessB = (await createBusinessAs(api, userB, { name: "Business B" })).business.id;
    const membershipAB_A = uuidV7IdGenerator.newId("membership");
    await tenancyFixtures.insertMembership({
      id: membershipAB_A,
      businessId: businessA,
      userId: userAB.userId,
      role: "MANAGER",
    });
    await tenancyFixtures.insertMembership({
      id: uuidV7IdGenerator.newId("membership"),
      businessId: businessB,
      userId: userAB.userId,
      role: "CASHIER",
    });
    await tenancyFixtures.insertMembership({
      id: uuidV7IdGenerator.newId("membership"),
      businessId: businessA,
      userId: disabled.userId,
      role: "MANAGER",
    });
    await tenancyFixtures.setUserStatus(disabled.userId, "DISABLED");
    world = {
      userA,
      userB,
      userAB,
      disabled,
      unregisteredToken: api.identity.issueToken("user-unregistered"),
      businessA,
      businessB,
      membershipAB_A,
    };
  });

  const businessRoutes = (businessId: string) => [
    `/v1/businesses/${businessId}`,
    `/v1/businesses/${businessId}/locations`,
    `/v1/businesses/${businessId}/members`,
  ];

  describe("authentication matrix", () => {
    const protectedRequests = (): { method: "get" | "post"; path: string }[] => [
      { method: "post", path: "/v1/me/registration" },
      { method: "get", path: "/v1/me" },
      { method: "get", path: "/v1/me/businesses" },
      { method: "post", path: "/v1/businesses" },
      ...businessRoutes(world.businessA).map((path) => ({ method: "get" as const, path })),
    ];

    it.each([
      ["no Authorization header", undefined],
      ["an empty bearer", "Bearer "],
      ["a non-bearer scheme", "Basic dXNlcjpwYXNz"],
      ["a lowercase scheme with no token", "bearer"],
      ["a token the provider does not know", "Bearer not-a-real-token"],
      ["a token with extra parts", "Bearer a b"],
    ])("rejects %s with 401 UNAUTHENTICATED on every route", async (_name, authorization) => {
      for (const { method, path } of protectedRequests()) {
        const pending = http()[method](path);
        if (authorization !== undefined) pending.set("authorization", authorization);
        const response = await pending.send({});
        expect({ path, status: response.status }).toEqual({ path, status: 401 });
        expect(code(response.body)).toBe("UNAUTHENTICATED");
      }
    });

    it("rejects expired and revoked tokens with 401 and logs only a bounded reason", async () => {
      const expired = api.identity.issueToken("user-a", { ttlSeconds: -60 });
      const revoked = api.identity.issueToken("user-a");
      api.identity.revoke(revoked);
      for (const token of [expired, revoked]) {
        const response = await http().get("/v1/me").set(bearer(token)).expect(401);
        expect(code(response.body)).toBe("UNAUTHENTICATED");
      }
      const rejections = api.logs.filter((entry) => entry["msg"] === "auth.token_rejected");
      expect(rejections.length).toBeGreaterThan(0);
      for (const entry of rejections) {
        expect(["missing_token", "malformed_authorization", "verification_failed"]).toContain(entry["reason"]);
      }
      const allLogs = JSON.stringify(api.logs);
      expect(allLogs).not.toContain(expired);
      expect(allLogs).not.toContain(revoked);
      expect(allLogs).not.toMatch(/Basic dXNlcjpwYXNz|not-a-real-token/);
    });

    it("lets an unregistered identity call registration only; everything else is USER_NOT_REGISTERED", async () => {
      for (const path of ["/v1/me", "/v1/me/businesses", ...businessRoutes(world.businessA)]) {
        const response = await http().get(path).set(bearer(world.unregisteredToken));
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
        expect(code(response.body)).toBe("USER_NOT_REGISTERED");
      }
      const create = await http()
        .post("/v1/businesses")
        .set(bearer(world.unregisteredToken))
        .set("idempotency-key", randomUUID())
        .send({ name: "Sneaky", currencyCode: "KES", timeZone: "Africa/Nairobi" })
        .expect(403);
      expect(code(create.body)).toBe("USER_NOT_REGISTERED");
      expect((await readTenancySnapshot()).businesses).toHaveLength(2);
      expect(
        api.logs.some((entry) => entry["msg"] === "context.denied" && entry["reason"] === "user_not_registered"),
      ).toBe(true);

      await http()
        .post("/v1/me/registration")
        .set(bearer(world.unregisteredToken))
        .send({ displayName: "Late" })
        .expect(201);
    });

    it("answers a disabled user with USER_DISABLED everywhere, including registration, and writes nothing", async () => {
      const before = await readTenancySnapshot();
      for (const path of ["/v1/me", "/v1/me/businesses", ...businessRoutes(world.businessA)]) {
        const response = await http().get(path).set(bearer(world.disabled.token));
        expect({ path, status: response.status }).toEqual({ path, status: 403 });
        expect(code(response.body)).toBe("USER_DISABLED");
      }
      const registration = await http()
        .post("/v1/me/registration")
        .set(bearer(world.disabled.token))
        .send({ displayName: "Again" });
      expect(registration.status).toBe(403);
      expect(code(registration.body)).toBe("USER_DISABLED");
      const create = await http()
        .post("/v1/businesses")
        .set(bearer(world.disabled.token))
        .set("idempotency-key", randomUUID())
        .send({ name: "Blocked", currencyCode: "KES", timeZone: "Africa/Nairobi" })
        .expect(403);
      expect(code(create.body)).toBe("USER_DISABLED");
      expect(await readTenancySnapshot()).toEqual(before);
    });
  });

  describe("tenant hiding (ADR-005)", () => {
    it("userA cannot see business B and userB cannot see business A: 404 with no detail", async () => {
      for (const [actor, foreign] of [
        [world.userA, world.businessB],
        [world.userB, world.businessA],
      ] as const) {
        for (const path of businessRoutes(foreign)) {
          const response = await http().get(path).set(bearer(actor.token));
          expect({ path, status: response.status }).toEqual({ path, status: 404 });
          expect(ErrorEnvelopeSchema.parse(response.body)).toEqual({
            error: { code: "NOT_FOUND", message: anyString() },
          });
          expect(JSON.stringify(response.body)).not.toContain(foreign);
        }
      }
      expect(
        api.logs.some((entry) => entry["msg"] === "context.denied" && entry["reason"] === "business_not_accessible"),
      ).toBe(true);
    });

    it("every business-scoped route the app serves is authenticated and hides other tenants", async () => {
      const routes = metadataRoutes(api.app).filter((route) => route.path.startsWith("/v1/businesses/:businessId"));
      expect(routes.length).toBeGreaterThanOrEqual(3);
      const unknown = uuidV7IdGenerator.newId("business");
      for (const route of routes) {
        const call = (businessId: string, token?: string) => {
          const pending = http()[route.method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete"](
            route.path.replace(":businessId", businessId),
          );
          return token === undefined ? pending : pending.set(bearer(token));
        };
        const label = `${route.method} ${route.path}`;
        expect({ label, status: (await call(world.businessA)).status }).toEqual({ label, status: 401 });
        for (const target of [world.businessB, unknown, "not-a-uuid"]) {
          const response = await call(target, world.userA.token);
          expect({ label, target, status: response.status }).toEqual({ label, target, status: 404 });
          expect(code(response.body)).toBe("NOT_FOUND");
        }
        const own = await call(world.businessA, world.userA.token);
        expect({ label, ok: own.status < 400 }).toEqual({ label, ok: true });
      }
    });

    it("unknown and malformed business IDs are indistinguishable from foreign ones", async () => {
      const unknown = uuidV7IdGenerator.newId("business");
      // UUIDs are case-insensitive (RFC 9562), so an uppercase *foreign* ID must still be hidden.
      const malformed = [
        "not-a-uuid",
        "123",
        "00000000-0000-0000-0000-000000000000",
        world.businessB.toUpperCase(),
        `${world.businessA}x`,
        "x".repeat(300),
        "%20",
      ];
      const foreign = await http().get(`/v1/businesses/${world.businessB}`).set(bearer(world.userA.token));
      for (const id of [unknown, ...malformed]) {
        for (const suffix of ["", "/locations", "/members"]) {
          const response = await http().get(`/v1/businesses/${id}${suffix}`).set(bearer(world.userA.token));
          expect({ id, suffix, status: response.status }).toEqual({ id, suffix, status: 404 });
          expect(response.body).toEqual(foreign.body);
        }
      }
    });

    it("path validation never overrides hiding: malformed IDs with bad query parameters are still 404", async () => {
      const response = await http().get("/v1/businesses/not-a-uuid/members?limit=0").set(bearer(world.userA.token));
      expect(response.status).toBe(404);
      expect(code(response.body)).toBe("NOT_FOUND");
    });

    it("a SUSPENDED business is hidden from its own owner", async () => {
      await tenancyFixtures.setBusinessStatus(world.businessA, "SUSPENDED");
      for (const path of businessRoutes(world.businessA)) {
        const response = await http().get(path).set(bearer(world.userA.token));
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
      }
      const listed = await http().get("/v1/me/businesses").set(bearer(world.userA.token)).expect(200);
      expect(JSON.stringify(listed.body)).not.toContain(world.businessA);
    });

    it("a SUSPENDED membership hides the business from that member only", async () => {
      await tenancyFixtures.setMembershipStatus(world.membershipAB_A, "SUSPENDED");
      for (const path of businessRoutes(world.businessA)) {
        const response = await http().get(path).set(bearer(world.userAB.token));
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
      }
      await http().get(`/v1/businesses/${world.businessA}`).set(bearer(world.userA.token)).expect(200);
      await http().get(`/v1/businesses/${world.businessB}`).set(bearer(world.userAB.token)).expect(200);
    });

    it("userAB sees exactly both businesses, each with its own role, and nothing else", async () => {
      const response = await http().get("/v1/me/businesses").set(bearer(world.userAB.token)).expect(200);
      const items = (response.body as { items: { business: { id: string }; membership: { role: string } }[] }).items;
      expect(items.map((item) => [item.business.id, item.membership.role]).sort()).toEqual(
        [
          [world.businessA, "MANAGER"],
          [world.businessB, "CASHIER"],
        ].sort(),
      );
      const own = await http().get("/v1/me/businesses").set(bearer(world.userA.token)).expect(200);
      expect(JSON.stringify(own.body)).not.toContain(world.businessB);
    });

    it("the route's business decides the context; client-supplied tenant or actor hints are ignored", async () => {
      const response = await http()
        .get(`/v1/businesses/${world.businessB}`)
        .set(bearer(world.userA.token))
        .set("x-business-id", world.businessA)
        .set("x-user-id", world.userB.userId)
        .set("x-device-id", randomUUID())
        .set("x-location-id", randomUUID());
      expect(response.status).toBe(404);
      const own = await http()
        .get(`/v1/businesses/${world.businessA}`)
        .set(bearer(world.userA.token))
        .set("x-business-id", world.businessB)
        .expect(200);
      expect((own.body as { id: string }).id).toBe(world.businessA);
    });
  });

  describe("member:read permission matrix", () => {
    it("the wire role list matches the roles the database accepts", async () => {
      const businessId = world.businessA;
      for (const role of MembershipRoleWireSchema.options) {
        const actor = await registerActor(api, `role-check-${role.toLowerCase()}`, `Role ${role}`);
        await tenancyFixtures.insertMembership({
          id: uuidV7IdGenerator.newId("membership"),
          businessId,
          userId: actor.userId,
          role,
        });
      }
      const members = MembersResponseSchema.parse(
        (await http().get(`/v1/businesses/${businessId}/members?limit=100`).set(bearer(world.userA.token)).expect(200))
          .body,
      );
      expect(new Set(members.items.map((item) => item.role))).toEqual(new Set(MembershipRoleWireSchema.options));
    });

    it.each([
      ["OWNER", 200],
      ["MANAGER", 200],
      ["CASHIER", 403],
      ["STOCK_KEEPER", 403],
      ["ACCOUNTANT", 403],
    ] as const)("%s listing members answers %i; business and locations stay readable", async (role, status) => {
      const actor = await registerActor(api, `perm-${role.toLowerCase()}`, `Perm ${role}`);
      await tenancyFixtures.insertMembership({
        id: uuidV7IdGenerator.newId("membership"),
        businessId: world.businessB,
        userId: actor.userId,
        role,
      });
      const members = await http().get(`/v1/businesses/${world.businessB}/members`).set(bearer(actor.token));
      expect(members.status).toBe(status);
      if (status === 403) {
        expect(code(members.body)).toBe("PERMISSION_DENIED");
        expect(JSON.stringify(members.body)).not.toMatch(/Baraka|OWNER/);
      } else {
        MembersResponseSchema.parse(members.body);
      }
      await http().get(`/v1/businesses/${world.businessB}`).set(bearer(actor.token)).expect(200);
      await http().get(`/v1/businesses/${world.businessB}/locations`).set(bearer(actor.token)).expect(200);
      // The same actor has no membership in business A at all: hidden, not forbidden.
      await http().get(`/v1/businesses/${world.businessA}/members`).set(bearer(actor.token)).expect(404);
    });
  });
});
