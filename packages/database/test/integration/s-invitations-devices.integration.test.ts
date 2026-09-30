import {
  ConflictError,
  DeviceNotTrustedError,
  type MembershipRepository,
  NotFoundError,
  PermissionDeniedError,
} from "@tali/application";
import { DomainError } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { readTenancySnapshot, tenancyFixtures } from "../../src/testing/index.js";
import { delay, gate } from "../support/harness.js";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * Slice 5 use cases over PostgreSQL (ADR-005 sections 10, 14 and 15; ADR-004
 * sections 4 and 12): row locks and races, business-scoped idempotency, and
 * proof that no one-time secret is ever written anywhere.
 */
describe("invitations, member management and devices on PostgreSQL", () => {
  const harness = useTenancyHarness();
  const { owner } = harness;

  async function setup() {
    const tenancy = harness.compose();
    const ownerUser = await tenancy.registeredUser("owner", "Owner");
    const { result } = await tenancy.create(ownerUser, { name: "Shop" });
    const businessId = result.business.id;
    const ownerContext = await tenancy.contextFor(ownerUser, businessId);
    const key = () => harness.world().ids.newId("IdempotencyKey");
    const invite = async (role = "CASHIER") => {
      const outcome = await tenancy.createInvitation.execute(ownerContext, { role, idempotencyKey: key() });
      if (outcome.replayed) throw new Error("expected an original response");
      return outcome;
    };
    return { tenancy, ownerUser, businessId, ownerContext, key, invite, membership: result.membership };
  }

  /** Every row of every Slice 5-relevant table, as text, read as the owner role. */
  async function everyStoredText(): Promise<string> {
    const tables = [
      "business_invitations",
      "devices",
      "business_audit_records",
      "platform_audit_records",
      "business_idempotency_records",
      "user_idempotency_records",
      "business_memberships",
    ];
    const parts: string[] = [];
    for (const table of tables) {
      const { rows } = await owner.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM ${table} t`);
      parts.push(...rows.map((r) => r.row));
    }
    return parts.join("\n");
  }

  describe("invitations", () => {
    it("stores only the 32-byte digest; the token appears in no table", async () => {
      const { invite } = await setup();
      const { token, invitation } = await invite();
      const snapshot = await readTenancySnapshot();
      expect(snapshot.invitations).toHaveLength(1);
      expect(snapshot.invitations[0]).toMatchObject({ id: invitation.id, status: "PENDING", role: "CASHIER" });
      expect(snapshot.invitations[0]?.tokenHashHex).toMatch(/^[0-9a-f]{64}$/);
      const stored = await everyStoredText();
      expect(stored).not.toContain(token);
      expect(stored).not.toContain("tali_inv_");
      expect(snapshot.businessIdempotency).toHaveLength(1);
      expect(snapshot.businessIdempotency[0]?.resultText).not.toContain("token");
    });

    it("concurrent creates with one key: one invitation, one token, the other replays without it", async () => {
      const { tenancy, ownerContext, key } = await setup();
      const idempotencyKey = key();
      const results = await Promise.all(
        [0, 1].map(() => tenancy.createInvitation.execute(ownerContext, { role: "MANAGER", idempotencyKey })),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.filter((r) => r.replayed)).toHaveLength(1);
      expect(results.filter((r) => "token" in r)).toHaveLength(1);
      expect(results[0]?.invitation.id).toBe(results[1]?.invitation.id);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.invitations).toHaveLength(1);
      expect(snapshot.businessAudit.filter((a) => a.action === "invitation.created")).toHaveLength(1);
    });

    it("the same user accepting one token concurrently: one membership, the other call replays", async () => {
      const { tenancy, invite } = await setup();
      const joiner = await tenancy.registeredUser("joiner");
      const { token } = await invite();
      const results = await Promise.all([0, 1].map(() => tenancy.acceptInvitation.execute(joiner.context, { token })));
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.membership.id).toBe(results[1]?.membership.id);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.memberships.filter((m) => m.userId === joiner.userId)).toHaveLength(1);
      expect(snapshot.invitations[0]?.status).toBe("ACCEPTED");
      expect(snapshot.businessAudit.filter((a) => a.action === "invitation.accepted")).toHaveLength(1);
      expect(snapshot.businessAudit.filter((a) => a.action === "membership.created")).toHaveLength(2);
    });

    it("two users racing for one token: exactly one joins, the other gets NOT_FOUND", async () => {
      const { tenancy, invite } = await setup();
      const a = await tenancy.registeredUser("racer-a");
      const b = await tenancy.registeredUser("racer-b");
      const { token } = await invite();
      const results = await Promise.allSettled(
        [a, b].map((u) => tenancy.acceptInvitation.execute(u.context, { token })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(NotFoundError);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.memberships.filter((m) => m.userId === a.userId || m.userId === b.userId)).toHaveLength(1);
    });

    it("accept waits for a revoke holding the invitation lock, then re-reads it as REVOKED", async () => {
      const { tenancy, invite, ownerContext, membership } = await setup();
      const joiner = await tenancy.registeredUser("joiner");
      const { token, invitation } = await invite();
      const locked = gate();
      const release = gate();
      const revoking = harness.unitOfWork.run(async (scope) => {
        const current = await tenancy.repositories.invitations.findByIdForUpdate(
          scope,
          ownerContext.businessId,
          invitation.id,
        );
        if (current === undefined) throw new Error("invitation missing");
        locked.open();
        await release.opened;
        const now = harness.world().clock.now();
        const next = { ...current, status: "REVOKED" as const, revokedByMembershipId: membership.id, revokedAt: now };
        await tenancy.repositories.invitations.update(scope, current, next);
      });
      await locked.opened;
      const accepting = tenancy.acceptInvitation.execute(joiner.context, { token }).catch((error: unknown) => error);
      await delay(200);
      release.open();
      await revoking;
      expect(await accepting).toBeInstanceOf(NotFoundError);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.invitations[0]?.status).toBe("REVOKED");
      expect(snapshot.memberships.some((m) => m.userId === joiner.userId)).toBe(false);
    });

    it("an expired invitation is NOT_FOUND and stays PENDING (EXPIRED is derived, never stored)", async () => {
      const { tenancy, invite } = await setup();
      const joiner = await tenancy.registeredUser("joiner");
      const { token, invitation } = await invite();
      await tenancyFixtures.expireInvitation(invitation.id);
      harness.world().clock.set(new Date());
      await expect(tenancy.acceptInvitation.execute(joiner.context, { token })).rejects.toThrow(NotFoundError);
      expect((await readTenancySnapshot()).invitations[0]?.status).toBe("PENDING");
    });

    it("a SUSPENDED member cannot rejoin through an invitation (CONFLICT, invitation stays PENDING)", async () => {
      const { tenancy, invite, businessId } = await setup();
      const joiner = await tenancy.registeredUser("joiner");
      await harness.addMember(businessId, joiner, "CASHIER", "SUSPENDED");
      const { token } = await invite("MANAGER");
      await expect(tenancy.acceptInvitation.execute(joiner.context, { token })).rejects.toThrow(ConflictError);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.invitations[0]?.status).toBe("PENDING");
      expect(snapshot.memberships.find((m) => m.userId === joiner.userId)).toMatchObject({
        status: "SUSPENDED",
        role: "CASHIER",
      });
    });
  });

  describe("member management under the business lock", () => {
    /** Wraps countActiveOwners so the first caller pauses after counting, forcing the two transactions to overlap. */
    function pausingMemberships(base: MembershipRepository, counted: { open: () => void }): MembershipRepository {
      let calls = 0;
      return {
        ...base,
        async countActiveOwners(scope, businessId) {
          const n = await base.countActiveOwners(scope, businessId);
          calls += 1;
          if (calls === 1) {
            counted.open();
            await delay(200);
          }
          return n;
        },
      };
    }

    it.each(["suspend", "demote"] as const)(
      "the two remaining owners %s each other concurrently: exactly one succeeds",
      async (change) => {
        const { tenancy, ownerUser, businessId, membership } = await setup();
        const second = await tenancy.registeredUser("second-owner");
        const secondMembership = await harness.addMember(businessId, second, "OWNER");
        const counted = gate();
        const paused = harness.compose({
          decorate: { memberships: pausingMemberships(tenancy.repositories.memberships, counted) },
        });
        const firstContext = await tenancy.contextFor(ownerUser, businessId);
        const secondContext = await tenancy.contextFor(second, businessId);
        const run = (composed: typeof tenancy, context: typeof firstContext, targetId: string) =>
          change === "suspend"
            ? composed.suspendMember.execute(context, { membershipId: targetId, reason: "Handover" })
            : composed.changeMemberRole.execute(context, {
                membershipId: targetId,
                role: "MANAGER",
                reason: "Handover",
              });
        const a = run(paused, firstContext, secondMembership.id);
        await counted.opened;
        const b = run(tenancy, secondContext, membership.id);
        const results = await Promise.allSettled([a, b]);
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
        // The loser re-reads its own membership under the lock: suspended (hidden as NOT_FOUND) or demoted.
        const reason = (results[1] as PromiseRejectedResult).reason as unknown;
        expect(
          [NotFoundError, PermissionDeniedError, ConflictError, DomainError].some((type) => reason instanceof type),
        ).toBe(true);
        const { rows } = await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM business_memberships WHERE business_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
          [businessId],
        );
        expect(Number(rows[0]?.n)).toBe(1);
      },
    );

    it("the last active owner cannot be suspended or demoted; no audit is written", async () => {
      const { tenancy, ownerContext, membership } = await setup();
      const before = (await readTenancySnapshot()).businessAudit.length;
      await expect(
        tenancy.suspendMember.execute(ownerContext, { membershipId: membership.id, reason: "Leaving" }),
      ).rejects.toThrow(ConflictError);
      await expect(
        tenancy.changeMemberRole.execute(ownerContext, { membershipId: membership.id, role: "MANAGER", reason: "x" }),
      ).rejects.toThrow(ConflictError);
      expect((await readTenancySnapshot()).businessAudit).toHaveLength(before);
    });

    it("rename is a no-op for the same name and audited otherwise", async () => {
      const { tenancy, ownerContext } = await setup();
      expect((await tenancy.updateBusinessName.execute(ownerContext, { name: "Shop" })).changed).toBe(false);
      expect((await tenancy.updateBusinessName.execute(ownerContext, { name: "New Shop" })).changed).toBe(true);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.businesses[0]?.name).toBe("New Shop");
      const renamed = snapshot.businessAudit.filter((a) => a.action === "business.renamed");
      expect(renamed).toHaveLength(1);
      expect(renamed[0]?.payloadText).toBe('{"changedField":"name"}');
    });
  });

  describe("devices", () => {
    it("register stores only the credential digest; replay returns no credential", async () => {
      const { tenancy, ownerContext, key } = await setup();
      const idempotencyKey = key();
      const first = await tenancy.registerDevice.execute(ownerContext, {
        platform: "ANDROID",
        label: "Till",
        idempotencyKey,
      });
      if (first.replayed) throw new Error("expected an original response");
      const replay = await tenancy.registerDevice.execute(ownerContext, {
        platform: "ANDROID",
        label: "Till",
        idempotencyKey,
      });
      expect(replay).toEqual({ device: first.device, replayed: true });
      const stored = await everyStoredText();
      expect(stored).not.toContain(first.credential);
      expect(stored).not.toContain("tali_dev_");
      const snapshot = await readTenancySnapshot();
      expect(snapshot.devices).toHaveLength(1);
      expect(snapshot.devices[0]?.credentialHashHex).toMatch(/^[0-9a-f]{64}$/);
    });

    it("verification reads the stored digest; revoked or foreign devices fail closed", async () => {
      const { tenancy, ownerContext, key } = await setup();
      const outcome = await tenancy.registerDevice.execute(ownerContext, {
        platform: "ANDROID",
        label: "Till",
        idempotencyKey: key(),
      });
      if (outcome.replayed) throw new Error("expected an original response");
      const presented = { deviceId: outcome.device.id, credential: outcome.credential };
      expect((await tenancy.deviceVerifier.verify(ownerContext, presented)).deviceId).toBe(outcome.device.id);

      const otherUser = await tenancy.registeredUser("other");
      const other = await tenancy.create(otherUser, { name: "Other" });
      const otherContext = await tenancy.contextFor(otherUser, other.result.business.id);
      await expect(tenancy.deviceVerifier.verify(otherContext, presented)).rejects.toThrow(DeviceNotTrustedError);

      await tenancy.revokeDevice.execute(ownerContext, { deviceId: outcome.device.id });
      await expect(tenancy.deviceVerifier.verify(ownerContext, presented)).rejects.toThrow(DeviceNotTrustedError);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.devices[0]).toMatchObject({ status: "REVOKED" });
    });

    it("a verified device is recorded on audit records (composite device reference)", async () => {
      const { tenancy, ownerContext, key } = await setup();
      const outcome = await tenancy.registerDevice.execute(ownerContext, {
        platform: "ANDROID",
        label: "Till",
        idempotencyKey: key(),
      });
      if (outcome.replayed) throw new Error("expected an original response");
      const verified = await tenancy.deviceVerifier.verify(ownerContext, {
        deviceId: outcome.device.id,
        credential: outcome.credential,
      });
      await tenancy.updateBusinessName.execute(verified, { name: "From the till" });
      const snapshot = await readTenancySnapshot();
      expect(snapshot.businessAudit.find((a) => a.action === "business.renamed")?.deviceId).toBe(outcome.device.id);
    });

    it("concurrent revokes: one changes the device, the other is a no-op; one audit record", async () => {
      const { tenancy, ownerContext, key } = await setup();
      const { device } = await tenancy.registerDevice.execute(ownerContext, {
        platform: "ANDROID",
        label: "Till",
        idempotencyKey: key(),
      });
      const results = await Promise.all(
        [0, 1].map(() => tenancy.revokeDevice.execute(ownerContext, { deviceId: device.id })),
      );
      expect(results.map((r) => r.changed).sort()).toEqual([false, true]);
      const snapshot = await readTenancySnapshot();
      expect(snapshot.businessAudit.filter((a) => a.action === "device.revoked")).toHaveLength(1);
    });
  });
});
