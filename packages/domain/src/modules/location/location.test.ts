import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { parseCurrencyCode } from "../../kernel/index.js";
import {
  foundBusiness,
  parseBusinessId,
  parseBusinessName,
  parseBusinessTimeZoneId,
  renameBusiness,
} from "../business/index.js";
import { parseUserId } from "../identity/index.js";
import { createDefaultLocation, parseLocationId, restoreLocation } from "./index.js";

const now = new Date("2026-09-29T10:00:00.000Z");
const business = foundBusiness({
  id: parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f"),
  name: parseBusinessName("Mama Put Stores"),
  currencyCode: parseCurrencyCode("NGN"),
  timeZone: parseBusinessTimeZoneId("Africa/Lagos"),
  createdByUserId: parseUserId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60"),
  now,
});
const locationId = parseLocationId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e62");

describe("BusinessLocation", () => {
  it("creates one ACTIVE default location named with a snapshot of the business name", () => {
    const location = createDefaultLocation({ id: locationId, business, now });
    expect(location).toMatchObject({
      businessId: business.id,
      name: "Mama Put Stores",
      isDefault: true,
      status: "ACTIVE",
    });
  });

  it("keeps its name when the business is renamed", () => {
    const location = createDefaultLocation({ id: locationId, business, now });
    const renamed = renameBusiness(business, parseBusinessName("Mama Put"), now).business;
    expect(renamed.name).toBe("Mama Put");
    expect(location.name).toBe("Mama Put Stores");
  });

  it("never restores a default location that is not ACTIVE", () => {
    const base = { id: locationId, businessId: business.id, name: "Shop", createdAt: now, updatedAt: now };
    expect(restoreLocation({ ...base, isDefault: false, status: "ARCHIVED" }).status).toBe("ARCHIVED");
    expect(() => restoreLocation({ ...base, isDefault: true, status: "ARCHIVED" })).toThrow(DomainError);
    expect(() => restoreLocation({ ...base, isDefault: true, status: "CLOSED" })).toThrow(DomainError);
    expect(() => restoreLocation({ ...base, isDefault: true, status: "ACTIVE", name: "" })).toThrow(DomainError);
  });
});
