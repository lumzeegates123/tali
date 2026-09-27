import { KernelError } from "./errors";

declare const uuidBrand: unique symbol;
declare const idBrand: unique symbol;

/** A canonical (lowercase, hyphenated) RFC 9562 UUID. */
export type Uuid = string & { readonly [uuidBrand]: true };

/**
 * A record identifier: a UUIDv7 branded with its entity name, so identifiers
 * of different entities cannot be mixed up at compile time. Timestamps embedded
 * in the UUID are never business time.
 */
export type Id<Entity extends string> = Uuid & { readonly [idBrand]: Entity };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Parses any RFC 9562 UUID (versions 1-8, RFC variant), normalizing to lowercase. */
export function parseUuid(value: string): Uuid {
  const canonical = value.toLowerCase();
  if (!UUID_PATTERN.test(canonical)) {
    throw new KernelError("INVALID_UUID", `"${value}" is not an RFC 9562 UUID`);
  }
  return canonical as Uuid;
}

export function uuidVersion(uuid: Uuid): number {
  return Number.parseInt(uuid.charAt(14), 16);
}

export function isUuidV7(value: string): boolean {
  const canonical = value.toLowerCase();
  return UUID_PATTERN.test(canonical) && canonical.charAt(14) === "7";
}

/** Parses a record identifier for the named entity; record identities are always UUIDv7. */
export function parseId<Entity extends string>(entity: Entity, value: string): Id<Entity> {
  if (!isUuidV7(value)) {
    throw new KernelError("INVALID_UUID", `"${value}" is not a valid ${entity} id (UUIDv7 required)`);
  }
  return value.toLowerCase() as Id<Entity>;
}
