import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { permissionSet } from "../../authorization/permissions.js";
import { PermissionDeniedError, UserDisabledError, ValidationError } from "../../errors/application-error.js";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2)] });
  const owner = await h.registeredUser("owner", "Owner");
  const outsider = await h.registeredUser("outsider", "Outsider");
  const mine = await h.businessOwnedBy(owner, { name: "Mine" });
  const theirs = await h.businessOwnedBy(outsider, { name: "Theirs" });
  const ownerContext = await h.businessContexts.resolveForUser(owner.context, mine.business.id);
  return { h, owner, outsider, mine, theirs, ownerContext };
}

describe("ListMyBusinesses", () => {
  it("lists only the caller's accessible businesses", async () => {
    const { h, owner, mine } = await setup();
    const page = await h.listMyBusinesses.execute(owner.context);
    expect(page.items.map((entry) => entry.business.id)).toEqual([mine.business.id]);
    expect(page.items[0]?.membership.role).toBe("OWNER");
    expect(page.nextCursor).toBeNull();
  });

  it("omits suspended memberships and suspended businesses", async () => {
    const { h, owner, outsider, theirs } = await setup();
    const membership = h.addMember(theirs.business.id, owner, "CASHIER");
    expect((await h.listMyBusinesses.execute(owner.context)).items).toHaveLength(2);
    h.setMembershipStatus(membership, "SUSPENDED");
    expect((await h.listMyBusinesses.execute(owner.context)).items).toHaveLength(1);
    h.setBusinessStatus(theirs.business.id, "SUSPENDED");
    expect((await h.listMyBusinesses.execute(outsider.context)).items).toHaveLength(0);
  });

  it("pages by membership ID", async () => {
    const { h, owner } = await setup();
    await h.businessOwnedBy(owner, { name: "Second" });
    await h.businessOwnedBy(owner, { name: "Third" });
    const first = await h.listMyBusinesses.execute(owner.context, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.listMyBusinesses.execute(owner.context, { limit: 2, after: first.nextCursor ?? "" });
    expect(second.items.map((entry) => entry.business.name)).toEqual(["Third"]);
    expect(second.nextCursor).toBeNull();
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { after: "cursor" }])(
    "rejects the page request %j",
    async (page) => {
      const { h, owner } = await setup();
      await expect(h.listMyBusinesses.execute(owner.context, page)).rejects.toThrow(ValidationError);
    },
  );

  it("rejects a disabled user", async () => {
    const { h, owner } = await setup();
    h.setUserStatus(owner, "DISABLED");
    await expect(h.listMyBusinesses.execute(owner.context)).rejects.toThrow(UserDisabledError);
  });
});

describe("GetBusiness", () => {
  it("returns the context business", async () => {
    const { h, mine, ownerContext } = await setup();
    expect(await h.getBusiness.execute(ownerContext)).toEqual(mine.business);
  });

  it("requires business:read", async () => {
    const { h, ownerContext } = await setup();
    await expect(h.getBusiness.execute({ ...ownerContext, permissions: permissionSet([]) })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("is available to every role", async () => {
    const { h, mine } = await setup();
    const cashier = await h.registeredUser("cashier");
    h.addMember(mine.business.id, cashier, "CASHIER");
    const context = await h.businessContexts.resolveForUser(cashier.context, mine.business.id);
    expect((await h.getBusiness.execute(context)).id).toBe(mine.business.id);
  });
});

describe("ListLocations", () => {
  it("lists only the context business's locations", async () => {
    const { h, mine, ownerContext } = await setup();
    const page = await h.listLocations.execute(ownerContext);
    expect(page.items).toEqual([mine.location]);
  });

  it("requires location:read", async () => {
    const { h, ownerContext } = await setup();
    await expect(h.listLocations.execute({ ...ownerContext, permissions: permissionSet([]) })).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});

describe("ListMembers", () => {
  it("lists the context business's members with display names, including suspended ones", async () => {
    const { h, owner, mine, ownerContext } = await setup();
    const manager = await h.registeredUser("manager", "Manager");
    h.addMember(mine.business.id, manager, "MANAGER", "SUSPENDED");
    const page = await h.listMembers.execute(ownerContext);
    expect(page.items.map((item) => [item.displayName, item.membership.role, item.membership.status])).toEqual([
      ["Owner", "OWNER", "ACTIVE"],
      ["Manager", "MANAGER", "SUSPENDED"],
    ]);
    expect(page.items.every((item) => item.membership.businessId === mine.business.id)).toBe(true);
    expect(page.items.some((item) => item.membership.userId === owner.userId)).toBe(true);
  });

  it("never includes another tenant's members", async () => {
    const { h, outsider, ownerContext } = await setup();
    const page = await h.listMembers.execute(ownerContext);
    expect(page.items.some((item) => item.membership.userId === outsider.userId)).toBe(false);
  });

  it("is allowed for MANAGER and denied for roles without member:read", async () => {
    const { h, mine } = await setup();
    const manager = await h.registeredUser("manager");
    h.addMember(mine.business.id, manager, "MANAGER");
    const managerContext = await h.businessContexts.resolveForUser(manager.context, mine.business.id);
    await expect(h.listMembers.execute(managerContext)).resolves.toBeDefined();

    for (const role of ["CASHIER", "STOCK_KEEPER", "ACCOUNTANT"] as const) {
      const member = await h.registeredUser(`member-${role}`);
      h.addMember(mine.business.id, member, role);
      const context = await h.businessContexts.resolveForUser(member.context, mine.business.id);
      await expect(h.listMembers.execute(context)).rejects.toThrow(PermissionDeniedError);
    }
  });
});
