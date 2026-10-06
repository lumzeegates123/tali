import { MEMBERSHIP_ROLES } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { hasPermission } from "../../authorization/permissions.js";
import { catalogPermissions, identityPermissions, permissionsForRole, rolePermissions } from "./permissions.js";

const BUILD_1_EVERY_ROLE = ["business:read", "location:read", "device:register"];

const BUILD_1_ROLE_PERMISSIONS = {
  OWNER: [
    ...BUILD_1_EVERY_ROLE,
    "business:update",
    "member:read",
    "member:invite",
    "member:manage",
    "device:read",
    "device:revoke",
  ],
  MANAGER: [...BUILD_1_EVERY_ROLE, "member:read", "device:read"],
  CASHIER: BUILD_1_EVERY_ROLE,
  STOCK_KEEPER: BUILD_1_EVERY_ROLE,
  ACCOUNTANT: BUILD_1_EVERY_ROLE,
} as const;

/** ADR-008 section 15, catalog rows only. */
const CATALOG_ROLE_PERMISSIONS = {
  OWNER: ["product:read", "product:manage", "product:price"],
  MANAGER: ["product:read", "product:manage", "product:price"],
  CASHIER: ["product:read"],
  STOCK_KEEPER: ["product:read", "product:manage"],
  ACCOUNTANT: ["product:read"],
} as const;

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

  it.each(MEMBERSHIP_ROLES)("keeps %s's Build 1 permissions unchanged", (role) => {
    const build1 = rolePermissions[role].map(String).filter((name) => identityPermissions.has(name));
    expect(build1.sort()).toEqual([...BUILD_1_ROLE_PERMISSIONS[role]].sort());
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

describe("Build 2 catalog permissions (ADR-008 section 15)", () => {
  it("declares exactly the three product permissions and no inventory permission", () => {
    expect([...catalogPermissions.all].sort()).toEqual(["product:manage", "product:price", "product:read"]);
    for (const role of MEMBERSHIP_ROLES) {
      expect(rolePermissions[role].some((permission) => permission.startsWith("inventory:"))).toBe(false);
    }
  });

  it.each(MEMBERSHIP_ROLES)("maps %s to exactly its catalog permissions", (role) => {
    const catalog = rolePermissions[role].map(String).filter((name) => catalogPermissions.has(name));
    expect(catalog.sort()).toEqual([...CATALOG_ROLE_PERMISSIONS[role]].sort());
  });

  it.each(MEMBERSHIP_ROLES)("maps %s to exactly Build 1 plus catalog permissions, nothing else", (role) => {
    expect(rolePermissions[role].map(String).sort()).toEqual(
      [...BUILD_1_ROLE_PERMISSIONS[role], ...CATALOG_ROLE_PERMISSIONS[role]].sort(),
    );
  });

  it("grants product:price only to OWNER and MANAGER", () => {
    const price = catalogPermissions.permissions["product:price"];
    expect(MEMBERSHIP_ROLES.filter((role) => hasPermission(permissionsForRole(role), price)).sort()).toEqual([
      "MANAGER",
      "OWNER",
    ]);
  });
});
