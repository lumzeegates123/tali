import { PermissionDeniedError } from "../errors/application-error.js";

declare const permissionBrand: unique symbol;

/**
 * A permission name such as "resource:action". Skeletal by design
 * (ADR-002 section 7): feature permissions are defined together with the use
 * cases that need them, never in advance.
 */
export type Permission = string & { readonly [permissionBrand]: true };

const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*:[a-z][a-z0-9-]*$/;

export function isPermissionName(value: string): value is Permission {
  return PERMISSION_PATTERN.test(value);
}

/**
 * A catalogue of known permissions. Each module defines its own catalogue;
 * definitions are validated and duplicates rejected.
 */
export interface PermissionCatalogue<Name extends string> {
  readonly permissions: Readonly<Record<Name, Permission>>;
  readonly all: readonly Permission[];
  has(value: string): value is Permission;
}

export function definePermissionCatalogue<const Name extends string>(
  names: readonly Name[],
): PermissionCatalogue<Name> {
  const seen = new Set<string>();
  for (const name of names) {
    if (!isPermissionName(name)) {
      throw new Error(`invalid permission name "${name}" (expected "resource:action")`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate permission "${name}"`);
    }
    seen.add(name);
  }
  const permissions = Object.freeze(
    Object.fromEntries(names.map((name) => [name, name as string as Permission])),
  ) as Readonly<Record<Name, Permission>>;
  const all = Object.freeze([...seen]) as readonly Permission[];
  return Object.freeze({
    permissions,
    all,
    has: (value: string): value is Permission => seen.has(value),
  });
}

/** The permissions granted to an actor within one business, resolved server-side. */
export type PermissionSet = ReadonlySet<Permission>;

export function permissionSet(permissions: Iterable<Permission>): PermissionSet {
  return new Set(permissions);
}

export function hasPermission(granted: PermissionSet, required: Permission): boolean {
  return granted.has(required);
}

export function requirePermission(granted: PermissionSet, required: Permission): void {
  if (!hasPermission(granted, required)) {
    throw new PermissionDeniedError();
  }
}
