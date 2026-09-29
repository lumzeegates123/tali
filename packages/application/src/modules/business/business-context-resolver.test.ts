import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { hasPermission } from "../../authorization/permissions.js";
import { parseCorrelationId } from "../../context/business-context.js";
import { NotFoundError, UserDisabledError, UserNotRegisteredError } from "../../errors/application-error.js";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";
import { identityPermissions } from "../identity/index.js";

const request = { correlationId: parseCorrelationId("req-ctx"), sourceChannel: "web" } as const;
const p = identityPermissions.permissions;

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2), defineCurrency("JPY", 0)] });
  const owner = await h.registeredUser("owner");
  const { business, membership } = await h.businessOwnedBy(owner, { currencyCode: "JPY", timeZone: "asia/tokyo" });
  return { h, owner, business, membership };
}

async function notFoundMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NotFoundError);
    return (error as Error).message;
  }
  throw new Error("expected NOT_FOUND");
}

describe("BusinessContext resolution", () => {
  it("resolves an ACTIVE member of an ACTIVE business from Tali's records", async () => {
    const { h, owner, business, membership } = await setup();
    const context = await h.businessContexts.resolve({ ...request, identity: owner.identity, businessId: business.id });
    expect(context).toMatchObject({
      businessId: business.id,
      actor: { type: "user", userId: owner.userId, membershipId: membership.id },
      sourceChannel: "web",
      correlationId: "req-ctx",
      currency: "JPY",
      timeZone: "Asia/Tokyo",
    });
    expect(context).not.toHaveProperty("locationId");
    expect(context).not.toHaveProperty("deviceId");
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("expands the membership role into its permissions", async () => {
    const { h, business } = await setup();
    const manager = await h.registeredUser("manager");
    const cashier = await h.registeredUser("cashier");
    h.addMember(business.id, manager, "MANAGER");
    h.addMember(business.id, cashier, "CASHIER");
    const managerContext = await h.businessContexts.resolveForUser(manager.context, business.id);
    const cashierContext = await h.businessContexts.resolveForUser(cashier.context, business.id);
    expect(hasPermission(managerContext.permissions, p["member:read"])).toBe(true);
    expect(hasPermission(managerContext.permissions, p["member:manage"])).toBe(false);
    expect(hasPermission(cashierContext.permissions, p["member:read"])).toBe(false);
    expect(hasPermission(cashierContext.permissions, p["business:read"])).toBe(true);
  });

  it("rejects an unregistered identity with USER_NOT_REGISTERED", async () => {
    const { h, business } = await setup();
    const stranger = await h.identityFor("stranger");
    await expect(
      h.businessContexts.resolve({ ...request, identity: stranger, businessId: business.id }),
    ).rejects.toThrow(UserNotRegisteredError);
  });

  it("rejects a DISABLED user with USER_DISABLED before looking at the business", async () => {
    const { h, owner, business } = await setup();
    h.setUserStatus(owner, "DISABLED");
    await expect(
      h.businessContexts.resolve({ ...request, identity: owner.identity, businessId: business.id }),
    ).rejects.toThrow(UserDisabledError);
  });

  it("hides every inaccessible business behind the same NOT_FOUND", async () => {
    const { h, owner, business, membership } = await setup();
    const outsider = await h.registeredUser("outsider");
    const other = await h.businessOwnedBy(outsider, { name: "Other Shop" });
    const suspendedMember = await h.registeredUser("suspended");
    const suspendedMembership = h.addMember(business.id, suspendedMember, "MANAGER", "SUSPENDED");

    const messages = [
      // Malformed business ID.
      await notFoundMessage(h.businessContexts.resolveForUser(owner.context, "not-a-uuid")),
      // Unknown business.
      await notFoundMessage(h.businessContexts.resolveForUser(owner.context, h.ids.newId("Business"))),
      // Another tenant's business.
      await notFoundMessage(h.businessContexts.resolveForUser(owner.context, other.business.id)),
      // Suspended membership.
      await notFoundMessage(h.businessContexts.resolveForUser(suspendedMember.context, business.id)),
    ];
    h.setBusinessStatus(business.id, "SUSPENDED");
    // Suspended business, even for its owner.
    messages.push(await notFoundMessage(h.businessContexts.resolveForUser(owner.context, business.id)));

    expect(new Set(messages).size).toBe(1);
    expect(suspendedMembership.status).toBe("SUSPENDED");
    expect(membership.role).toBe("OWNER");
  });

  it("resolves each business of a multi-business user with that business's membership", async () => {
    const { h, owner, business, membership } = await setup();
    const second = await h.businessOwnedBy(owner, {
      name: "Second Shop",
      currencyCode: "KES",
      timeZone: "Africa/Nairobi",
    });
    const other = await h.registeredUser("other");
    const third = await h.businessOwnedBy(other, { name: "Third Shop" });
    h.addMember(third.business.id, owner, "CASHIER");

    const first = await h.businessContexts.resolveForUser(owner.context, business.id);
    const secondContext = await h.businessContexts.resolveForUser(owner.context, second.business.id);
    const thirdContext = await h.businessContexts.resolveForUser(owner.context, third.business.id);
    expect(first.actor).toMatchObject({ membershipId: membership.id });
    expect(secondContext).toMatchObject({ currency: "KES", timeZone: "Africa/Nairobi" });
    expect(secondContext.actor).toMatchObject({ membershipId: second.membership.id });
    expect(hasPermission(first.permissions, p["member:manage"])).toBe(true);
    expect(hasPermission(thirdContext.permissions, p["member:manage"])).toBe(false);
  });

  it("does not let a suspended membership in one business affect another", async () => {
    const { h, owner, business } = await setup();
    const other = await h.registeredUser("other");
    const shared = await h.businessOwnedBy(other, { name: "Shared" });
    const membership = h.addMember(shared.business.id, owner, "MANAGER");
    h.setMembershipStatus(membership, "SUSPENDED");
    await expect(h.businessContexts.resolveForUser(owner.context, shared.business.id)).rejects.toThrow(NotFoundError);
    await expect(h.businessContexts.resolveForUser(owner.context, business.id)).resolves.toBeDefined();
  });
});
