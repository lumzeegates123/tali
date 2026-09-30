import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import {
  DEVICE_PLATFORMS,
  isDeviceActive,
  parseDeviceId,
  parseDeviceLabel,
  parseDevicePlatform,
  registerDevice,
  restoreDevice,
  revokeDevice,
} from "./index.js";

const businessId = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const deviceId = parseDeviceId("01928c6e-8b3a-7c4d-9e5f-00000000d001");
const cashier = parseMembershipId("01928c6e-8b3a-7c4d-9e5f-00000000b001");
const owner = parseMembershipId("01928c6e-8b3a-7c4d-9e5f-00000000b002");
const now = new Date("2026-09-29T10:00:00.000Z");
const later = new Date("2026-09-29T11:00:00.000Z");

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

const registered = () =>
  registerDevice({
    id: deviceId,
    businessId,
    platform: "ANDROID",
    label: parseDeviceLabel("Counter phone"),
    registeredByMembershipId: cashier,
    now,
  });

describe("device values", () => {
  it("supports ANDROID only, the accepted platform vocabulary", () => {
    expect(DEVICE_PLATFORMS).toEqual(["ANDROID"]);
    expect(parseDevicePlatform("ANDROID")).toBe("ANDROID");
    for (const platform of ["IOS", "android", "WEB", ""]) {
      expectDomainError(() => parseDevicePlatform(platform), "INVALID_VALUE");
    }
  });

  it("labels are trimmed, NFC-normalized, 1 to 60 characters", () => {
    expect(parseDeviceLabel("  Till 1  ")).toBe("Till 1");
    expect(parseDeviceLabel("Cafe\u0301")).toBe("Caf\u00e9");
    expect(parseDeviceLabel("x".repeat(60))).toHaveLength(60);
    expectDomainError(() => parseDeviceLabel("   "), "INVALID_VALUE");
    expectDomainError(() => parseDeviceLabel("x".repeat(61)), "INVALID_VALUE");
  });
});

describe("device lifecycle", () => {
  it("is registered ACTIVE by a membership", () => {
    const device = registered();
    expect(device).toMatchObject({ status: "ACTIVE", platform: "ANDROID", registeredByMembershipId: cashier });
    expect(isDeviceActive(device)).toBe(true);
    expect(Object.isFrozen(device)).toBe(true);
  });

  it("revokes ACTIVE; REVOKED is a no-op; there is no way back", () => {
    const first = revokeDevice({ device: registered(), revokedByMembershipId: owner, now: later });
    expect(first.outcome).toBe("changed");
    expect(first.device).toMatchObject({ status: "REVOKED", revokedByMembershipId: owner, revokedAt: later });
    expect(isDeviceActive(first.device)).toBe(false);
    const again = revokeDevice({ device: first.device, revokedByMembershipId: owner, now: later });
    expect(again).toEqual({ outcome: "unchanged", device: first.device });
  });

  it("restores only consistent stored states", () => {
    const base = {
      id: deviceId,
      businessId,
      platform: "ANDROID",
      label: "Till",
      registeredByMembershipId: cashier,
      registeredAt: now,
    };
    expect(restoreDevice({ ...base, status: "ACTIVE" }).status).toBe("ACTIVE");
    expect(restoreDevice({ ...base, status: "REVOKED", revokedByMembershipId: owner, revokedAt: later }).status).toBe(
      "REVOKED",
    );
    expectDomainError(() => restoreDevice({ ...base, status: "REVOKED" }), "INVALID_VALUE");
    expectDomainError(() => restoreDevice({ ...base, status: "ACTIVE", revokedAt: later }), "INVALID_VALUE");
    expectDomainError(() => restoreDevice({ ...base, status: "LOST" }), "INVALID_VALUE");
    expectDomainError(() => restoreDevice({ ...base, status: "ACTIVE", platform: "IOS" }), "INVALID_VALUE");
  });
});
