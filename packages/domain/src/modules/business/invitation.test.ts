import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { parseUserId } from "../identity/index.js";
import type { BusinessInvitation } from "./index.js";
import {
  acceptInvitation,
  createInvitation,
  createInvitedMembership,
  INVITABLE_ROLES,
  INVITATION_TTL_MS,
  isInvitationExpired,
  isInvitationOpen,
  parseBusinessId,
  parseInvitableRole,
  parseInvitationId,
  parseMembershipId,
  restoreInvitation,
  revokeInvitation,
} from "./index.js";

const businessId = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const invitationId = parseInvitationId("01928c6e-8b3a-7c4d-9e5f-00000000a001");
const owner = parseMembershipId("01928c6e-8b3a-7c4d-9e5f-00000000b001");
const joiner = parseMembershipId("01928c6e-8b3a-7c4d-9e5f-00000000b002");
const now = new Date("2026-09-29T10:00:00.000Z");
const at = (ms: number) => new Date(now.getTime() + ms);

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

const pending = (): BusinessInvitation =>
  createInvitation({ id: invitationId, businessId, role: "CASHIER", createdByMembershipId: owner, now });

describe("invitation roles", () => {
  it("allows the four invitable roles and never OWNER", () => {
    expect(INVITABLE_ROLES).toEqual(["MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]);
    for (const role of INVITABLE_ROLES) expect(parseInvitableRole(role)).toBe(role);
    for (const role of ["OWNER", "owner", "", "ADMIN"])
      expectDomainError(() => parseInvitableRole(role), "INVALID_VALUE");
  });

  it("an invited membership is ACTIVE with the invited role and cannot be OWNER", () => {
    const userId = parseUserId("01928c6e-8b3a-7c4d-8e5f-000000000001");
    const membership = createInvitedMembership({ id: joiner, businessId, userId, role: "MANAGER", now });
    expect(membership).toMatchObject({ role: "MANAGER", status: "ACTIVE", version: 1 });
    expectDomainError(
      () => createInvitedMembership({ id: joiner, businessId, userId, role: "OWNER" as "MANAGER", now }),
      "INVALID_VALUE",
    );
  });
});

describe("invitation lifecycle", () => {
  it("is created PENDING with a 72-hour expiry by default", () => {
    const invitation = pending();
    expect(invitation).toMatchObject({ status: "PENDING", role: "CASHIER", createdAt: now });
    expect(invitation.expiresAt.getTime() - now.getTime()).toBe(72 * 60 * 60 * 1000);
    expect(INVITATION_TTL_MS).toBe(259_200_000);
    expect(Object.isFrozen(invitation)).toBe(true);
  });

  it("expiry is derived from the clock, never stored", () => {
    const invitation = pending();
    expect(isInvitationExpired(invitation, at(INVITATION_TTL_MS - 1))).toBe(false);
    expect(isInvitationExpired(invitation, at(INVITATION_TTL_MS))).toBe(true);
    expect(isInvitationOpen(invitation, at(INVITATION_TTL_MS))).toBe(false);
    expect(invitation.status).toBe("PENDING");
  });

  it("accepts a PENDING unexpired invitation, bound to the new membership", () => {
    const { invitation, previous } = acceptInvitation({
      invitation: pending(),
      acceptedByMembershipId: joiner,
      now: at(1),
    });
    expect(previous.status).toBe("PENDING");
    expect(invitation).toMatchObject({ status: "ACCEPTED", acceptedByMembershipId: joiner, acceptedAt: at(1) });
  });

  it("refuses to accept an expired, revoked or accepted invitation", () => {
    expectDomainError(
      () => acceptInvitation({ invitation: pending(), acceptedByMembershipId: joiner, now: at(INVITATION_TTL_MS) }),
      "INVALID_TRANSITION",
    );
    const revoked = revokeInvitation({ invitation: pending(), revokedByMembershipId: owner, now: at(1) });
    expectDomainError(
      () => acceptInvitation({ invitation: revoked.invitation, acceptedByMembershipId: joiner, now: at(2) }),
      "INVALID_TRANSITION",
    );
    const accepted = acceptInvitation({ invitation: pending(), acceptedByMembershipId: joiner, now: at(1) });
    expectDomainError(
      () => acceptInvitation({ invitation: accepted.invitation, acceptedByMembershipId: joiner, now: at(2) }),
      "INVALID_TRANSITION",
    );
  });

  it("revokes PENDING (even when expired); REVOKED is a no-op; ACCEPTED is an invalid transition", () => {
    const first = revokeInvitation({ invitation: pending(), revokedByMembershipId: owner, now: at(1) });
    expect(first.outcome).toBe("changed");
    expect(first.invitation).toMatchObject({ status: "REVOKED", revokedByMembershipId: owner, revokedAt: at(1) });
    const again = revokeInvitation({ invitation: first.invitation, revokedByMembershipId: owner, now: at(2) });
    expect(again).toEqual({ outcome: "unchanged", invitation: first.invitation });
    const expired = revokeInvitation({
      invitation: pending(),
      revokedByMembershipId: owner,
      now: at(INVITATION_TTL_MS * 2),
    });
    expect(expired.outcome).toBe("changed");
    const accepted = acceptInvitation({ invitation: pending(), acceptedByMembershipId: joiner, now: at(1) });
    expectDomainError(
      () => revokeInvitation({ invitation: accepted.invitation, revokedByMembershipId: owner, now: at(2) }),
      "INVALID_TRANSITION",
    );
  });
});

describe("restoreInvitation", () => {
  const base = {
    id: invitationId,
    businessId,
    role: "MANAGER",
    expiresAt: at(INVITATION_TTL_MS),
    createdByMembershipId: owner,
    createdAt: now,
  };

  it("restores each consistent stored state", () => {
    expect(restoreInvitation({ ...base, status: "PENDING" }).status).toBe("PENDING");
    expect(
      restoreInvitation({ ...base, status: "ACCEPTED", acceptedByMembershipId: joiner, acceptedAt: at(1) }).status,
    ).toBe("ACCEPTED");
    expect(
      restoreInvitation({ ...base, status: "REVOKED", revokedByMembershipId: owner, revokedAt: at(1) }).status,
    ).toBe("REVOKED");
  });

  it("rejects inconsistent or unknown states, OWNER and EXPIRED", () => {
    expectDomainError(() => restoreInvitation({ ...base, status: "EXPIRED" }), "INVALID_VALUE");
    expectDomainError(() => restoreInvitation({ ...base, status: "ACCEPTED" }), "INVALID_VALUE");
    expectDomainError(() => restoreInvitation({ ...base, status: "PENDING", revokedAt: at(1) }), "INVALID_VALUE");
    expectDomainError(
      () =>
        restoreInvitation({
          ...base,
          status: "REVOKED",
          revokedByMembershipId: owner,
          revokedAt: at(1),
          acceptedByMembershipId: joiner,
          acceptedAt: at(1),
        }),
      "INVALID_VALUE",
    );
    expectDomainError(() => restoreInvitation({ ...base, status: "PENDING", role: "OWNER" }), "INVALID_VALUE");
    expectDomainError(() => restoreInvitation({ ...base, status: "PENDING", expiresAt: now }), "INVALID_VALUE");
  });
});
