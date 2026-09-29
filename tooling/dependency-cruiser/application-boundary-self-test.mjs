// @ts-check
/**
 * Permanent regression suite for the ADR-006 application boundary. It runs
 * the real .dependency-cruiser.cjs rules against a throwaway fixture
 * repository in which packages/application declares zod and another external
 * package, and checks each edge's verdict. It also checks the manifest
 * policy. Run by tooling/dependency-boundaries.mjs before the repository
 * cruise, so a rule change that weakens the boundary fails `pnpm boundaries`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { cruise } from "dependency-cruiser";
import { checkApplicationManifest } from "./application-policy.mjs";

const require = createRequire(import.meta.url);

/** The fixture manifest: what a later change adding external packages would look like. */
const FIXTURE_APPLICATION_MANIFEST = {
  name: "@tali/application",
  private: true,
  type: "module",
  dependencies: { "@tali/domain": "workspace:*", zod: "4.0.0", "some-runtime-lib": "1.0.0" },
  peerDependencies: { vitest: "5.0.2" },
  peerDependenciesMeta: { vitest: { optional: true } },
  devDependencies: { vitest: "5.0.2" },
};

/**
 * Fixture application files, each with the rule its single import must
 * violate, or null when the edge is allowed.
 * @type {readonly { file: string; source: string; expectedRule: string | null }[]}
 */
const CASES = [
  {
    file: "src/allowed-domain.ts",
    source: 'import { domain } from "@tali/domain";\nexport const value = domain;\n',
    expectedRule: null,
  },
  {
    file: "src/testing/contracts/allowed-contract-vitest.ts",
    source: 'import { it } from "vitest";\nexport const value = it;\n',
    expectedRule: null,
  },
  {
    file: "src/forbidden-zod.ts",
    source: 'import { z } from "zod";\nexport const value = z;\n',
    expectedRule: "application-no-external-runtime-dependencies",
  },
  {
    file: "src/forbidden-external.ts",
    source: 'import { lib } from "some-runtime-lib";\nexport const value = lib;\n',
    expectedRule: "application-no-external-runtime-dependencies",
  },
  {
    file: "src/testing/contracts/forbidden-contract-zod.ts",
    source: 'import { z } from "zod";\nexport const value = z;\n',
    expectedRule: "application-no-external-runtime-dependencies",
  },
  {
    file: "src/forbidden-vitest-in-production.ts",
    source: 'import { it } from "vitest";\nexport const value = it;\n',
    expectedRule: "application-framework-free",
  },
  {
    file: "src/forbidden-database.ts",
    source: 'import { database } from "@tali/database";\nexport const value = database;\n',
    expectedRule: "application-depends-only-on-domain",
  },
  {
    file: "src/forbidden-shared.ts",
    source: 'import { shared } from "@tali/shared";\nexport const value = shared;\n',
    expectedRule: "application-depends-only-on-domain",
  },
];

/**
 * @param {string} root
 * @param {string} relative
 * @param {string} contents
 */
function write(root, relative, contents) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

/** @param {string} root */
function buildFixture(root) {
  write(root, "package.json", JSON.stringify({ name: "boundary-fixture", private: true }));
  for (const name of ["domain", "database", "shared"]) {
    write(
      root,
      `packages/${name}/package.json`,
      JSON.stringify({ name: `@tali/${name}`, private: true, type: "module" }),
    );
    write(root, `packages/${name}/src/index.ts`, `export const ${name} = "${name}";\n`);
  }
  write(root, "packages/application/package.json", JSON.stringify(FIXTURE_APPLICATION_MANIFEST));
  for (const name of ["zod", "some-runtime-lib", "vitest"]) {
    const exported = { zod: "z", "some-runtime-lib": "lib", vitest: "it" }[name];
    // Entry points in dist/, as most published packages ship them, so an over-broad exclude would hide the edge.
    write(
      root,
      `packages/application/node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.0.0", main: "dist/index.js" }),
    );
    write(root, `packages/application/node_modules/${name}/dist/index.js`, `export const ${exported} = 1;\n`);
  }
  for (const { file, source } of CASES) write(root, `packages/application/${file}`, source);
}

/**
 * Runs the suite and returns its failures (empty when the boundary holds).
 * @returns {Promise<string[]>}
 */
export async function runApplicationBoundarySelfTest() {
  /** @type {string[]} */
  const failures = [];

  const manifestProblems = checkApplicationManifest(FIXTURE_APPLICATION_MANIFEST).join("\n");
  for (const name of ["zod", "some-runtime-lib"]) {
    if (!manifestProblems.includes(`"${name}"`)) failures.push(`manifest policy did not reject "${name}"`);
  }
  if (manifestProblems.includes('"@tali/domain"')) failures.push('manifest policy rejected "@tali/domain"');

  /** @type {import("dependency-cruiser").IConfiguration} */
  const config = require("../../.dependency-cruiser.cjs");
  const root = mkdtempSync(path.join(tmpdir(), "tali-boundary-"));
  try {
    buildFixture(root);
    const alias = Object.fromEntries(
      ["domain", "database", "shared"].map((name) => [
        `@tali/${name}$`,
        path.join(root, "packages", name, "src", "index.ts"),
      ]),
    );
    const options = config.options ?? {};
    const reporterOutput = await cruise(
      ["packages"],
      {
        baseDir: root,
        validate: true,
        ruleSet: { forbidden: config.forbidden ?? [] },
        tsPreCompilationDeps: options.tsPreCompilationDeps ?? true,
        doNotFollow: { path: ["node_modules"] },
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
        ...(options.enhancedResolveOptions === undefined
          ? {}
          : { enhancedResolveOptions: options.enhancedResolveOptions }),
      },
      { alias },
    );
    const result = reporterOutput.output;
    if (typeof result === "string") throw new Error("dependency-cruiser returned a formatted report");

    for (const { file, expectedRule } of CASES) {
      const from = `packages/application/${file}`;
      const module = result.modules.find((candidate) => candidate.source === from);
      const dependency = module?.dependencies[0];
      if (dependency === undefined || !dependency.resolved || dependency.couldNotResolve) {
        failures.push(`${from}: fixture import did not resolve, so the check would be vacuous`);
        continue;
      }
      const rules = result.summary.violations
        .filter((violation) => violation.from === from)
        .map((violation) => violation.rule.name);
      if (expectedRule === null && rules.length > 0) {
        failures.push(`${from}: allowed edge was rejected by ${rules.join(", ")}`);
      }
      if (expectedRule !== null && !rules.includes(expectedRule)) {
        failures.push(`${from}: expected ${expectedRule}, got ${rules.length > 0 ? rules.join(", ") : "no violation"}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return failures;
}
