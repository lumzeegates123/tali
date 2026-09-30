import {
  foundBusiness,
  parseBusinessName,
  parseBusinessTimeZoneId,
  parseCurrencyCode,
  parseDisplayName,
  registerUser,
  restoreMembership,
  type BusinessId,
  type BusinessMembership,
} from "@tali/domain";
import { describe, expect, it } from "vitest";
import { ConcurrentModificationError } from "../errors/application-error.js";
import { InMemoryTenancyStore } from "./in-memory-tenancy-store.js";
import { InMemoryUnitOfWork } from "./in-memory-unit-of-work.js";
import { SequentialIdGenerator } from "./sequential-id-generator.js";

const NOW = new Date("2026-09-29T08:00:00.000Z");

/** The Slice 2 MembershipRepository additions on the in-memory fake (ADR-005 section 10). */
describe("InMemoryTenancyStore memberships: lock, count and update", () => {
  function setup() {
    const ids = new SequentialIdGenerator();
    const unitOfWork = new InMemoryUnitOfWork();
    const store = new InMemoryTenancyStore({ unitOfWork });
    const founder = registerUser({ id: ids.newId("User"), displayName: parseDisplayName("Founder"), now: NOW });
    store.putUser(founder);
    const business = foundBusiness({
      id: ids.newId("Business"),
      name: parseBusinessName("Shop"),
      currencyCode: parseCurrencyCode("NGN"),
      timeZone: parseBusinessTimeZoneId("Africa/Lagos"),
      createdByUserId: founder.id,
      now: NOW,
    });
    store.putBusiness(business);
    const otherBusinessId = ids.newId("Business");
    const membership = (businessId: BusinessId, props: Partial<BusinessMembership> = {}) =>
      restoreMembership({
        id: ids.newId("Membership"),
        businessId,
        userId: ids.newId("User"),
        role: "OWNER",
        status: "ACTIVE",
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
        ...props,
      });
    return {
      ids,
      unitOfWork,
      store,
      repository: store.membershipRepository,
      businessId: business.id,
      otherBusinessId,
      membership,
    };
  }

  it("the lock reports whether the business exists", async () => {
    const { unitOfWork, repository, businessId, otherBusinessId } = setup();
    await unitOfWork.run(async (scope) => {
      expect(await repository.lockBusinessForMembershipChange(scope, businessId)).toBe(true);
      expect(await repository.lockBusinessForMembershipChange(scope, otherBusinessId)).toBe(false);
    });
  });

  it("counts only ACTIVE OWNER memberships of the given business", async () => {
    const { unitOfWork, store, repository, businessId, otherBusinessId, membership } = setup();
    store.putMembership(membership(businessId));
    store.putMembership(membership(businessId, { status: "SUSPENDED" }));
    store.putMembership(membership(businessId, { role: "MANAGER" }));
    store.putMembership(membership(otherBusinessId));
    await expect(unitOfWork.run((scope) => repository.countActiveOwners(scope, businessId))).resolves.toBe(1);
  });

  it("update applies a one-version step and rejects a stale or foreign previous state", async () => {
    const { unitOfWork, store, repository, businessId, otherBusinessId, membership } = setup();
    const current = membership(businessId);
    store.putMembership(current);
    const next = restoreMembership({ ...current, role: "MANAGER", version: 2 });
    await unitOfWork.run((scope) => repository.update(scope, current, next));
    expect(store.memberships).toEqual([next]);

    const again = restoreMembership({ ...current, role: "CASHIER", version: 2 });
    await expect(unitOfWork.run((scope) => repository.update(scope, current, again))).rejects.toBeInstanceOf(
      ConcurrentModificationError,
    );
    const foreign = restoreMembership({ ...next, businessId: otherBusinessId });
    await expect(
      unitOfWork.run((scope) => repository.update(scope, foreign, restoreMembership({ ...foreign, version: 3 }))),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(store.memberships).toEqual([next]);
  });

  it("update refuses a transition that changes identity or skips a version", async () => {
    const { ids, unitOfWork, store, repository, businessId, membership } = setup();
    const current = membership(businessId);
    store.putMembership(current);
    for (const bad of [
      restoreMembership({ ...current, version: 3 }),
      restoreMembership({ ...current, version: 2, userId: ids.newId("User") }),
      restoreMembership({ ...current, version: 2, id: ids.newId("Membership") }),
    ]) {
      await expect(unitOfWork.run((scope) => repository.update(scope, current, bad))).rejects.toThrow(
        /keep its identity and advance the version by one/,
      );
    }
    expect(store.memberships).toEqual([current]);
  });
});
