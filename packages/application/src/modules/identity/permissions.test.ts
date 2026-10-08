import { MEMBERSHIP_ROLES } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { hasPermission } from "../../authorization/permissions.js";
import {
  catalogPermissions,
  identityPermissions,
  inventoryPermissions,
  permissionsForRole,
  rolePermissions,
} from "./permissions.js";

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

const ALL_INVENTORY = [
  "inventory:read",
  "inventory:threshold",
  "inventory:opening",
  "inventory:receive",
  "inventory:adjust",
  "inventory:count",
  "inventory:count-post",
] as const;

/** ADR-008 section 15, inventory rows only. */
const INVENTORY_ROLE_PERMISSIONS = {
  OWNER: ALL_INVENTORY,
  MANAGER: ALL_INVENTORY,
  CASHIER: ["inventory:read"],
  STOCK_KEEPER: ["inventory:read", "inventory:threshold", "inventory:receive", "inventory:count"],
  ACCOUNTANT: ["inventory:read"],
} as const;

/** The whole ADR-008 section 15 table: ten permissions by five roles. */
const BUILD_2_MATRIX: Readonly<Record<string, readonly string[]>> = {
  "product:read": ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"],
  "product:manage": ["OWNER", "MANAGER", "STOCK_KEEPER"],
  "product:price": ["OWNER", "MANAGER"],
  "inventory:read": ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"],
  "inventory:threshold": ["OWNER", "MANAGER", "STOCK_KEEPER"],
  "inventory:opening": ["OWNER", "MANAGER"],
  "inventory:receive": ["OWNER", "MANAGER", "STOCK_KEEPER"],
  "inventory:adjust": ["OWNER", "MANAGER"],
  "inventory:count": ["OWNER", "MANAGER", "STOCK_KEEPER"],
  "inventory:count-post": ["OWNER", "MANAGER"],
};

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

describe("Build 2 catalog and inventory permissions (ADR-008 section 15)", () => {
  it("declares exactly the three product permissions and the seven inventory permissions", () => {
    expect([...catalogPermissions.all].sort()).toEqual(["product:manage", "product:price", "product:read"]);
    expect([...inventoryPermissions.all].sort()).toEqual([...ALL_INVENTORY].sort());
  });

  it("grants exactly the ADR-008 section 15 matrix of ten permissions by five roles", () => {
    expect(Object.keys(BUILD_2_MATRIX).sort()).toEqual(
      [...catalogPermissions.all, ...inventoryPermissions.all].map(String).sort(),
    );
    for (const [name, roles] of Object.entries(BUILD_2_MATRIX)) {
      const granted = MEMBERSHIP_ROLES.filter((role) => rolePermissions[role].map(String).includes(name));
      expect(granted.sort(), name).toEqual([...roles].sort());
    }
  });

  it.each(MEMBERSHIP_ROLES)("maps %s to exactly its catalog permissions", (role) => {
    const catalog = rolePermissions[role].map(String).filter((name) => catalogPermissions.has(name));
    expect(catalog.sort()).toEqual([...CATALOG_ROLE_PERMISSIONS[role]].sort());
  });

  it.each(MEMBERSHIP_ROLES)("maps %s to exactly its inventory permissions", (role) => {
    const inventory = rolePermissions[role].map(String).filter((name) => inventoryPermissions.has(name));
    expect(inventory.sort()).toEqual([...INVENTORY_ROLE_PERMISSIONS[role]].sort());
  });

  it.each(MEMBERSHIP_ROLES)("maps %s to exactly Build 1, catalog and inventory permissions, nothing else", (role) => {
    expect(rolePermissions[role].map(String).sort()).toEqual(
      [
        ...BUILD_1_ROLE_PERMISSIONS[role],
        ...CATALOG_ROLE_PERMISSIONS[role],
        ...INVENTORY_ROLE_PERMISSIONS[role],
      ].sort(),
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
