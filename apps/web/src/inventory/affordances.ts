/**
 * Which inventory actions the UI offers. UX only: the API checks the
 * `inventory:*` permission on every request and a PERMISSION_DENIED answer is
 * still shown. No contract exposes the caller's permissions, so this is the
 * one client copy of the ADR-008 section 15 role mapping, kept in permission
 * names; nothing else in the client reasons about roles.
 */
export type InventoryPermission =
  | "inventory:read"
  | "inventory:threshold"
  | "inventory:opening"
  | "inventory:receive"
  | "inventory:adjust"
  | "inventory:count"
  | "inventory:count-post";

const EVERY_INVENTORY_PERMISSION: readonly InventoryPermission[] = [
  "inventory:read",
  "inventory:threshold",
  "inventory:opening",
  "inventory:receive",
  "inventory:adjust",
  "inventory:count",
  "inventory:count-post",
];

const PERMISSIONS_BY_ROLE: Readonly<Record<string, readonly InventoryPermission[]>> = {
  OWNER: EVERY_INVENTORY_PERMISSION,
  MANAGER: EVERY_INVENTORY_PERMISSION,
  STOCK_KEEPER: ["inventory:read", "inventory:threshold", "inventory:receive", "inventory:count"],
  CASHIER: ["inventory:read"],
  ACCOUNTANT: ["inventory:read"],
};

export interface InventoryAffordances {
  readonly can: (permission: InventoryPermission) => boolean;
}

/** An unknown or missing role offers nothing beyond reading; the API decides what reading returns. */
export function inventoryAffordances(role: string | undefined): InventoryAffordances {
  const granted = new Set<InventoryPermission>(
    (role === undefined ? undefined : PERMISSIONS_BY_ROLE[role]) ?? ["inventory:read"],
  );
  return Object.freeze({ can: (permission: InventoryPermission) => granted.has(permission) });
}
