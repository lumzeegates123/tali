import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import {
  EXTERNAL_IDENTITY_PROVIDERS,
  externalIdentity,
  isUserActive,
  parseDisplayName,
  parseExternalIdentityId,
  parseProviderSubject,
  parseUserId,
  registerUser,
  restoreUser,
  sameExternalIdentityKey,
} from "./index.js";

const userId = parseUserId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60");
const identityId = parseExternalIdentityId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e70");
const now = new Date("2026-09-29T10:00:00.000Z");

describe("ExternalIdentity", () => {
  it("persists only the real provider categories", () => {
    expect(EXTERNAL_IDENTITY_PROVIDERS).toEqual(["COGNITO", "LOCAL"]);
    for (const provider of ["COGNITO", "LOCAL"]) {
      expect(
        externalIdentity({ id: identityId, userId, provider, providerSubject: "sub-1", createdAt: now }).provider,
      ).toBe(provider);
    }
    for (const provider of ["fake", "cognito", "EMAIL", ""]) {
      expect(() =>
        externalIdentity({ id: identityId, userId, provider, providerSubject: "sub-1", createdAt: now }),
      ).toThrow(DomainError);
    }
  });

  it("requires a subject of 1 to 255 characters and stores it exactly as issued", () => {
    expect(parseProviderSubject(" Sub-A ")).toBe(" Sub-A ");
    expect(parseProviderSubject("x".repeat(255))).toHaveLength(255);
    for (const invalid of ["", "x".repeat(256), "\uD800"]) {
      expect(() => parseProviderSubject(invalid)).toThrow(DomainError);
    }
  });

  it("is keyed by provider and subject, never by contact details", () => {
    const a = externalIdentity({ id: identityId, userId, provider: "LOCAL", providerSubject: "s", createdAt: now });
    expect(sameExternalIdentityKey(a, { provider: "LOCAL", providerSubject: parseProviderSubject("s") })).toBe(true);
    expect(sameExternalIdentityKey(a, { provider: "COGNITO", providerSubject: parseProviderSubject("s") })).toBe(false);
    expect(sameExternalIdentityKey(a, { provider: "LOCAL", providerSubject: parseProviderSubject("S") })).toBe(false);
    expect(Object.keys(a).sort()).toEqual(["createdAt", "id", "provider", "providerSubject", "userId"]);
  });
});

describe("User", () => {
  it("normalizes the display name by its contract: trim, NFC, 1 to 100 characters", () => {
    expect(parseDisplayName("  Ada  ")).toBe("Ada");
    expect(parseDisplayName("Cafe\u0301")).toBe("Caf\u00e9");
    expect(parseDisplayName("\u{1F600}".repeat(100))).toBe("\u{1F600}".repeat(100));
    for (const invalid of ["", "   ", "x".repeat(101), "a\uDC00"]) {
      expect(() => parseDisplayName(invalid)).toThrow(DomainError);
    }
  });

  it("registers ACTIVE users that carry no business, role or contact fields", () => {
    const user = registerUser({ id: userId, displayName: parseDisplayName("Ada"), now });
    expect(user.status).toBe("ACTIVE");
    expect(isUserActive(user)).toBe(true);
    expect(Object.keys(user).sort()).toEqual(["createdAt", "displayName", "id", "status", "updatedAt"]);
  });

  it("restores DISABLED users (test fixtures, storage) and rejects unknown statuses", () => {
    const base = { id: userId, displayName: "Ada", createdAt: now, updatedAt: now };
    const disabled = restoreUser({ ...base, status: "DISABLED" });
    expect(isUserActive(disabled)).toBe(false);
    expect(() => restoreUser({ ...base, status: "DELETED" })).toThrow(DomainError);
    expect(() => restoreUser({ ...base, status: "ACTIVE", createdAt: new Date(Number.NaN) })).toThrow(DomainError);
  });
});
