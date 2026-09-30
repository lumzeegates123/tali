import { describe, expect, it } from "vitest";
import {
  AcceptInvitationRequestSchema,
  AcceptInvitationResponseSchema,
  ChangeMemberRoleRequestSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  DevicesResponseSchema,
  EmptyBodySchema,
  MemberStatusChangeRequestSchema,
  RegisterDeviceRequestSchema,
  RegisterDeviceResponseSchema,
  RevokeInvitationResponseSchema,
  UpdateBusinessNameRequestSchema,
} from "./team.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const SECRET = "opaque-one-time-value";
const invitation = { id: ID, role: "CASHIER", status: "PENDING", expiresAt: "2026-10-02T08:00:00.000Z" };
const device = { id: ID, platform: "ANDROID", label: "Till", status: "ACTIVE" };

describe("slice 5 request contracts", () => {
  it("rename takes the name only", () => {
    expect(UpdateBusinessNameRequestSchema.parse({ name: "Duka" })).toEqual({ name: "Duka" });
    for (const body of [{}, { name: "Duka", currencyCode: "KES" }, { name: "Duka", timeZone: "UTC" }, { name: 1 }]) {
      expect(UpdateBusinessNameRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("invitations offer the four invitable roles, never OWNER, and no business or expiry claims", () => {
    for (const role of ["MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"]) {
      expect(CreateInvitationRequestSchema.safeParse({ role }).success).toBe(true);
    }
    for (const body of [
      { role: "OWNER" },
      { role: "cashier" },
      { role: "CASHIER", businessId: ID },
      { role: "CASHIER", expiresAt: "x" },
    ]) {
      expect(CreateInvitationRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("acceptance takes a bounded token in the body only", () => {
    expect(AcceptInvitationRequestSchema.parse({ token: SECRET })).toEqual({ token: SECRET });
    for (const body of [{}, { token: "" }, { token: "x".repeat(257) }, { token: SECRET, businessId: ID }]) {
      expect(AcceptInvitationRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("member changes require a role or a reason and nothing else", () => {
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "OWNER", reason: "Promotion" }).success).toBe(true);
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "OWNER" }).success).toBe(false);
    expect(ChangeMemberRoleRequestSchema.safeParse({ role: "OWNER", reason: "x", version: 1 }).success).toBe(false);
    expect(MemberStatusChangeRequestSchema.safeParse({ reason: "Leave" }).success).toBe(true);
    expect(MemberStatusChangeRequestSchema.safeParse({ reason: "x".repeat(2001) }).success).toBe(false);
    expect(MemberStatusChangeRequestSchema.safeParse({ reason: "Leave", status: "ACTIVE" }).success).toBe(false);
  });

  it("device registration is Android-only and never accepts a client-chosen ID or credential", () => {
    expect(RegisterDeviceRequestSchema.safeParse({ platform: "ANDROID", label: "Till" }).success).toBe(true);
    for (const body of [
      { platform: "IOS", label: "Till" },
      { platform: "ANDROID", label: "Till", id: ID },
      { platform: "ANDROID", label: "Till", credential: SECRET },
      { platform: "ANDROID", label: "x".repeat(241) },
    ]) {
      expect(RegisterDeviceRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("body-less routes reject any field", () => {
    expect(EmptyBodySchema.safeParse({}).success).toBe(true);
    expect(EmptyBodySchema.safeParse({ reason: "x" }).success).toBe(false);
  });
});

describe("slice 5 response contracts: one-time secrets", () => {
  it("an invitation token appears only with tokenAvailable: true", () => {
    expect(CreateInvitationResponseSchema.safeParse({ invitation, tokenAvailable: true, token: SECRET }).success).toBe(
      true,
    );
    expect(CreateInvitationResponseSchema.safeParse({ invitation, tokenAvailable: false }).success).toBe(true);
    expect(CreateInvitationResponseSchema.safeParse({ invitation, tokenAvailable: false, token: SECRET }).success).toBe(
      false,
    );
    expect(CreateInvitationResponseSchema.safeParse({ invitation, tokenAvailable: true }).success).toBe(false);
    expect(CreateInvitationResponseSchema.safeParse({ invitation, token: SECRET }).success).toBe(false);
  });

  it("a device credential appears only with credentialAvailable: true", () => {
    expect(
      RegisterDeviceResponseSchema.safeParse({ device, credentialAvailable: true, credential: SECRET }).success,
    ).toBe(true);
    expect(RegisterDeviceResponseSchema.safeParse({ device, credentialAvailable: false }).success).toBe(true);
    expect(
      RegisterDeviceResponseSchema.safeParse({ device, credentialAvailable: false, credential: SECRET }).success,
    ).toBe(false);
  });

  it("device listings and revocations carry safe metadata only", () => {
    expect(DevicesResponseSchema.safeParse({ items: [device], nextCursor: null }).success).toBe(true);
    for (const extra of [{ credential: SECRET }, { credentialHash: "00" }, { registeredByMembershipId: ID }]) {
      expect(DevicesResponseSchema.safeParse({ items: [{ ...device, ...extra }], nextCursor: null }).success).toBe(
        false,
      );
    }
    expect(RevokeInvitationResponseSchema.safeParse({ invitation: { ...invitation, tokenHash: "00" } }).success).toBe(
      false,
    );
  });

  it("acceptance returns the business and the caller's membership only", () => {
    const business = { id: ID, name: "Duka", currencyCode: "KES", timeZone: "Africa/Nairobi" };
    const membership = { id: ID, role: "CASHIER", status: "ACTIVE" };
    expect(AcceptInvitationResponseSchema.safeParse({ business, membership }).success).toBe(true);
    expect(AcceptInvitationResponseSchema.safeParse({ business, membership, invitation }).success).toBe(false);
  });
});
