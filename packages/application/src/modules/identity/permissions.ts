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

const p = identityPermissions.permissions;
const everyRole = [p["business:read"], p["location:read"], p["device:register"]];

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
  ]),
  MANAGER: Object.freeze([...everyRole, p["member:read"], p["device:read"]]),
  CASHIER: Object.freeze([...everyRole]),
  STOCK_KEEPER: Object.freeze([...everyRole]),
  ACCOUNTANT: Object.freeze([...everyRole]),
});

/** Expands a membership's role into its PermissionSet during context resolution. */
export function permissionsForRole(role: MembershipRole): PermissionSet {
  return permissionSet(rolePermissions[role]);
}
