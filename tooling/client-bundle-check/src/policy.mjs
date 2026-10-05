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
 * Third-party identifiers that contain a server variable name but are not
 * Tali configuration. Each is masked before scanning, and only in exactly this
 * form: a quoted name, an object key or `process.env.<NAME>` is still found,
 * and canary values are never masked.
 * - aws-amplify's ConsoleLogger reads its own `ConsoleLogger.LOG_LEVEL`,
 *   `window.LOG_LEVEL` and `BIND_ALL_LOG_LEVELS` static properties (web
 *   Cognito client, Build 1 Slice 6).
 * - aws-amplify's CommonJS build, which React Native bundles, exports
 *   `COGNITO_IDENTITY_SERVICE_NAME` and `COGNITO_IDP_SERVICE_NAME` (mobile
 *   Cognito client, Build 1 Slice 6).
 * Masks apply to JavaScript text only. Hermes bytecode shares bytes between
 * strings, so a mask there could hide a Tali name: bytecode is scanned for
 * values only (`forbiddenValueNeedles`).
 * @type {readonly { readonly reason: string; readonly pattern: RegExp }[]}
 */
export const THIRD_PARTY_IDENTIFIERS = [
  { reason: "aws-amplify ConsoleLogger.LOG_LEVEL property", pattern: /(?<!(?:^|[^\w$])env)\.LOG_LEVEL(?![\w$])/gu },
  { reason: "aws-amplify ConsoleLogger.BIND_ALL_LOG_LEVELS property", pattern: /\.BIND_ALL_LOG_LEVELS(?![\w$])/gu },
  {
    reason: "aws-amplify COGNITO_IDENTITY_SERVICE_NAME and COGNITO_IDP_SERVICE_NAME exports",
    pattern: /\.COGNITO_(?:IDENTITY|IDP)_SERVICE_NAME(?![\w$])/gu,
  },
];

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

/** Secret values: placeholder secrets, one-time secret prefixes and canaries. @returns {import("./scan.mjs").Needle[]} */
export function forbiddenValueNeedles() {
  return [
    ...PLACEHOLDER_SECRETS.map((value) => ({ label: `placeholder secret ${value}`, value })),
    ...ONE_TIME_SECRET_PREFIXES.map((value) => ({ label: `one-time secret prefix ${value}`, value })),
    { label: "canary value", value: CANARY_PREFIX },
  ];
}

/** @returns {import("./scan.mjs").Needle[]} */
export function forbiddenNeedles() {
  return [
    ...CLIENT_FORBIDDEN_ENV_NAMES.map((name) => ({ label: `server variable name ${name}`, value: name })),
    ...forbiddenValueNeedles(),
  ];
}
