import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { parseUserId } from "../identity/index.js";
import type { BusinessMembership, MembershipRole } from "./index.js";
import {
  changeMembershipRole,
  countActiveOwners,
  createFoundingOwnerMembership,
  MEMBERSHIP_ROLES,
  parseBusinessId,
  parseMembershipChangeReason,
  parseMembershipId,
  reactivateMembership,
  restoreMembership,
  suspendMembership,
} from "./index.js";

const businessA = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const businessB = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e6f");
const now = new Date("2026-09-29T10:00:00.000Z");
const later = new Date("2026-09-29T11:00:00.000Z");
const reason = parseMembershipChangeReason("staffing change");

let sequence = 0;
function member(role: MembershipRole, status = "ACTIVE", businessId = businessA): BusinessMembership {
  sequence += 1;
  const suffix = sequence.toString(16).padStart(12, "0");
  return restoreMembership({
    id: parseMembershipId(`01928c6e-8b3a-7c4d-9e5f-${suffix}`),
    businessId,
    userId: parseUserId(`01928c6e-8b3a-7c4d-8e5f-${suffix}`),
    role,
    status,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

function expectDomainError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
}

describe("membership vocabulary", () => {
  it("has exactly the approved five roles", () => {
    expect(MEMBERSHIP_ROLES).toEqual(["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]);
    expectDomainError(() => member("ADMIN" as MembershipRole), "INVALID_VALUE");
    expectDomainError(() => member("CASHIER", "INVITED"), "INVALID_VALUE");
  });

  it("creates the founder as an ACTIVE OWNER", () => {
    const owner = createFoundingOwnerMembership({
      id: parseMembershipId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4eaa"),
      businessId: businessA,
      userId: parseUserId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60"),
      now,
    });
    expect(owner).toMatchObject({ role: "OWNER", status: "ACTIVE", version: 1 });
  });
});

describe("reasons", () => {
  it("require non-blank text of at most 500 characters, stored as given", () => {
    expect(parseMembershipChangeReason(" moved shop ")).toBe(" moved shop ");
    expect(parseMembershipChangeReason("x".repeat(500))).toHaveLength(500);
    for (const invalid of ["", "   ", "x".repeat(501)]) {
      expectDomainError(() => parseMembershipChangeReason(invalid), "INVALID_VALUE");
    }
  });
});

describe("changeMembershipRole", () => {
  it("changes an ACTIVE membership's role and bumps the version", () => {
    const owner = member("OWNER");
    const cashier = member("CASHIER");
    const result = changeMembershipRole({
      target: cashier,
      role: "MANAGER",
      actor: owner,
      reason,
      owners: { activeOwnerCount: 1 },
      now: later,
    });
    expect(result.outcome).toBe("changed");
    expect(result.membership).toMatchObject({ role: "MANAGER", version: 2, updatedAt: later });
  });

  it("is a no-op for the current role", () => {
    const owner = member("OWNER");
    const cashier = member("CASHIER");
    expect(
      changeMembershipRole({
        target: cashier,
        role: "CASHIER",
        actor: owner,
        reason,
        owners: { activeOwnerCount: 1 },
        now,
      }),
    ).toEqual({ outcome: "unchanged", membership: cashier });
  });

  it("rejects changing a SUSPENDED membership's role", () => {
    expectDomainError(
      () =>
        changeMembershipRole({
          target: member("CASHIER", "SUSPENDED"),
          role: "MANAGER",
          actor: member("OWNER"),
          reason,
          owners: { activeOwnerCount: 1 },
          now,
        }),
      "INVALID_TRANSITION",
    );
  });

  it("requires an OWNER actor to grant or remove OWNER", () => {
    const manager = member("MANAGER");
    expectDomainError(
      () =>
        changeMembershipRole({
          target: member("CASHIER"),
          role: "OWNER",
          actor: manager,
          reason,
          owners: { activeOwnerCount: 1 },
          now,
        }),
      "OWNER_REQUIRED",
    );
    expectDomainError(
      () =>
        changeMembershipRole({
          target: member("OWNER"),
          role: "MANAGER",
          actor: manager,
          reason,
          owners: { activeOwnerCount: 2 },
          now,
        }),
      "OWNER_REQUIRED",
    );
    const promoted = changeMembershipRole({
      target: member("CASHIER"),
      role: "OWNER",
      actor: member("OWNER"),
      reason,
      owners: { activeOwnerCount: 1 },
      now,
    });
    expect(promoted.membership.role).toBe("OWNER");
  });

  it("rejects demoting the last active owner, including an owner demoting themselves", () => {
    const owner = member("OWNER");
    expectDomainError(
      () =>
        changeMembershipRole({
          target: owner,
          role: "MANAGER",
          actor: owner,
          reason,
          owners: { activeOwnerCount: 1 },
          now,
        }),
      "LAST_ACTIVE_OWNER",
    );
    const demoted = changeMembershipRole({
      target: owner,
      role: "MANAGER",
      actor: owner,
      reason,
      owners: { activeOwnerCount: 2 },
      now,
    });
    expect(demoted.membership.role).toBe("MANAGER");
  });

  it("rejects actors from another business or with a suspended membership", () => {
    expectDomainError(
      () =>
        changeMembershipRole({
          target: member("CASHIER"),
          role: "MANAGER",
          actor: member("OWNER", "ACTIVE", businessB),
          reason,
          owners: { activeOwnerCount: 1 },
          now,
        }),
      "INVALID_VALUE",
    );
    expectDomainError(
      () =>
        changeMembershipRole({
          target: member("CASHIER"),
          role: "MANAGER",
          actor: member("OWNER", "SUSPENDED"),
          reason,
          owners: { activeOwnerCount: 1 },
          now,
        }),
      "INVALID_TRANSITION",
    );
  });

  it("rejects an owner count that contradicts the target", () => {
    const owner = member("OWNER");
    for (const activeOwnerCount of [0, -1, 1.5]) {
      expectDomainError(
        () =>
          changeMembershipRole({
            target: owner,
            role: "MANAGER",
            actor: owner,
            reason,
            owners: { activeOwnerCount },
            now,
          }),
        "INVALID_VALUE",
      );
    }
  });
});

describe("suspendMembership and reactivateMembership", () => {
  it("suspends ACTIVE memberships and treats an already SUSPENDED one as a no-op", () => {
    const owner = member("OWNER");
    const cashier = member("CASHIER");
    const suspended = suspendMembership({
      target: cashier,
      actor: owner,
      reason,
      owners: { activeOwnerCount: 1 },
      now: later,
    });
    expect(suspended.outcome).toBe("changed");
    expect(suspended.membership).toMatchObject({ status: "SUSPENDED", version: 2 });
    expect(
      suspendMembership({ target: suspended.membership, actor: owner, reason, owners: { activeOwnerCount: 1 }, now })
        .outcome,
    ).toBe("unchanged");
  });

  it("rejects suspending the last active owner, and allows it when another owner remains", () => {
    const owner = member("OWNER");
    expectDomainError(
      () => suspendMembership({ target: owner, actor: owner, reason, owners: { activeOwnerCount: 1 }, now }),
      "LAST_ACTIVE_OWNER",
    );
    expect(
      suspendMembership({ target: owner, actor: owner, reason, owners: { activeOwnerCount: 2 }, now }).outcome,
    ).toBe("changed");
  });

  it("reactivates only through another ACTIVE membership, never by the suspended member", () => {
    const owner = member("OWNER");
    const suspended = member("CASHIER", "SUSPENDED");
    const reactivated = reactivateMembership({ target: suspended, actor: owner, reason, now: later });
    expect(reactivated.membership.status).toBe("ACTIVE");
    expectDomainError(
      () => reactivateMembership({ target: suspended, actor: suspended, reason, now }),
      "INVALID_TRANSITION",
    );
    expect(reactivateMembership({ target: owner, actor: owner, reason, now }).outcome).toBe("unchanged");
  });
});

describe("owner invariant across sequences", () => {
  it("never leaves a business without an active owner", () => {
    const first = member("OWNER");
    const second = member("OWNER");
    let roster = [first, second];
    const demote = (target: BusinessMembership, actor: BusinessMembership): BusinessMembership =>
      changeMembershipRole({
        target,
        role: "MANAGER",
        actor,
        reason,
        owners: { activeOwnerCount: countActiveOwners(roster) },
        now,
      }).membership;

    const demotedSecond = demote(second, first);
    roster = [first, demotedSecond];
    expect(countActiveOwners(roster)).toBe(1);
    expectDomainError(() => demote(first, first), "LAST_ACTIVE_OWNER");
    expectDomainError(
      () =>
        suspendMembership({
          target: first,
          actor: first,
          reason,
          owners: { activeOwnerCount: countActiveOwners(roster) },
          now,
        }),
      "LAST_ACTIVE_OWNER",
    );
  });
});
