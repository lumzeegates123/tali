import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "../../errors/application-error.js";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2)] });
  const owner = await h.registeredUser("owner", "Owner");
  const staff = await h.registeredUser("staff", "Staff");
  const other = await h.registeredUser("other", "Other");
  const mine = await h.businessOwnedBy(owner, { name: "Mine" });
  const theirs = await h.businessOwnedBy(other, { name: "Theirs" });
  const cashier = h.addMember(mine.business.id, staff, "CASHIER");
  const ownerContext = await h.businessContexts.resolveForUser(owner.context, mine.business.id);
  return { h, owner, staff, other, mine, theirs, cashier, ownerContext };
}

const reason = "Staffing change";

describe("ChangeMemberRole", () => {
  it("changes an ACTIVE member's role with a reason and audits before and after", async () => {
    const { h, ownerContext, cashier } = await setup();
    const result = await h.changeMemberRole.execute(ownerContext, {
      membershipId: cashier.id,
      role: "MANAGER",
      reason,
    });
    expect(result.changed).toBe(true);
    expect(result.membership).toMatchObject({ role: "MANAGER", version: 2 });
    const audit = h.auditWriter.businessRecords.at(-1);
    expect(audit).toMatchObject({
      action: "membership.role_changed",
      entityId: cashier.id,
      reason,
      payload: { userId: cashier.userId, previousRole: "CASHIER", role: "MANAGER" },
    });
  });

  it("setting the current role is a no-op without audit", async () => {
    const { h, ownerContext, cashier } = await setup();
    const before = h.auditWriter.businessRecords.length;
    const result = await h.changeMemberRole.execute(ownerContext, {
      membershipId: cashier.id,
      role: "CASHIER",
      reason,
    });
    expect(result).toEqual({ membership: cashier, changed: false });
    expect(h.auditWriter.businessRecords).toHaveLength(before);
  });

  it("requires a reason and a known role", async () => {
    const { h, ownerContext, cashier } = await setup();
    for (const input of [
      { role: "MANAGER", reason: "   " },
      { role: "MANAGER", reason: "x".repeat(501) },
      { role: "ADMIN", reason },
    ]) {
      await expect(h.changeMemberRole.execute(ownerContext, { membershipId: cashier.id, ...input })).rejects.toThrow(
        ValidationError,
      );
    }
  });

  it("refuses to demote the last active owner and to change a suspended member's role", async () => {
    const { h, ownerContext, mine, cashier } = await setup();
    await expect(
      h.changeMemberRole.execute(ownerContext, { membershipId: mine.membership.id, role: "MANAGER", reason }),
    ).rejects.toThrow(ConflictError);
    h.setMembershipStatus(cashier, "SUSPENDED");
    await expect(
      h.changeMemberRole.execute(ownerContext, { membershipId: cashier.id, role: "MANAGER", reason }),
    ).rejects.toThrow(ConflictError);
  });

  it("lets an owner promote another owner, after which the first may step down", async () => {
    const { h, ownerContext, mine, cashier } = await setup();
    await h.changeMemberRole.execute(ownerContext, { membershipId: cashier.id, role: "OWNER", reason });
    const stepDown = await h.changeMemberRole.execute(ownerContext, {
      membershipId: mine.membership.id,
      role: "MANAGER",
      reason,
    });
    expect(stepDown.membership.role).toBe("MANAGER");
  });

  it("requires member:manage, re-read under the lock", async () => {
    const { h, staff, mine, cashier, ownerContext } = await setup();
    const cashierContext = await h.businessContexts.resolveForUser(staff.context, mine.business.id);
    await expect(
      h.changeMemberRole.execute(cashierContext, { membershipId: cashier.id, role: "MANAGER", reason }),
    ).rejects.toThrow(PermissionDeniedError);
    // The owner's context was resolved while OWNER; demoted since, it no longer grants member:manage.
    const coOwner = await h.registeredUser("co-owner");
    h.addMember(mine.business.id, coOwner, "OWNER");
    h.store.putMembership({ ...mine.membership, role: "MANAGER", version: 2 });
    await expect(
      h.changeMemberRole.execute(ownerContext, { membershipId: cashier.id, role: "MANAGER", reason }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("hides malformed, unknown and foreign membership IDs behind NOT_FOUND", async () => {
    const { h, ownerContext, theirs } = await setup();
    for (const membershipId of ["nope", h.ids.newId("Membership"), theirs.membership.id]) {
      await expect(h.changeMemberRole.execute(ownerContext, { membershipId, role: "MANAGER", reason })).rejects.toThrow(
        NotFoundError,
      );
    }
    expect(h.store.memberships.find((m) => m.id === theirs.membership.id)?.role).toBe("OWNER");
  });
});

describe("SuspendMember and ReactivateMember", () => {
  it("suspends and reactivates with reasons; repeats are no-ops without audit", async () => {
    const { h, ownerContext, cashier } = await setup();
    const suspended = await h.suspendMember.execute(ownerContext, { membershipId: cashier.id, reason });
    expect(suspended).toMatchObject({ changed: true, membership: { status: "SUSPENDED" } });
    expect((await h.suspendMember.execute(ownerContext, { membershipId: cashier.id, reason })).changed).toBe(false);
    const reactivated = await h.reactivateMember.execute(ownerContext, { membershipId: cashier.id, reason });
    expect(reactivated).toMatchObject({ changed: true, membership: { status: "ACTIVE" } });
    expect((await h.reactivateMember.execute(ownerContext, { membershipId: cashier.id, reason })).changed).toBe(false);
    const actions = h.auditWriter.businessRecords.map((r) => r.action);
    expect(actions.filter((a) => a === "membership.suspended")).toHaveLength(1);
    expect(actions.filter((a) => a === "membership.reactivated")).toHaveLength(1);
  });

  it("refuses to suspend the last active owner, including self-suspension", async () => {
    const { h, ownerContext, mine } = await setup();
    await expect(h.suspendMember.execute(ownerContext, { membershipId: mine.membership.id, reason })).rejects.toThrow(
      ConflictError,
    );
    expect(h.store.memberships.find((m) => m.id === mine.membership.id)?.status).toBe("ACTIVE");
  });

  it("a suspended actor holding a stale context cannot act, not even to reactivate themselves", async () => {
    const { h, ownerContext, mine, cashier } = await setup();
    const coOwner = await h.registeredUser("co-owner");
    h.addMember(mine.business.id, coOwner, "OWNER");
    h.setMembershipStatus(mine.membership, "SUSPENDED");
    await expect(h.suspendMember.execute(ownerContext, { membershipId: cashier.id, reason })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      h.reactivateMember.execute(ownerContext, { membershipId: mine.membership.id, reason }),
    ).rejects.toThrow(NotFoundError);
  });

  it("rolls back the change when the audit write fails", async () => {
    const { h, ownerContext, cashier } = await setup();
    h.auditWriter.failures.failNext("audit.membership.suspended");
    await expect(h.suspendMember.execute(ownerContext, { membershipId: cashier.id, reason })).rejects.toThrow(
      /injected/,
    );
    expect(h.store.memberships.find((m) => m.id === cashier.id)?.status).toBe("ACTIVE");
  });
});

describe("UpdateBusinessName", () => {
  it("renames the context business and audits which field changed", async () => {
    const { h, ownerContext, mine } = await setup();
    const result = await h.updateBusinessName.execute(ownerContext, { name: "  New Name  " });
    expect(result.changed).toBe(true);
    expect(result.business).toMatchObject({ id: mine.business.id, name: "New Name" });
    expect(h.auditWriter.businessRecords.at(-1)).toMatchObject({
      action: "business.renamed",
      entityId: mine.business.id,
      payload: { changedField: "name" },
    });
    expect(JSON.stringify(h.auditWriter.businessRecords.at(-1))).not.toContain("New Name");
  });

  it("setting the same name is a no-op without audit", async () => {
    const { h, ownerContext } = await setup();
    const before = h.auditWriter.businessRecords.length;
    const result = await h.updateBusinessName.execute(ownerContext, { name: "Mine" });
    expect(result.changed).toBe(false);
    expect(h.auditWriter.businessRecords).toHaveLength(before);
  });

  it("validates the name and requires business:update", async () => {
    const { h, ownerContext, staff, mine } = await setup();
    await expect(h.updateBusinessName.execute(ownerContext, { name: " " })).rejects.toThrow(ValidationError);
    await expect(h.updateBusinessName.execute(ownerContext, { name: "x".repeat(121) })).rejects.toThrow(
      ValidationError,
    );
    const cashierContext = await h.businessContexts.resolveForUser(staff.context, mine.business.id);
    await expect(h.updateBusinessName.execute(cashierContext, { name: "Mine 2" })).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it("changes only the context business", async () => {
    const { h, ownerContext, theirs } = await setup();
    await h.updateBusinessName.execute(ownerContext, { name: "Renamed" });
    expect(h.store.businesses.find((b) => b.id === theirs.business.id)?.name).toBe("Theirs");
  });
});
