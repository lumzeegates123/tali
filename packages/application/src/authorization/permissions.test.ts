import { describe, expect, it } from "vitest";
import { PermissionDeniedError } from "../errors/application-error.js";
import {
  definePermissionCatalogue,
  hasPermission,
  isPermissionName,
  permissionSet,
  requirePermission,
} from "./permissions.js";

describe("permission catalogue", () => {
  it("validates names and rejects duplicates", () => {
    expect(() => definePermissionCatalogue(["NotValid"])).toThrow(/invalid permission/);
    expect(() => definePermissionCatalogue(["a:b", "a:b"])).toThrow(/duplicate/);
    expect(isPermissionName("module.sub-resource:action")).toBe(true);
    expect(isPermissionName("resource")).toBe(false);
  });

  it("exposes frozen, typed permissions", () => {
    const catalogue = definePermissionCatalogue(["widgets:read"]);
    expect(catalogue.permissions["widgets:read"]).toBe("widgets:read");
    expect(catalogue.all).toEqual(["widgets:read"]);
    expect(catalogue.has("widgets:read")).toBe(true);
    expect(catalogue.has("widgets:write")).toBe(false);
    expect(Object.isFrozen(catalogue.permissions)).toBe(true);
  });

  it("evaluates a permission set", () => {
    const { permissions } = definePermissionCatalogue(["widgets:read", "widgets:write"]);
    const granted = permissionSet([permissions["widgets:read"]]);
    expect(hasPermission(granted, permissions["widgets:read"])).toBe(true);
    expect(() => {
      requirePermission(granted, permissions["widgets:write"]);
    }).toThrow(PermissionDeniedError);
  });
});
