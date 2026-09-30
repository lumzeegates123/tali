// @ts-check
import { CLIENT_FORBIDDEN_ENV_NAMES } from "@tali/config/public-build";

/** Prefix of the canary values injected into every server variable of the check build. */
export const CANARY_PREFIX = "tali-bundle-canary-";

/**
 * Synthetic local and CI database passwords (docker-compose.yml, .env.example,
 * the CI database job). They grant access to nothing, but finding one in a
 * client bundle means server configuration leaked into it.
 */
export const PLACEHOLDER_SECRETS = ["local-only-owner", "local-only-app", "local-only-admin"];

/**
 * Prefixes of the one-time secrets (invitation tokens, device credentials).
 * Only the API generates and parses them; clients treat the values as opaque,
 * so a prefix in a client bundle means a secret or server code leaked into it.
 */
export const ONE_TIME_SECRET_PREFIXES = ["tali_inv_", "tali_dev_"];

/**
 * @param {string} name
 * @returns {string}
 */
export function canaryValue(name) {
  return `${CANARY_PREFIX}${name.toLowerCase().replaceAll("_", "-")}`;
}

/**
 * Server variables set to canary values for the check build. The build
 * environment then holds every server variable, so any path that copies a
 * server value into a bundle is caught by value, not only by name.
 * @returns {Record<string, string>}
 */
export function canaryEnvironment() {
  return Object.fromEntries(CLIENT_FORBIDDEN_ENV_NAMES.map((name) => [name, canaryValue(name)]));
}

/** @returns {import("./scan.mjs").Needle[]} */
export function forbiddenNeedles() {
  return [
    ...CLIENT_FORBIDDEN_ENV_NAMES.map((name) => ({ label: `server variable name ${name}`, value: name })),
    ...PLACEHOLDER_SECRETS.map((value) => ({ label: `placeholder secret ${value}`, value })),
    ...ONE_TIME_SECRET_PREFIXES.map((value) => ({ label: `one-time secret prefix ${value}`, value })),
    { label: "canary value", value: CANARY_PREFIX },
  ];
}
