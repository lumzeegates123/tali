import { ConcurrentModificationError, parsePageRequest } from "@tali/application";
import {
  externalIdentity,
  parseDisplayName,
  parseCurrencyCode,
  parseProviderSubject,
  registerUser,
  restoreMembership,
  type BusinessId,
} from "@tali/domain";
import { describe, expect, it } from "vitest";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * The PostgreSQL adapters for the Slice 1 ports: round trips, the registration
 * savepoint, tenant scoping on every business-owned read and write, keyset
 * pagination and reference currencies.
 */
describe("Build 1 repositories", () => {
  const harness = useTenancyHarness();
  const { owner, repositories, unitOfWork } = harness;

  const count = async (table: string) =>
    Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

  describe("users and external identities", () => {
    it("registers a user with its identity link and finds it by identity and by ID", async () => {
      const tenancy = harness.compose();
      const { userId } = await tenancy.registeredUser("subject-1", "Ngozi");
      await unitOfWork.run(async (scope) => {
        const providerSubject = parseProviderSubject("subject-1");
        const found = await repositories.users.findByExternalIdentity(scope, { provider: "LOCAL", providerSubject });
        expect(found?.user).toMatchObject({ id: userId, displayName: "Ngozi", status: "ACTIVE" });
        expect(found?.externalIdentity).toMatchObject({ userId, provider: "LOCAL", providerSubject: "subject-1" });
        expect((await repositories.users.findById(scope, userId))?.id).toBe(userId);
        expect(await repositories.users.findByExternalIdentity(scope, { provider: "COGNITO", providerSubject })).toBe(
          undefined,
        );
      });
    });

    it("an already-linked identity inserts nothing: the user row is rolled back to the savepoint", async () => {
      const tenancy = harness.compose();
      await tenancy.registeredUser("subject-1");
      const { ids, clock } = harness.world();
      const outcome = await unitOfWork.run(async (scope) => {
        const user = registerUser({ id: ids.newId("User"), displayName: parseDisplayName("Late"), now: clock.now() });
        const identity = externalIdentity({
          id: ids.newId("ExternalIdentity"),
          userId: user.id,
          provider: "LOCAL",
          providerSubject: "subject-1",
          createdAt: clock.now(),
        });
        const result = await repositories.users.insertRegistration(scope, { user, externalIdentity: identity });
        return { result, stillVisible: await repositories.users.findById(scope, user.id) };
      });
      expect(outcome).toEqual({ result: "identity-already-linked", stillVisible: undefined });
      expect(await count("users")).toBe(1);
      expect(await count("external_identities")).toBe(1);
    });

    it("concurrent first sign-ins of one identity create exactly one user", async () => {
      const tenancy = harness.compose();
      const results = await Promise.all(Array.from({ length: 4 }, () => tenancy.registeredUser("subject-race")));
      expect(new Set(results.map((result) => result.userId)).size).toBe(1);
      expect(await count("users")).toBe(1);
      expect(await count("external_identities")).toBe(1);
      expect(await count("platform_audit_records")).toBe(2);
    });
  });

  describe("tenant scoping", () => {
    async function twoTenants() {
      const tenancy = harness.compose();
      const alice = await tenancy.registeredUser("alice", "Alice");
      const bola = await tenancy.registeredUser("bola", "Bola");
      const a = await tenancy.create(alice, { name: "Alice Stores" });
      const b = await tenancy.create(bola, { name: "Bola Stores" });
      return { tenancy, alice, bola, a: a.result.business.id, b: b.result.business.id };
    }

    it("reads of business-owned rows return only the requested business's rows", async () => {
      const { alice, bola, a, b } = await twoTenants();
      await unitOfWork.run(async (scope) => {
        const page = parsePageRequest();
        const aLocations = await repositories.locations.listForBusiness(scope, a, page);
        expect(aLocations.items.map((location) => location.businessId)).toEqual([a]);
        const aMembers = await repositories.memberships.listMembers(scope, a, page);
        expect(aMembers.items.map((member) => member.membership.userId)).toEqual([alice.userId]);
        expect(await repositories.memberships.findByBusinessAndUser(scope, a, bola.userId)).toBe(undefined);
        expect(await repositories.memberships.countActiveOwners(scope, b)).toBe(1);
        const accessible = await repositories.memberships.listAccessibleBusinesses(scope, alice.userId, page);
        expect(accessible.items.map((item) => item.business.id)).toEqual([a]);
      });
    });

    it("an update naming another business matches nothing and changes nothing", async () => {
      const { bola, a, b } = await twoTenants();
      const bolaMembership = await unitOfWork.run((scope) =>
        repositories.memberships.findByBusinessAndUser(scope, b, bola.userId),
      );
      if (bolaMembership === undefined) throw new Error("membership missing");
      const forged = restoreMembership({ ...bolaMembership, businessId: a });
      const next = restoreMembership({ ...forged, role: "CASHIER", version: forged.version + 1 });
      await expect(
        unitOfWork.run((scope) => repositories.memberships.update(scope, forged, next)),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      const { rows } = await owner.query(
        `SELECT business_id::text, role, version FROM business_memberships WHERE id = $1`,
        [bolaMembership.id],
      );
      expect(rows).toEqual([{ business_id: b, role: "OWNER", version: 1 }]);
    });

    it("the accessible-business listing hides suspended memberships and suspended businesses", async () => {
      const { tenancy, alice, bola, a, b } = await twoTenants();
      await harness.addMember(b, alice, "CASHIER", "SUSPENDED");
      const c = (await tenancy.create(bola, { name: "Closed Shop" })).result.business.id;
      await harness.addMember(c, alice, "MANAGER");
      await owner.query(`UPDATE businesses SET status = 'SUSPENDED' WHERE id = $1`, [c]);
      const accessible = await unitOfWork.run((scope) =>
        repositories.memberships.listAccessibleBusinesses(scope, alice.userId, parsePageRequest()),
      );
      expect(accessible.items.map((item) => item.business.id)).toEqual([a]);
    });
  });

  describe("keyset pagination", () => {
    it("pages through members in ID order without gaps or repeats", async () => {
      const tenancy = harness.compose();
      const ownerUser = await tenancy.registeredUser("owner");
      const businessId: BusinessId = (await tenancy.create(ownerUser)).result.business.id;
      for (let index = 0; index < 4; index += 1) {
        await harness.addMember(businessId, await tenancy.registeredUser(`member-${index}`), "CASHIER");
      }
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await unitOfWork.run((scope) =>
          repositories.memberships.listMembers(
            scope,
            businessId,
            parsePageRequest(after === undefined ? { limit: 2 } : { limit: 2, after }),
          ),
        );
        seen.push(...page.items.map((item) => item.membership.id));
        after = page.nextCursor ?? undefined;
        pages += 1;
      } while (after !== undefined);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect([...seen].sort()).toEqual(seen);
    });

    it("the last full page reports no next cursor", async () => {
      const tenancy = harness.compose();
      const ownerUser = await tenancy.registeredUser("owner");
      const businessId = (await tenancy.create(ownerUser)).result.business.id;
      await harness.addMember(businessId, await tenancy.registeredUser("member"), "CASHIER");
      const page = await unitOfWork.run((scope) =>
        repositories.memberships.listMembers(scope, businessId, parsePageRequest({ limit: 2 })),
      );
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe(null);
    });
  });

  describe("reference currencies", () => {
    it.each([
      ["NGN", 2],
      ["KES", 2],
      ["JPY", 0],
      ["BHD", 3],
    ])("%s has %i minor-unit digits", async (code, digits) => {
      const currency = await unitOfWork.run((scope) =>
        repositories.currencies.findByCode(scope, parseCurrencyCode(code)),
      );
      expect(currency).toMatchObject({ code, minorUnitDigits: digits });
    });

    it("an unknown code is not found", async () => {
      await expect(
        unitOfWork.run((scope) => repositories.currencies.findByCode(scope, parseCurrencyCode("USD"))),
      ).resolves.toBe(undefined);
    });
  });

  describe("audit payloads", () => {
    it("stores the payload as the exact JSON text, so octet_length equals the adapter's byte count", async () => {
      const tenancy = harness.compose();
      const user = await tenancy.registeredUser("owner");
      await tenancy.create(user, { name: "Ẹ̀kọ́ Provisions" });
      const { rows } = await owner.query<{ action: string; bytes: number; text: string }>(
        `SELECT action, octet_length(payload::text) AS bytes, payload::text AS text FROM business_audit_records ORDER BY action`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.bytes).toBe(Buffer.byteLength(row.text, "utf8"));
        expect(JSON.stringify(JSON.parse(row.text))).toBe(row.text);
      }
    });
  });
});
