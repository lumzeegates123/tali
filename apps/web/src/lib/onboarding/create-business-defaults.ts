/**
 * Currencies offered when creating a business. The API has no currency-list
 * endpoint in Build 1, and the approved private-pilot decision
 * (docs/product/mvp-scope.md, "Initial market and currency") is NGN, which may
 * appear as a default for the pilot market. The server still validates the
 * currency against its reference data. Replace this with the server's list
 * once an endpoint exists.
 */
export const PILOT_CURRENCY_CODES = ["NGN"] as const;

export type PilotCurrencyCode = (typeof PILOT_CURRENCY_CODES)[number];

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;
const OFFSET_LIKE = /^(UTC|GMT|Etc\/GMT)?[+-]/iu;

/**
 * The device's IANA time-zone name, offered only as an initial value. Raw
 * offsets are never offered or converted; the server validates and
 * canonicalizes whatever is submitted.
 */
export function detectDeviceTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return ZONE_NAME.test(zone) && !OFFSET_LIKE.test(zone) ? zone : "";
  } catch {
    return "";
  }
}
