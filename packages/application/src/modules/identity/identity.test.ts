import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "../../context/business-context.js";
import {
  AuthenticationError,
  UserDisabledError,
  UserNotRegisteredError,
  ValidationError,
} from "../../errors/application-error.js";
import { AuditRecorder } from "../../audit/audit-recorder.js";
import { taliAuditRegistry } from "../../audit/tali-audit-registry.js";
import { FakeIdentityProvider } from "../../testing/fake-identity-provider.js";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";
import { createRegisterCurrentUser } from "./register-current-user.js";

const request = { correlationId: parseCorrelationId("req-1"), sourceChannel: "mobile" } as const;

function harness() {
  return createTenancyHarness({ currencies: [defineCurrency("KES", 2)] });
}

describe("RegisterCurrentUser", () => {
  it("registers an unknown identity as an ACTIVE user with its external identity", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    const result = await h.registerCurrentUser.execute({ ...request, identity, displayName: "  Ada  " });
    expect(result.registered).toBe(true);
    expect(result.user).toMatchObject({ displayName: "Ada", status: "ACTIVE" });
    expect(h.store.externalIdentities).toEqual([
      expect.objectContaining({ userId: result.user.id, provider: "LOCAL", providerSubject: "subject-1" }),
    ]);
  });

  it("writes user.registered and identity.linked platform audit records without identity secrets", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    const { user } = await h.registerCurrentUser.execute({ ...request, identity, displayName: "Ada" });
    const identityId = h.store.externalIdentities[0]?.id;
    expect(h.auditWriter.businessRecords).toHaveLength(0);
    expect(h.auditWriter.platformRecords).toEqual([
      expect.objectContaining({
        action: "user.registered",
        entityType: "user",
        entityId: user.id,
        subjectUserId: user.id,
        actor: { type: "user", userId: user.id },
        sourceChannel: "mobile",
        correlationId: "req-1",
        payload: { status: "ACTIVE" },
      }),
      expect.objectContaining({
        action: "identity.linked",
        entityType: "external_identity",
        entityId: identityId,
        payload: { userId: user.id, provider: "LOCAL" },
      }),
    ]);
    const serialized = JSON.stringify(h.auditWriter.platformRecords);
    expect(serialized).not.toContain("subject-1");
    expect(serialized).not.toContain("Ada");
  });

  it("is a no-op for an already registered identity: same user, no new audit", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    const first = await h.registerCurrentUser.execute({ ...request, identity, displayName: "Ada" });
    const second = await h.registerCurrentUser.execute({ ...request, identity, displayName: "Different" });
    expect(second).toEqual({ user: first.user, registered: false });
    expect(h.store.users).toHaveLength(1);
    expect(h.auditWriter.platformRecords).toHaveLength(2);
  });

  it("returns the winner when a concurrent registration linked the identity first", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    const winner = await h.registerCurrentUser.execute({ ...request, identity, displayName: "Ada" });
    const repository = h.store.userRepository;
    let calls = 0;
    const racing: typeof repository = {
      ...repository,
      // The first lookup misses (the race), the insert then loses on the unique key.
      findByExternalIdentity: async (scope, key) => {
        calls += 1;
        return calls === 1 ? undefined : repository.findByExternalIdentity(scope, key);
      },
    };
    const register = createRegisterCurrentUser({
      unitOfWork: h.unitOfWork,
      users: racing,
      audit: new AuditRecorder({ registry: taliAuditRegistry, writer: h.auditWriter, clock: h.clock, ids: h.ids }),
      ids: h.ids,
      clock: h.clock,
    });
    expect(await register.execute({ ...request, identity, displayName: "Ada" })).toEqual({
      user: winner.user,
      registered: false,
    });
    expect(h.store.users).toHaveLength(1);
    expect(h.auditWriter.platformRecords).toHaveLength(2);
  });

  it("rejects an invalid display name without writing anything", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    for (const displayName of ["", "   ", "x".repeat(101), "\uD800"]) {
      await expect(h.registerCurrentUser.execute({ ...request, identity, displayName })).rejects.toThrow(
        ValidationError,
      );
    }
    expect(h.store.users).toHaveLength(0);
    expect(h.auditWriter.all).toHaveLength(0);
  });

  it("accepts a 100-character display name after NFC", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    const { user } = await h.registerCurrentUser.execute({ ...request, identity, displayName: "e\u0301".repeat(100) });
    expect(user.displayName).toBe("é".repeat(100));
  });

  it("never reports a DISABLED user as registered", async () => {
    const h = harness();
    const user = await h.registeredUser("subject-1");
    h.setUserStatus(user, "DISABLED");
    await expect(
      h.registerCurrentUser.execute({ ...request, identity: user.identity, displayName: "Ada" }),
    ).rejects.toThrow(UserDisabledError);
  });

  it("rolls back the user when an audit write fails", async () => {
    const h = harness();
    const identity = await h.identityFor("subject-1");
    h.auditWriter.failures.failNext("audit.identity.linked");
    await expect(h.registerCurrentUser.execute({ ...request, identity, displayName: "Ada" })).rejects.toThrow();
    expect(h.store.users).toHaveLength(0);
    expect(h.store.externalIdentities).toHaveLength(0);
    expect(h.auditWriter.all).toHaveLength(0);
    expect(h.unitOfWork.rollbacks).toBe(1);
  });

  it("distinguishes the same subject from different providers", async () => {
    const h = harness();
    const cognito = new FakeIdentityProvider(h.clock, { provider: "COGNITO" });
    const local = await h.identityFor("same-subject");
    const remote = await cognito.verifyAccessToken(cognito.issueToken("same-subject"));
    await h.registerCurrentUser.execute({ ...request, identity: local, displayName: "Ada" });
    const second = await h.registerCurrentUser.execute({ ...request, identity: remote, displayName: "Ada" });
    expect(second.registered).toBe(true);
    expect(h.store.users).toHaveLength(2);
  });
});

describe("user context resolution", () => {
  it("resolves a registered ACTIVE user", async () => {
    const h = harness();
    const user = await h.registeredUser("subject-1");
    expect(await h.userContexts.resolve(user.identity, request)).toEqual({ userId: user.userId, ...request });
  });

  it("rejects an unregistered identity with USER_NOT_REGISTERED", async () => {
    const h = harness();
    await expect(h.userContexts.resolve(await h.identityFor("nobody"), request)).rejects.toThrow(
      UserNotRegisteredError,
    );
  });

  it("rejects a DISABLED user with USER_DISABLED", async () => {
    const h = harness();
    const user = await h.registeredUser("subject-1");
    h.setUserStatus(user, "DISABLED");
    await expect(h.userContexts.resolve(user.identity, request)).rejects.toThrow(UserDisabledError);
  });

  it("fails authentication for an unusable subject", async () => {
    const h = harness();
    await expect(h.userContexts.resolve(await h.identityFor(""), request)).rejects.toThrow(AuthenticationError);
  });

  it("never matches by display name or another subject", async () => {
    const h = harness();
    await h.registeredUser("subject-1", "Ada");
    await expect(h.userContexts.resolve(await h.identityFor("Ada"), request)).rejects.toThrow(UserNotRegisteredError);
  });
});

describe("GetCurrentUser", () => {
  it("returns the caller's profile", async () => {
    const h = harness();
    const user = await h.registeredUser("subject-1", "Ada");
    expect(await h.getCurrentUser.execute(user.context)).toMatchObject({ id: user.userId, displayName: "Ada" });
  });

  it("rejects a user disabled after context resolution", async () => {
    const h = harness();
    const user = await h.registeredUser("subject-1");
    h.setUserStatus(user, "DISABLED");
    await expect(h.getCurrentUser.execute(user.context)).rejects.toThrow(UserDisabledError);
  });
});
