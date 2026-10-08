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

/** The Build 2 catalog permissions (ADR-008 section 15). */
export const catalogPermissions = definePermissionCatalogue(["product:read", "product:manage", "product:price"]);

/**
 * The Build 2 inventory permissions (ADR-008 section 15). The stocktake
 * permissions (`inventory:count`, `inventory:count-post`) are granted now and
 * gain their use cases in Build 2 Slice 6; a permission with no use case grants
 * nothing.
 */
export const inventoryPermissions = definePermissionCatalogue([
  "inventory:read",
  "inventory:threshold",
  "inventory:opening",
  "inventory:receive",
  "inventory:adjust",
  "inventory:count",
  "inventory:count-post",
]);

const p = identityPermissions.permissions;
const c = catalogPermissions.permissions;
const i = inventoryPermissions.permissions;
const everyRole = [
  p["business:read"],
  p["location:read"],
  p["device:register"],
  c["product:read"],
  i["inventory:read"],
];
const allInventoryChanges = [
  i["inventory:threshold"],
  i["inventory:opening"],
  i["inventory:receive"],
  i["inventory:adjust"],
  i["inventory:count"],
  i["inventory:count-post"],
];

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
    ...allInventoryChanges,
  ]),
  MANAGER: Object.freeze([
    ...everyRole,
    p["member:read"],
    p["device:read"],
    c["product:manage"],
    c["product:price"],
    ...allInventoryChanges,
  ]),
  CASHIER: Object.freeze([...everyRole]),
  STOCK_KEEPER: Object.freeze([
    ...everyRole,
    c["product:manage"],
    i["inventory:threshold"],
    i["inventory:receive"],
    i["inventory:count"],
  ]),
  ACCOUNTANT: Object.freeze([...everyRole]),
});

/** Expands a membership's role into its PermissionSet during context resolution. */
export function permissionsForRole(role: MembershipRole): PermissionSet {
  return permissionSet(rolePermissions[role]);
}
