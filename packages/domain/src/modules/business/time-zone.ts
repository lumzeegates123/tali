import { DomainError } from "../../errors.js";
import type { TimeZoneId } from "../../kernel/index.js";
import { CANONICAL_TIME_ZONES, TIME_ZONE_ALIASES, TIME_ZONE_REFERENCE_VERSION } from "./time-zone-reference.js";

declare const businessTimeZoneBrand: unique symbol;

/**
 * A canonical primary IANA zone identifier from Tali's versioned reference
 * dataset (plan 003 section 13.4), never the runtime's Intl spelling. It is
 * usable wherever the kernel TimeZoneId is expected.
 */
export type BusinessTimeZoneId = TimeZoneId & { readonly [businessTimeZoneBrand]: true };

export { TIME_ZONE_REFERENCE_VERSION };

const MAX_INPUT_LENGTH = 64;

const canonicalZones: ReadonlySet<string> = new Set(CANONICAL_TIME_ZONES);

const byFoldedName: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const zone of CANONICAL_TIME_ZONES) map.set(zone.toLowerCase(), zone);
  for (const [alias, canonical] of TIME_ZONE_ALIASES) map.set(alias.toLowerCase(), canonical);
  return map;
})();

/**
 * Resolves client text to a canonical BusinessTimeZoneId: a canonical zone
 * or a recognized alias, matched case-insensitively (`africa/lagos` gives
 * `Africa/Lagos`, `UTC` gives `Etc/UTC`). Raw UTC offsets and values that
 * are not zones in the dataset are rejected.
 */
export function parseBusinessTimeZoneId(value: string): BusinessTimeZoneId {
  const canonical = value.length <= MAX_INPUT_LENGTH ? byFoldedName.get(value.toLowerCase()) : undefined;
  if (canonical === undefined) {
    throw new DomainError("INVALID_VALUE", "timeZone must be an IANA time zone name", "timeZone");
  }
  return canonical as BusinessTimeZoneId;
}

/** True only for an identifier already in canonical form (for values restored from storage). */
export function isCanonicalBusinessTimeZone(value: string): value is BusinessTimeZoneId {
  return canonicalZones.has(value);
}
