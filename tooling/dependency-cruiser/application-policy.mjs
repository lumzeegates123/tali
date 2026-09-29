// @ts-check
/**
 * ADR-006 manifest policy for packages/application. dependency-cruiser checks
 * imports only; this checks what the package declares, so an external
 * runtime dependency fails even before anything imports it.
 */

export const APPLICATION_MANIFEST = "packages/application/package.json";

/** Approved internal workspace packages (ADR-002 section 6, ADR-006). */
export const APPROVED_APPLICATION_DEPENDENCIES = Object.freeze(["@tali/domain"]);

/** The test runner the exported port contract suites import. Optional, so production consumers never install it. */
export const APPROVED_APPLICATION_OPTIONAL_PEERS = Object.freeze(["vitest"]);

/**
 * Returns the policy violations of an application package.json, or an empty
 * list. devDependencies are governed by the repository's normal conventions.
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function checkApplicationManifest(manifest) {
  /** @type {string[]} */
  const problems = [];
  const dependencies = record(manifest["dependencies"]);
  for (const [name, version] of Object.entries(dependencies)) {
    if (!APPROVED_APPLICATION_DEPENDENCIES.includes(name)) {
      problems.push(`dependencies: "${name}" is not an approved workspace package (ADR-006)`);
    } else if (typeof version !== "string" || !version.startsWith("workspace:")) {
      problems.push(`dependencies: "${name}" must use the workspace: protocol`);
    }
  }
  for (const field of ["optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
    const value = manifest[field];
    const empty =
      value === undefined || (Array.isArray(value) ? value.length === 0 : Object.keys(record(value)).length === 0);
    if (!empty) problems.push(`${field}: packages/application declares no ${field} (ADR-006)`);
  }
  const peerMeta = record(manifest["peerDependenciesMeta"]);
  for (const name of Object.keys(record(manifest["peerDependencies"]))) {
    if (!APPROVED_APPLICATION_OPTIONAL_PEERS.includes(name)) {
      problems.push(`peerDependencies: "${name}" is not an approved optional peer (ADR-006)`);
    } else if (record(peerMeta[name])["optional"] !== true) {
      problems.push(`peerDependencies: "${name}" must be marked optional in peerDependenciesMeta`);
    }
  }
  return problems;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
