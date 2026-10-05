import type { MembershipRole } from "@tali/domain";
import type { Permission, PermissionSet } from "../../authorization/permissions.js";
import { definePermissionCatalogue, permissionSet } from "../../authorization/permissions.js";

/**
 * The Build 1 permission catalogue (ADR-005 section 8). Permissions for sales,
 * inventory, payments, accounting, purchasing and AI arrive with their use
 * cases.
 */
export const identityPermissions = definePermissionCatalogue([
  "business:read",
  "location:read",
  "device:register",
  "business:update",
  "member:read",
  "member:invite",
  "member:manage",
  "device:read",
  "device:revoke",
]);

/**
 * The Build 2 catalog permissions (ADR-008 section 15). The inventory
 * permissions of that section arrive with the inventory use cases.
 */
export const catalogPermissions = definePermissionCatalogue(["product:read", "product:manage", "product:price"]);

const p = identityPermissions.permissions;
const c = catalogPermissions.permissions;
const everyRole = [p["business:read"], p["location:read"], p["device:register"], c["product:read"]];

/** The static, code-versioned role mapping (ADR-005 section 8). Permissions are never stored per membership. */
export const rolePermissions: Readonly<Record<MembershipRole, readonly Permission[]>> = Object.freeze({
  OWNER: Object.freeze([
    ...everyRole,
    p["business:update"],
    p["member:read"],
    p["member:invite"],
    p["member:manage"],
    p["device:read"],
    p["device:revoke"],
    c["product:manage"],
    c["product:price"],
  ]),
  MANAGER: Object.freeze([...everyRole, p["member:read"], p["device:read"], c["product:manage"], c["product:price"]]),
  CASHIER: Object.freeze([...everyRole]),
  STOCK_KEEPER: Object.freeze([...everyRole, c["product:manage"]]),
  ACCOUNTANT: Object.freeze([...everyRole]),
});

/** Expands a membership's role into its PermissionSet during context resolution. */
export function permissionsForRole(role: MembershipRole): PermissionSet {
  return permissionSet(rolePermissions[role]);
}
