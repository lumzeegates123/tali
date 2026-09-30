import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  DeviceNotTrustedError,
  IdempotencyKeyReusedError,
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
  h.addMember(mine.business.id, staff, "CASHIER");
  const ownerContext = await h.businessContexts.resolveForUser(owner.context, mine.business.id);
  const cashierContext = await h.businessContexts.resolveForUser(staff.context, mine.business.id);
  const otherContext = await h.businessContexts.resolveForUser(other.context, theirs.business.id);
  const key = () => h.ids.newId("IdempotencyKey");
  const register = async (context = cashierContext, idempotencyKey: string = key(), label = "Counter phone") => {
    const outcome = await h.registerDevice.execute(context, { platform: "ANDROID", label, idempotencyKey });
    return outcome;
  };
  return { h, owner, staff, mine, theirs, ownerContext, cashierContext, otherContext, key, register };
}

describe("RegisterDevice", () => {
  it("registers an ACTIVE device with a server-generated ID and a one-time credential", async () => {
    const { h, register, cashierContext } = await setup();
    const outcome = await register();
    if (outcome.replayed) throw new Error("expected an original response");
    expect(outcome.device).toMatchObject({
      platform: "ANDROID",
      label: "Counter phone",
      status: "ACTIVE",
      registeredByMembershipId: cashierContext.actor.type === "user" ? cashierContext.actor.membershipId : "",
    });
    expect(outcome.credential).toMatch(/^tali_dev_[A-Za-z0-9_-]{43}$/);
    const audit = h.auditWriter.businessRecords.at(-1);
    expect(audit).toMatchObject({ action: "device.registered", entityId: outcome.device.id });
    const persisted = JSON.stringify({
      a: h.auditWriter.all,
      i: h.businessIdempotencyStore.records,
      d: h.store.devices,
    });
    expect(persisted).not.toContain(outcome.credential);
    expect(persisted).not.toContain('Counter phone","payload');
  });

  it("replays without the credential; a different command with the key is IDEMPOTENCY_KEY_REUSED", async () => {
    const { h, register, key } = await setup();
    const idempotencyKey = key();
    const first = await register(undefined, idempotencyKey);
    const replay = await register(undefined, idempotencyKey);
    expect(replay).toEqual({ device: first.device, replayed: true });
    expect(h.store.devices).toHaveLength(1);
    expect(JSON.stringify(h.businessIdempotencyStore.records)).not.toMatch(/tali_dev_/);
    await expect(register(undefined, idempotencyKey, "Another label")).rejects.toThrow(IdempotencyKeyReusedError);
  });

  it("scopes keys per actor: the same key from another member registers a separate device", async () => {
    const { h, register, key, ownerContext, cashierContext } = await setup();
    const idempotencyKey = key();
    const a = await register(cashierContext, idempotencyKey);
    const b = await register(ownerContext, idempotencyKey);
    expect(b.replayed).toBe(false);
    expect(a.device.id).not.toBe(b.device.id);
    expect(h.store.devices).toHaveLength(2);
  });

  it("rejects an unsupported platform and a bad label", async () => {
    const { h, cashierContext, key } = await setup();
    for (const input of [
      { platform: "IOS", label: "Phone" },
      { platform: "ANDROID", label: "  " },
      { platform: "ANDROID", label: "x".repeat(61) },
    ]) {
      await expect(h.registerDevice.execute(cashierContext, { ...input, idempotencyKey: key() })).rejects.toThrow(
        ValidationError,
      );
    }
  });
});

describe("ListDevices and RevokeDevice", () => {
  it("lists this business's devices for device:read only", async () => {
    const { h, register, ownerContext, cashierContext, otherContext } = await setup();
    await register();
    await register(otherContext);
    const page = await h.listDevices.execute(ownerContext);
    expect(page.items).toHaveLength(1);
    await expect(h.listDevices.execute(cashierContext)).rejects.toThrow(PermissionDeniedError);
  });

  it("revokes once (OWNER only); a second revoke is a no-op without audit", async () => {
    const { h, register, ownerContext, cashierContext, mine } = await setup();
    const { device } = await register();
    await expect(h.revokeDevice.execute(cashierContext, { deviceId: device.id })).rejects.toThrow(
      PermissionDeniedError,
    );
    const first = await h.revokeDevice.execute(ownerContext, { deviceId: device.id });
    expect(first.device).toMatchObject({ status: "REVOKED", revokedByMembershipId: mine.membership.id });
    expect((await h.revokeDevice.execute(ownerContext, { deviceId: device.id })).changed).toBe(false);
    expect(h.auditWriter.businessRecords.filter((r) => r.action === "device.revoked")).toHaveLength(1);
  });

  it("hides malformed, unknown and foreign device IDs behind NOT_FOUND", async () => {
    const { h, register, ownerContext, otherContext } = await setup();
    const foreign = await register(otherContext);
    for (const deviceId of ["x", h.ids.newId("Device"), foreign.device.id]) {
      await expect(h.revokeDevice.execute(ownerContext, { deviceId })).rejects.toThrow(NotFoundError);
    }
    expect(h.store.devices.find((d) => d.id === foreign.device.id)?.status).toBe("ACTIVE");
  });
});

describe("device verification", () => {
  it("leaves the context unchanged without device headers", async () => {
    const { h, cashierContext } = await setup();
    const verified = await h.deviceVerifier.verify(cashierContext, { deviceId: undefined, credential: undefined });
    expect(verified).toBe(cashierContext);
    expect(verified.deviceId).toBeUndefined();
  });

  it("sets deviceId only for an ACTIVE device of the context business with the matching credential", async () => {
    const { h, register, cashierContext } = await setup();
    const outcome = await register();
    if (outcome.replayed) throw new Error("expected an original response");
    const verified = await h.deviceVerifier.verify(cashierContext, {
      deviceId: outcome.device.id,
      credential: outcome.credential,
    });
    expect(verified.deviceId).toBe(outcome.device.id);
    expect(verified.actor).toEqual(cashierContext.actor);
    expect(verified.permissions).toBe(cashierContext.permissions);
  });

  it("another member of the same business may present the device; it grants no permissions", async () => {
    const { h, register, ownerContext, cashierContext } = await setup();
    const outcome = await register(ownerContext);
    if (outcome.replayed) throw new Error("expected an original response");
    const verified = await h.deviceVerifier.verify(cashierContext, {
      deviceId: outcome.device.id,
      credential: outcome.credential,
    });
    expect(verified.actor).toEqual(cashierContext.actor);
    await expect(h.listDevices.execute(verified)).rejects.toThrow(PermissionDeniedError);
  });

  it("fails closed with one DEVICE_NOT_TRUSTED for every bad presentation", async () => {
    const { h, register, cashierContext, ownerContext, otherContext } = await setup();
    const mine = await register();
    const other = await register(otherContext);
    const revoked = await register();
    if (mine.replayed || other.replayed || revoked.replayed) throw new Error("expected original responses");
    await h.revokeDevice.execute(ownerContext, { deviceId: revoked.device.id });
    const cases: [string, { deviceId: string | undefined; credential: string | undefined }][] = [
      ["id only", { deviceId: mine.device.id, credential: undefined }],
      ["credential only", { deviceId: undefined, credential: mine.credential }],
      ["malformed id", { deviceId: "abc", credential: mine.credential }],
      ["malformed credential", { deviceId: mine.device.id, credential: "tali_dev_short" }],
      ["invitation-format credential", { deviceId: mine.device.id, credential: h.secrets.generate("invitation") }],
      ["unknown device", { deviceId: h.ids.newId("Device"), credential: mine.credential }],
      ["foreign device", { deviceId: other.device.id, credential: other.credential }],
      ["mismatch", { deviceId: mine.device.id, credential: other.credential }],
      ["revoked", { deviceId: revoked.device.id, credential: revoked.credential }],
      ["empty strings", { deviceId: "", credential: "" }],
    ];
    for (const [label, presented] of cases) {
      const error = await h.deviceVerifier.verify(cashierContext, presented).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(DeviceNotTrustedError);
      expect((error as DeviceNotTrustedError).message, label).toBe("This device is not trusted for this business");
    }
  });

  it("the verified device flows into the audit envelope as evidence", async () => {
    const { h, register, ownerContext } = await setup();
    const outcome = await register(ownerContext);
    if (outcome.replayed) throw new Error("expected an original response");
    const verified = await h.deviceVerifier.verify(ownerContext, {
      deviceId: outcome.device.id,
      credential: outcome.credential,
    });
    await h.updateBusinessName.execute(verified, { name: "From the till" });
    expect(h.auditWriter.businessRecords.at(-1)).toMatchObject({
      action: "business.renamed",
      deviceId: outcome.device.id,
      actor: ownerContext.actor,
    });
  });
});
