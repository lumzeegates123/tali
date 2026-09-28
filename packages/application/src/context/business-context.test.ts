import { parseCurrencyCode, parseId, parseTimeZoneId } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { definePermissionCatalogue, permissionSet } from "../authorization/permissions.js";
import { LocationRequiredError, PermissionDeniedError, ValidationError } from "../errors/application-error.js";
import type { BusinessContext } from "./business-context.js";
import {
  isLocationBound,
  parseCorrelationId,
  requireContextPermission,
  requireLocationBound,
} from "./business-context.js";

const testPermissions = definePermissionCatalogue(["contract-test:read", "contract-test:write"]);

function context(overrides: Partial<BusinessContext> = {}): BusinessContext {
  return {
    businessId: parseId("Business", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f"),
    actor: {
      type: "user",
      userId: parseId("User", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60"),
      membershipId: parseId("Membership", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e61"),
    },
    permissions: permissionSet([testPermissions.permissions["contract-test:read"]]),
    sourceChannel: "web",
    correlationId: parseCorrelationId("req-1"),
    currency: parseCurrencyCode("NGN"),
    timeZone: parseTimeZoneId("Africa/Lagos"),
    ...overrides,
  };
}

describe("location-bound context", () => {
  it("rejects a context without a resolved location", () => {
    expect(isLocationBound(context())).toBe(false);
    expect(() => requireLocationBound(context())).toThrow(LocationRequiredError);
  });

  it("accepts a context with a resolved location", () => {
    const locationId = parseId("Location", "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e62");
    const bound = requireLocationBound(context({ locationId }));
    expect(bound.locationId).toBe(locationId);
  });
});

describe("context permissions", () => {
  it("allows granted permissions and denies others", () => {
    expect(() => {
      requireContextPermission(context(), testPermissions.permissions["contract-test:read"]);
    }).not.toThrow();
    expect(() => {
      requireContextPermission(context(), testPermissions.permissions["contract-test:write"]);
    }).toThrow(PermissionDeniedError);
  });
});

describe("correlation ids", () => {
  it("accepts bounded opaque tokens and rejects anything else", () => {
    expect(parseCorrelationId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f")).toBe("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
    for (const invalid of ["", "a b", "x".repeat(129), "<script>"]) {
      expect(() => parseCorrelationId(invalid)).toThrow(ValidationError);
    }
  });
});
