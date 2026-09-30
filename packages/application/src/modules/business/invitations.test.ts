import { defineCurrency, INVITATION_TTL_MS } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PermissionDeniedError,
  UserDisabledError,
  ValidationError,
} from "../../errors/application-error.js";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2)] });
  const owner = await h.registeredUser("owner", "Owner");
  const joiner = await h.registeredUser("joiner", "Joiner");
  const other = await h.registeredUser("other", "Other");
  const mine = await h.businessOwnedBy(owner, { name: "Mine" });
  const theirs = await h.businessOwnedBy(other, { name: "Theirs" });
  const ownerContext = await h.businessContexts.resolveForUser(owner.context, mine.business.id);
  const key = () => h.ids.newId("IdempotencyKey");
  const invite = async (role = "CASHIER", idempotencyKey: string = key()) =>
    h.createInvitation.execute(ownerContext, { role, idempotencyKey });
  return { h, owner, joiner, other, mine, theirs, ownerContext, key, invite };
}

/** Every serialized trace the harness keeps: audit records, idempotency results and stored digests. */
function persistedText(h: Awaited<ReturnType<typeof setup>>["h"]): string {
  return JSON.stringify({
    audit: h.auditWriter.all,
    idempotency: h.businessIdempotencyStore.records,
    invitations: h.store.invitations,
  });
}

describe("CreateInvitation", () => {
  it("creates a PENDING invitation with a one-time token and audits it without the token", async () => {
    const { h, invite, mine, ownerContext } = await setup();
    const outcome = await invite("MANAGER");
    if (outcome.replayed) throw new Error("expected an original response");
    expect(outcome.invitation).toMatchObject({ role: "MANAGER", status: "PENDING", businessId: mine.business.id });
    expect(outcome.invitation.expiresAt.getTime() - h.clock.now().getTime()).toBe(INVITATION_TTL_MS);
    expect(outcome.token).toMatch(/^tali_inv_[A-Za-z0-9_-]{43}$/);
    const audit = h.auditWriter.businessRecords.filter((record) => record.action === "invitation.created");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      businessId: mine.business.id,
      entityId: outcome.invitation.id,
      actor: ownerContext.actor,
      payload: { role: "MANAGER", status: "PENDING" },
    });
    expect(persistedText(h)).not.toContain(outcome.token);
    expect(h.store.storedDigests).toHaveLength(1);
  });

  it("replays the same key without a token, a new effect or a new audit record", async () => {
    const { h, invite, key } = await setup();
    const idempotencyKey = key();
    const first = await invite("CASHIER", idempotencyKey);
    const replay = await invite("CASHIER", idempotencyKey);
    expect(replay).toEqual({ invitation: first.invitation, replayed: true });
    expect("token" in replay).toBe(false);
    expect(h.store.invitations).toHaveLength(1);
    expect(h.auditWriter.businessRecords.filter((r) => r.action === "invitation.created")).toHaveLength(1);
    const stored = JSON.stringify(h.businessIdempotencyStore.records);
    if (first.replayed) throw new Error("expected an original response");
    expect(stored).not.toContain(first.token);
    expect(stored).not.toMatch(/tali_inv_/);
  });

  it("refuses the same key for a different role (IDEMPOTENCY_KEY_REUSED) and requires a key", async () => {
    const { h, invite, key, ownerContext } = await setup();
    const idempotencyKey = key();
    await invite("CASHIER", idempotencyKey);
    await expect(invite("MANAGER", idempotencyKey)).rejects.toThrow(IdempotencyKeyReusedError);
    await expect(
      h.createInvitation.execute(ownerContext, { role: "CASHIER", idempotencyKey: undefined }),
    ).rejects.toThrow(IdempotencyKeyRequiredError);
  });

  it.each(["OWNER", "owner", "ADMIN", ""])("rejects the role %j", async (role) => {
    const { invite } = await setup();
    await expect(invite(role)).rejects.toThrow(ValidationError);
  });

  it("requires member:invite (a MANAGER cannot invite)", async () => {
    const { h, joiner, mine, key } = await setup();
    h.addMember(mine.business.id, joiner, "MANAGER");
    const managerContext = await h.businessContexts.resolveForUser(joiner.context, mine.business.id);
    await expect(
      h.createInvitation.execute(managerContext, { role: "CASHIER", idempotencyKey: key() }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(h.store.invitations).toHaveLength(0);
  });

  it("re-reads the actor: an owner suspended after context resolution cannot invite", async () => {
    const { h, mine, ownerContext, key } = await setup();
    h.setMembershipStatus(mine.membership, "SUSPENDED");
    await expect(h.createInvitation.execute(ownerContext, { role: "CASHIER", idempotencyKey: key() })).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rolls back the invitation and key when the audit write fails", async () => {
    const { h, invite } = await setup();
    h.auditWriter.failures.failNext("audit.invitation.created");
    await expect(invite()).rejects.toThrow(/injected/);
    expect(h.store.invitations).toHaveLength(0);
    expect(h.businessIdempotencyStore.records).toHaveLength(0);
  });
});

describe("RevokeInvitation", () => {
  it("revokes a PENDING invitation once; a second revoke is a no-op without audit", async () => {
    const { h, invite, ownerContext, mine } = await setup();
    const { invitation } = await invite();
    const first = await h.revokeInvitation.execute(ownerContext, { invitationId: invitation.id });
    expect(first.changed).toBe(true);
    expect(first.invitation).toMatchObject({ status: "REVOKED", revokedByMembershipId: mine.membership.id });
    const second = await h.revokeInvitation.execute(ownerContext, { invitationId: invitation.id });
    expect(second.changed).toBe(false);
    expect(h.auditWriter.businessRecords.filter((r) => r.action === "invitation.revoked")).toHaveLength(1);
  });

  it("refuses to revoke an ACCEPTED invitation (CONFLICT)", async () => {
    const { h, invite, ownerContext, joiner } = await setup();
    const created = await invite();
    if (created.replayed) throw new Error("expected an original response");
    await h.acceptInvitation.execute(joiner.context, { token: created.token });
    await expect(h.revokeInvitation.execute(ownerContext, { invitationId: created.invitation.id })).rejects.toThrow(
      ConflictError,
    );
  });

  it("hides malformed, unknown and foreign invitation IDs behind NOT_FOUND", async () => {
    const { h, other, theirs, ownerContext, key } = await setup();
    const otherContext = await h.businessContexts.resolveForUser(other.context, theirs.business.id);
    const foreign = await h.createInvitation.execute(otherContext, { role: "CASHIER", idempotencyKey: key() });
    for (const invitationId of ["not-a-uuid", h.ids.newId("Invitation"), foreign.invitation.id]) {
      await expect(h.revokeInvitation.execute(ownerContext, { invitationId })).rejects.toThrow(NotFoundError);
    }
    expect(h.store.invitations.find((i) => i.id === foreign.invitation.id)?.status).toBe("PENDING");
  });
});

describe("AcceptInvitation", () => {
  it("creates the ACTIVE membership, marks the invitation ACCEPTED and writes both audit records", async () => {
    const { h, invite, joiner, mine } = await setup();
    const created = await invite("STOCK_KEEPER");
    if (created.replayed) throw new Error("expected an original response");
    const result = await h.acceptInvitation.execute(joiner.context, { token: created.token });
    expect(result.replayed).toBe(false);
    expect(result.business.id).toBe(mine.business.id);
    expect(result.membership).toMatchObject({ userId: joiner.userId, role: "STOCK_KEEPER", status: "ACTIVE" });
    expect(h.store.invitations[0]).toMatchObject({ status: "ACCEPTED", acceptedByMembershipId: result.membership.id });
    const actions = h.auditWriter.businessRecords.slice(-2);
    expect(actions.map((r) => r.action)).toEqual(["membership.created", "invitation.accepted"]);
    for (const record of actions) {
      expect(record.actor).toEqual({ type: "user", userId: joiner.userId, membershipId: result.membership.id });
    }
    expect(persistedText(h)).not.toContain(created.token);
    const page = await h.listMyBusinesses.execute(joiner.context);
    expect(page.items.map((entry) => entry.business.id)).toEqual([mine.business.id]);
  });

  it("replays for the same user and returns the existing membership without new audit", async () => {
    const { h, invite, joiner } = await setup();
    const created = await invite();
    if (created.replayed) throw new Error("expected an original response");
    const first = await h.acceptInvitation.execute(joiner.context, { token: created.token });
    const audits = h.auditWriter.businessRecords.length;
    const again = await h.acceptInvitation.execute(joiner.context, { token: created.token });
    expect(again).toMatchObject({ replayed: true, membership: first.membership });
    expect(h.auditWriter.businessRecords).toHaveLength(audits);
  });

  it("gives one uniform NOT_FOUND for another user, unknown, malformed, revoked and expired tokens", async () => {
    const { h, invite, joiner, other, ownerContext } = await setup();
    const accepted = await invite();
    const revoked = await invite();
    const expired = await invite();
    if (accepted.replayed || revoked.replayed || expired.replayed) throw new Error("expected original responses");
    await h.acceptInvitation.execute(joiner.context, { token: accepted.token });
    await h.revokeInvitation.execute(ownerContext, { invitationId: revoked.invitation.id });
    const unknown = h.secrets.generate("invitation");
    const cases: [string, string][] = [
      ["accepted by another user", accepted.token],
      ["unknown", unknown],
      ["malformed", "not-a-token"],
      ["device credential format", h.secrets.generate("device")],
      ["revoked", revoked.token],
    ];
    for (const [label, token] of cases) {
      const error = await h.acceptInvitation.execute(other.context, { token }).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).message, label).toBe("Invitation not found");
    }
    h.clock.advanceBy(INVITATION_TTL_MS);
    const error = await h.acceptInvitation.execute(other.context, { token: expired.token }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe("Invitation not found");
  });

  it("is NOT_FOUND when the inviter lost authority or the business is not ACTIVE", async () => {
    const demoted = await setup();
    const coOwner = await demoted.h.registeredUser("co-owner");
    demoted.h.addMember(demoted.mine.business.id, coOwner, "OWNER");
    const created = await demoted.invite();
    if (created.replayed) throw new Error("expected an original response");
    demoted.h.setMembershipStatus(demoted.mine.membership, "SUSPENDED");
    await expect(demoted.h.acceptInvitation.execute(demoted.joiner.context, { token: created.token })).rejects.toThrow(
      NotFoundError,
    );

    const suspended = await setup();
    const again = await suspended.invite();
    if (again.replayed) throw new Error("expected an original response");
    suspended.h.setBusinessStatus(suspended.mine.business.id, "SUSPENDED");
    await expect(
      suspended.h.acceptInvitation.execute(suspended.joiner.context, { token: again.token }),
    ).rejects.toThrow(NotFoundError);
    expect(suspended.h.store.invitations[0]?.status).toBe("PENDING");
  });

  it("is CONFLICT for an ACTIVE or SUSPENDED member, and the invitation stays PENDING", async () => {
    const { h, invite, joiner, owner, mine } = await setup();
    const forOwner = await invite();
    if (forOwner.replayed) throw new Error("expected an original response");
    await expect(h.acceptInvitation.execute(owner.context, { token: forOwner.token })).rejects.toThrow(ConflictError);

    const membership = h.addMember(mine.business.id, joiner, "CASHIER", "SUSPENDED");
    const forSuspended = await invite("MANAGER");
    if (forSuspended.replayed) throw new Error("expected an original response");
    await expect(h.acceptInvitation.execute(joiner.context, { token: forSuspended.token })).rejects.toThrow(
      ConflictError,
    );
    expect(h.store.memberships.find((m) => m.id === membership.id)).toMatchObject({
      status: "SUSPENDED",
      role: "CASHIER",
    });
    expect(h.store.invitations.every((invitation) => invitation.status === "PENDING")).toBe(true);
  });

  it("rejects a disabled user", async () => {
    const { h, invite, joiner } = await setup();
    const created = await invite();
    if (created.replayed) throw new Error("expected an original response");
    h.setUserStatus(joiner, "DISABLED");
    await expect(h.acceptInvitation.execute(joiner.context, { token: created.token })).rejects.toThrow(
      UserDisabledError,
    );
  });

  it("grants membership only in the invitation's own business", async () => {
    const { h, invite, joiner, theirs } = await setup();
    const created = await invite();
    if (created.replayed) throw new Error("expected an original response");
    await h.acceptInvitation.execute(joiner.context, { token: created.token });
    await expect(h.businessContexts.resolveForUser(joiner.context, theirs.business.id)).rejects.toThrow(NotFoundError);
  });

  it("rolls back the membership when the audit write fails", async () => {
    const { h, invite, joiner } = await setup();
    const created = await invite();
    if (created.replayed) throw new Error("expected an original response");
    h.auditWriter.failures.failNext("audit.invitation.accepted");
    await expect(h.acceptInvitation.execute(joiner.context, { token: created.token })).rejects.toThrow(/injected/);
    expect(h.store.memberships.some((m) => m.userId === joiner.userId)).toBe(false);
    expect(h.store.invitations[0]?.status).toBe("PENDING");
  });
});
