#!/usr/bin/env node
// @ts-check
/**
 * Runs dependency-cruiser over every workspace source root that exists, so
 * apps/ and infrastructure/ are covered automatically as soon as they are
 * created. Rules live in .dependency-cruiser.cjs. Before the cruise it
 * checks the packages/application manifest (ADR-006) and runs the
 * application boundary regression suite against the same rules.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runApplicationBoundarySelfTest } from "./dependency-cruiser/application-boundary-self-test.mjs";
import { APPLICATION_MANIFEST, checkApplicationManifest } from "./dependency-cruiser/application-policy.mjs";

const SOURCE_ROOTS = ["packages", "apps", "tooling", "infrastructure"];

/** @type {Record<string, unknown>} */
const manifest = JSON.parse(readFileSync(APPLICATION_MANIFEST, "utf8"));
const policyFailures = [
  ...checkApplicationManifest(manifest).map((problem) => `${APPLICATION_MANIFEST}: ${problem}`),
  ...(await runApplicationBoundarySelfTest()).map((failure) => `boundary self-test: ${failure}`),
];
if (policyFailures.length > 0) {
  for (const failure of policyFailures) console.error(`  error ${failure}`);
  console.error(`x ${policyFailures.length} application boundary violation(s) (ADR-006).`);
  process.exit(1);
}
console.log("✔ application manifest and boundary self-test pass (ADR-006)");

const cli = fileURLToPath(new URL("../node_modules/dependency-cruiser/bin/dependency-cruiser.mjs", import.meta.url));
const roots = SOURCE_ROOTS.filter((root) => existsSync(root));
const result = spawnSync(
  process.execPath,
  [cli, "--config", ".dependency-cruiser.cjs", ...roots, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
