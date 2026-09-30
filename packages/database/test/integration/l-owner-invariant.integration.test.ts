import { ConcurrentModificationError, type TransactionScope, type UnitOfWork } from "@tali/application";
import {
  type BusinessId,
  changeMembershipRole,
  DomainError,
  type MembershipTransition,
  parseMembershipChangeReason,
  suspendMembership,
  type UserId,
} from "@tali/domain";
import { describe, expect, it } from "vitest";
import { delay, gate } from "../support/harness.js";
import { type RegisteredUser, useTenancyHarness } from "../support/tenancy.js";

/**
 * The owner invariant under concurrency (ADR-005 section 10): every change
 * that can reduce the active owners takes the business row lock, re-reads the
 * acting and target memberships under it, counts the active owners and then
 * applies the pure domain decision. These tests drive that sequence through
 * the MembershipRepository primitives; the member-management use cases that
 * compose it arrive with Slice 5.
 */
describe("owner invariant (business row lock)", () => {
  const harness = useTenancyHarness();
  const { repositories, owner } = harness;
  const { memberships } = repositories;
  const reason = parseMembershipChangeReason("Owner handover");

  type Change = "demote" | "suspend";

  async function changeOwner(
    scope: TransactionScope,
    change: Change,
    businessId: BusinessId,
    actorUserId: UserId,
    targetUserId: UserId,
    hooks: { readonly afterCount?: () => Promise<void>; readonly lock?: boolean } = {},
  ): Promise<MembershipTransition> {
    if (hooks.lock !== false) {
      expect(await memberships.lockBusinessForMembershipChange(scope, businessId)).toBe(true);
    }
    const actor = await memberships.findByBusinessAndUser(scope, businessId, actorUserId);
    const target = await memberships.findByBusinessAndUser(scope, businessId, targetUserId);
    if (actor === undefined || target === undefined) throw new Error("membership missing");
    const owners = { activeOwnerCount: await memberships.countActiveOwners(scope, businessId) };
    await hooks.afterCount?.();
    const now = harness.world().clock.now();
    const transition =
      change === "demote"
        ? changeMembershipRole({ target, role: "MANAGER", actor, reason, owners, now })
        : suspendMembership({ target, actor, reason, owners, now });
    if (transition.outcome === "changed") await memberships.update(scope, transition.previous, transition.membership);
    return transition;
  }

  async function twoOwners(): Promise<{ businessId: BusinessId; first: RegisteredUser; second: RegisteredUser }> {
    const tenancy = harness.compose();
    const first = await tenancy.registeredUser("owner-one");
    const second = await tenancy.registeredUser("owner-two");
    const { result } = await tenancy.create(first);
    await harness.addMember(result.business.id, second, "OWNER");
    return { businessId: result.business.id, first, second };
  }

  const activeOwners = async (businessId: BusinessId) =>
    Number(
      (
        await owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM business_memberships WHERE business_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'`,
          [businessId],
        )
      ).rows[0]?.n,
    );

  const rejectionCode = (result: PromiseSettledResult<unknown> | undefined) => {
    const reason = (result as PromiseRejectedResult | undefined)?.reason as unknown;
    expect(reason).toBeInstanceOf(DomainError);
    return (reason as DomainError).code;
  };

  it.each(["demote", "suspend"] as const)(
    "the two remaining owners %s themselves concurrently: exactly one succeeds (LAST_ACTIVE_OWNER)",
    async (change) => {
      const { businessId, first, second } = await twoOwners();
      const firstCounted = gate();
      const run = (self: RegisteredUser, afterCount?: () => Promise<void>) =>
        harness.unitOfWork.run((scope) =>
          changeOwner(scope, change, businessId, self.userId, self.userId, afterCount ? { afterCount } : {}),
        );

      // The first holds the lock after counting; the second waits for it, then counts again.
      const a = run(first, async () => {
        firstCounted.open();
        await delay(200);
      });
      await firstCounted.opened;
      const b = run(second);
      const results = await Promise.allSettled([a, b]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(rejectionCode(results[1])).toBe("LAST_ACTIVE_OWNER");
      expect(await activeOwners(businessId)).toBe(1);
    },
  );

  it("without the lock the same interleaving removes both owners (control: the lock is what protects)", async () => {
    const { businessId, first, second } = await twoOwners();
    const bothCounted = { a: gate(), b: gate() };
    const run = (self: "a" | "b", user: RegisteredUser) =>
      harness.unitOfWork.run((scope) =>
        changeOwner(scope, "demote", businessId, user.userId, user.userId, {
          lock: false,
          afterCount: async () => {
            bothCounted[self].open();
            await Promise.all([bothCounted.a.opened, bothCounted.b.opened]);
          },
        }),
      );
    await Promise.all([run("a", first), run("b", second)]);
    expect(await activeOwners(businessId)).toBe(0);
  });

  it.each([
    ["demote", "OWNER_REQUIRED"],
    ["suspend", "INVALID_TRANSITION"],
  ] as const)(
    "owners who %s each other concurrently: the second re-reads its own membership under the lock and is refused",
    async (change, code) => {
      const { businessId, first, second } = await twoOwners();
      const firstCounted = gate();
      const a = harness.unitOfWork.run((scope) =>
        changeOwner(scope, change, businessId, first.userId, second.userId, {
          afterCount: async () => {
            firstCounted.open();
            await delay(200);
          },
        }),
      );
      await firstCounted.opened;
      const b = harness.unitOfWork.run((scope) => changeOwner(scope, change, businessId, second.userId, first.userId));
      const results = await Promise.allSettled([a, b]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(rejectionCode(results[1])).toBe(code);
      expect(await activeOwners(businessId)).toBe(1);
    },
  );

  it("the lock is held until the transaction ends: a second locker waits for the commit", async () => {
    const { businessId } = await twoOwners();
    const events: string[] = [];
    const locked = gate();
    const first = harness.unitOfWork.run(async (scope) => {
      await memberships.lockBusinessForMembershipChange(scope, businessId);
      locked.open();
      await delay(200);
      events.push("first-commit");
    });
    await locked.opened;
    const second = harness.unitOfWork.run(async (scope) => {
      await memberships.lockBusinessForMembershipChange(scope, businessId);
      events.push("second-locked");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first-commit", "second-locked"]);
  });

  it("locking another business does not block", async () => {
    const { businessId } = await twoOwners();
    const tenancy = harness.compose();
    const other = await tenancy.create(await tenancy.registeredUser("other-owner"));
    const locked = gate();
    const release = gate();
    const holder = harness.unitOfWork.run(async (scope) => {
      await memberships.lockBusinessForMembershipChange(scope, businessId);
      locked.open();
      await release.opened;
    });
    await locked.opened;
    const quick: UnitOfWork = harness.unitOfWorkWith({ lockTimeoutMs: 200 });
    await expect(
      quick.run((scope) => memberships.lockBusinessForMembershipChange(scope, other.result.business.id)),
    ).resolves.toBe(true);
    release.open();
    await holder;
  });

  it("a lock wait past lock_timeout is CONCURRENT_MODIFICATION and is not retried", async () => {
    const { businessId } = await twoOwners();
    const locked = gate();
    const release = gate();
    const holder = harness.unitOfWork.run(async (scope) => {
      await memberships.lockBusinessForMembershipChange(scope, businessId);
      locked.open();
      await release.opened;
    });
    await locked.opened;
    let attempts = 0;
    const quick = harness.unitOfWorkWith({ lockTimeoutMs: 200 });
    await expect(
      quick.run(async (scope) => {
        attempts += 1;
        await memberships.lockBusinessForMembershipChange(scope, businessId);
      }),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
    expect(attempts).toBe(1);
    release.open();
    await holder;
  });

  it("reports a missing business and counts only ACTIVE OWNER memberships", async () => {
    const { businessId, first } = await twoOwners();
    const tenancy = harness.compose();
    const manager = await tenancy.registeredUser("manager");
    const suspended = await tenancy.registeredUser("suspended-owner");
    await harness.addMember(businessId, manager, "MANAGER");
    await harness.addMember(businessId, suspended, "OWNER", "SUSPENDED");
    await harness.unitOfWork.run(async (scope) => {
      expect(await memberships.countActiveOwners(scope, businessId)).toBe(2);
      const missing = harness.world().ids.newId("Business");
      expect(await memberships.lockBusinessForMembershipChange(scope, missing)).toBe(false);
      expect(await memberships.countActiveOwners(scope, missing)).toBe(0);
    });
    expect(first.userId).toBeDefined();
  });

  it("update is optimistic: a stale version is CONCURRENT_MODIFICATION and changes nothing", async () => {
    const { businessId, first, second } = await twoOwners();
    const stale = await harness.unitOfWork.run((scope) =>
      memberships.findByBusinessAndUser(scope, businessId, second.userId),
    );
    await harness.unitOfWork.run((scope) => changeOwner(scope, "demote", businessId, first.userId, second.userId));
    if (stale === undefined) throw new Error("membership missing");
    const now = harness.world().clock.now();
    const retry = { ...stale, status: "SUSPENDED" as const, version: stale.version + 1, updatedAt: now };
    await expect(harness.unitOfWork.run((scope) => memberships.update(scope, stale, retry))).rejects.toBeInstanceOf(
      ConcurrentModificationError,
    );
    const { rows } = await owner.query(
      `SELECT role, status, version FROM business_memberships WHERE business_id = $1 AND user_id = $2`,
      [businessId, second.userId],
    );
    expect(rows).toEqual([{ role: "MANAGER", status: "ACTIVE", version: 2 }]);
  });

  it("update rejects a transition that changes identity or skips a version (programming error)", async () => {
    const { businessId, second } = await twoOwners();
    const current = await harness.unitOfWork.run((scope) =>
      memberships.findByBusinessAndUser(scope, businessId, second.userId),
    );
    if (current === undefined) throw new Error("membership missing");
    await expect(
      harness.unitOfWork.run((scope) =>
        memberships.update(scope, current, { ...current, version: current.version + 2 }),
      ),
    ).rejects.toThrow(/advance the version by one/);
  });
});
