import { MEMBERSHIP_ROLES } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { hasPermission } from "../../authorization/permissions.js";
import { identityPermissions, permissionsForRole, rolePermissions } from "./permissions.js";

const EVERY_ROLE = ["business:read", "location:read", "device:register"];

describe("Build 1 permission catalogue (ADR-005 section 8)", () => {
  it("declares exactly the Build 1 permissions", () => {
    expect([...identityPermissions.all].sort()).toEqual(
      [
        "business:read",
        "business:update",
        "device:read",
        "device:register",
        "device:revoke",
        "location:read",
        "member:invite",
        "member:manage",
        "member:read",
      ].sort(),
    );
  });

  it.each([
    [
      "OWNER",
      [
        ...EVERY_ROLE,
        "business:update",
        "member:read",
        "member:invite",
        "member:manage",
        "device:read",
        "device:revoke",
      ],
    ],
    ["MANAGER", [...EVERY_ROLE, "member:read", "device:read"]],
    ["CASHIER", EVERY_ROLE],
    ["STOCK_KEEPER", EVERY_ROLE],
    ["ACCOUNTANT", EVERY_ROLE],
  ] as const)("maps %s to exactly its permissions", (role, expected) => {
    expect(rolePermissions[role].map(String).sort()).toEqual([...expected].sort());
  });

  it("covers every membership role", () => {
    expect(Object.keys(rolePermissions).sort()).toEqual([...MEMBERSHIP_ROLES].sort());
  });

  it("expands a role into a PermissionSet", () => {
    const manager = permissionsForRole("MANAGER");
    expect(hasPermission(manager, identityPermissions.permissions["member:read"])).toBe(true);
    expect(hasPermission(manager, identityPermissions.permissions["member:manage"])).toBe(false);
    expect(hasPermission(permissionsForRole("CASHIER"), identityPermissions.permissions["member:read"])).toBe(false);
  });
});
