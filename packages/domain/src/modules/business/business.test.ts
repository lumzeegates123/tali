import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { parseCurrencyCode, parseTimeZoneId } from "../../kernel/index.js";
import { parseUserId } from "../identity/index.js";
import {
  foundBusiness,
  isBusinessActive,
  isCanonicalBusinessTimeZone,
  parseBusinessId,
  parseBusinessName,
  parseBusinessTimeZoneId,
  renameBusiness,
  restoreBusiness,
  TIME_ZONE_REFERENCE_VERSION,
} from "./index.js";
import { CANONICAL_TIME_ZONES, TIME_ZONE_ALIASES } from "./time-zone-reference.js";

const businessId = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const userId = parseUserId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60");
const now = new Date("2026-09-29T10:00:00.000Z");

function business(currency = "NGN") {
  return foundBusiness({
    id: businessId,
    name: parseBusinessName("Mama Put Stores"),
    currencyCode: parseCurrencyCode(currency),
    timeZone: parseBusinessTimeZoneId("Africa/Lagos"),
    createdByUserId: userId,
    now,
  });
}

describe("BusinessTimeZoneId", () => {
  it("accepts canonical zones as they are", () => {
    expect(parseBusinessTimeZoneId("Africa/Lagos")).toBe("Africa/Lagos");
    expect(parseBusinessTimeZoneId("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(parseBusinessTimeZoneId("Etc/UTC")).toBe("Etc/UTC");
  });

  it("normalizes case and maps recognized aliases to the canonical primary zone", () => {
    expect(parseBusinessTimeZoneId("africa/lagos")).toBe("Africa/Lagos");
    expect(parseBusinessTimeZoneId("AFRICA/LAGOS")).toBe("Africa/Lagos");
    expect(parseBusinessTimeZoneId("UTC")).toBe("Etc/UTC");
    expect(parseBusinessTimeZoneId("utc")).toBe("Etc/UTC");
    expect(parseBusinessTimeZoneId("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(parseBusinessTimeZoneId("America/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
  });

  it("rejects raw offsets, malformed values and non-zones", () => {
    for (const invalid of [
      "+01:00",
      "-05:00",
      "GMT+1",
      "",
      " Africa/Lagos",
      "Africa/Atlantis",
      "x".repeat(65),
      "Factory",
    ]) {
      expect(() => parseBusinessTimeZoneId(invalid), invalid).toThrow(DomainError);
    }
  });

  it("does not take Intl's spelling as authoritative", () => {
    const intlSpelling = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" }).resolvedOptions().timeZone;
    expect(parseBusinessTimeZoneId(intlSpelling)).toBe("Asia/Kolkata");
    expect(isCanonicalBusinessTimeZone("Asia/Calcutta")).toBe(false);
    expect(isCanonicalBusinessTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("is a versioned dataset whose zones the pinned runtime can compute dates in", () => {
    expect(TIME_ZONE_REFERENCE_VERSION).toMatch(/^tzdata-[0-9]{4}[a-z]$/);
    expect(new Set(CANONICAL_TIME_ZONES).size).toBe(CANONICAL_TIME_ZONES.length);
    for (const zone of CANONICAL_TIME_ZONES) {
      expect(() => parseTimeZoneId(zone), zone).not.toThrow();
    }
    for (const [alias, canonical] of TIME_ZONE_ALIASES) {
      expect(CANONICAL_TIME_ZONES, alias).toContain(canonical);
      expect(CANONICAL_TIME_ZONES, alias).not.toContain(alias);
    }
  });
});

describe("Business", () => {
  it("normalizes the name by its contract: trim, NFC, 1 to 120 characters", () => {
    expect(parseBusinessName("  Kiosk  ")).toBe("Kiosk");
    expect(parseBusinessName("Cafe\u0301")).toBe("Caf\u00e9");
    for (const invalid of ["", " ", "x".repeat(121)]) {
      expect(() => parseBusinessName(invalid)).toThrow(DomainError);
    }
  });

  it("is created ACTIVE with one currency, a canonical zone and its creator", () => {
    const created = business();
    expect(created).toMatchObject({
      status: "ACTIVE",
      currencyCode: "NGN",
      timeZone: "Africa/Lagos",
      createdByUserId: userId,
    });
    expect(isBusinessActive(created)).toBe(true);
  });

  it("does not special-case any currency", () => {
    expect(business("KES").currencyCode).toBe("KES");
    expect(business("USD").currencyCode).toBe("USD");
  });

  it("restores SUSPENDED businesses and rejects invalid stored values", () => {
    const base = {
      id: businessId,
      name: "Kiosk",
      currencyCode: "NGN",
      timeZone: "Africa/Lagos",
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    };
    expect(isBusinessActive(restoreBusiness({ ...base, status: "SUSPENDED" }))).toBe(false);
    expect(() => restoreBusiness({ ...base, status: "CLOSED" })).toThrow(DomainError);
    expect(() => restoreBusiness({ ...base, status: "ACTIVE", currencyCode: "ngn" })).toThrow(DomainError);
    expect(() => restoreBusiness({ ...base, status: "ACTIVE", timeZone: "africa/lagos" })).toThrow(DomainError);
    expect(() => restoreBusiness({ ...base, status: "ACTIVE", timeZone: "+01:00" })).toThrow(DomainError);
  });

  it("treats setting the current name as a no-op", () => {
    const created = business();
    expect(renameBusiness(created, parseBusinessName("Mama Put Stores"), now)).toEqual({
      changed: false,
      business: created,
    });
    const renamed = renameBusiness(created, parseBusinessName("Mama Put"), new Date("2026-09-30T00:00:00.000Z"));
    expect(renamed.changed).toBe(true);
    expect(renamed.business.name).toBe("Mama Put");
    expect(renamed.business.currencyCode).toBe(created.currencyCode);
  });
});
