// @ts-check
/**
 * Permanent regression suite for the ADR-006 application boundary and the
 * ADR-008 AI boundary. It runs the real .dependency-cruiser.cjs rules against
 * a throwaway fixture repository in which packages/application declares zod
 * and another external package, re-exports catalog and inventory modules from
 * its root index as the real package does, and AI source exists both as
 * packages/ai and as an application module. It checks each edge's verdict and
 * the manifest policy. Run by tooling/dependency-boundaries.mjs before the
 * repository cruise, so a rule change that weakens either boundary fails
 * `pnpm boundaries`.
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

const AI_RULE = "ai-no-catalog-inventory";

/**
 * Fixture source files (repository-relative), each with the rule its single
 * import must violate, or null when the edge is allowed.
 * @type {readonly { file: string; source: string; expectedRule: string | null }[]}
 */
const CASES = [
  {
    file: "packages/application/src/allowed-domain.ts",
    source: 'import { domain } from "@tali/domain";\nexport const value = domain;\n',
    expectedRule: null,
  },
  {
    file: "packages/application/src/testing/contracts/allowed-contract-vitest.ts",
    source: 'import { it } from "vitest";\nexport const value = it;\n',
    expectedRule: null,
  },
  {
    file: "packages/application/src/forbidden-zod.ts",
    source: 'import { z } from "zod";\nexport const value = z;\n',
    expectedRule: "application-no-external-runtime-dependencies",
  },
  {
    file: "packages/application/src/forbidden-external.ts",
    source: 'import { lib } from "some-runtime-lib";\nexport const value = lib;\n',
    expectedRule: "application-no-external-runtime-dependencies",
  },
  {
    file: "packages/application/src/testing/contracts/forbidden-contract-zod.ts",
    source: 'import { z } from "zod";\nexport const value = z;\n',
    expectedRule: "application-no-external-runtime-dependencies",
  },
  {
    file: "packages/application/src/forbidden-vitest-in-production.ts",
    source: 'import { it } from "vitest";\nexport const value = it;\n',
    expectedRule: "application-framework-free",
  },
  {
    file: "packages/application/src/forbidden-database.ts",
    source: 'import { database } from "@tali/database";\nexport const value = database;\n',
    expectedRule: "application-depends-only-on-domain",
  },
  {
    file: "packages/application/src/forbidden-shared.ts",
    source: 'import { shared } from "@tali/shared";\nexport const value = shared;\n',
    expectedRule: "application-depends-only-on-domain",
  },

  // ---- AI as a package (packages/ai) ------------------------------------
  {
    file: "packages/ai/src/forbidden-database-package.ts",
    source: 'import { database } from "@tali/database";\nexport const value = database;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/forbidden-database-source.ts",
    source:
      'import { productRepository } from "../../database/src/repositories/product-repository.js";\nexport const value = productRepository;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/forbidden-application-root.ts",
    source:
      'import { createPostGoodsReceipt } from "@tali/application";\nexport const value = createPostGoodsReceipt;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/forbidden-catalog-use-case.ts",
    source:
      'import { createUpdateProduct } from "../../application/src/modules/catalog/products.js";\nexport const value = createUpdateProduct;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/forbidden-inventory-module.ts",
    source:
      'import { createPostGoodsReceipt } from "../../application/src/modules/inventory/index.js";\nexport const value = createPostGoodsReceipt;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/forbidden-inventory-port.ts",
    source:
      'import type { InventoryMovementRepository } from "../../application/src/modules/inventory/ports.js";\nexport type Value = InventoryMovementRepository;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/forbidden-catalog-port.ts",
    source:
      'import type { ProductRepository } from "../../application/src/modules/catalog/ports.js";\nexport type Value = ProductRepository;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/ai/src/allowed-domain.ts",
    source: 'import { domain } from "@tali/domain";\nexport const value = domain;\n',
    expectedRule: null,
  },
  {
    file: "packages/ai/src/allowed-shared.ts",
    source: 'import { shared } from "@tali/shared";\nexport const value = shared;\n',
    expectedRule: null,
  },
  {
    file: "packages/ai/src/proposal.test.ts",
    source:
      'import { createUpdateProduct } from "../../application/src/modules/catalog/products.js";\nexport const value = createUpdateProduct;\n',
    expectedRule: null,
  },

  // ---- AI as an application module --------------------------------------
  {
    file: "packages/application/src/modules/ai/forbidden-database.ts",
    source: 'import { database } from "@tali/database";\nexport const value = database;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/application/src/modules/ai/forbidden-application-root.ts",
    source: 'import { createUpdateProduct } from "../../index.js";\nexport const value = createUpdateProduct;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/application/src/modules/ai/forbidden-catalog-module.ts",
    source: 'import { createUpdateProduct } from "../catalog/index.js";\nexport const value = createUpdateProduct;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/application/src/modules/ai/forbidden-inventory-module.ts",
    source:
      'import { createPostGoodsReceipt } from "../inventory/index.js";\nexport const value = createPostGoodsReceipt;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/application/src/modules/ai/forbidden-inventory-port.ts",
    source:
      'import type { StockBalanceRepository } from "../inventory/ports.js";\nexport type Value = StockBalanceRepository;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/application/src/modules/ai/forbidden-catalog-port.ts",
    source:
      'import type { ProductPackRepository } from "../catalog/ports.js";\nexport type Value = ProductPackRepository;\n',
    expectedRule: AI_RULE,
  },
  {
    file: "packages/application/src/modules/ai/allowed-domain.ts",
    source: 'import { domain } from "@tali/domain";\nexport const value = domain;\n',
    expectedRule: null,
  },
  {
    file: "packages/application/src/modules/ai/allowed-other-module.ts",
    source: 'import { business } from "../business/index.js";\nexport const value = business;\n',
    expectedRule: null,
  },
];

/**
 * Fixture catalog, inventory and business modules shaped like the real ones,
 * re-exported from the application root index, plus one database source file.
 * @type {Readonly<Record<string, string>>}
 */
const FIXTURE_SOURCES = {
  "packages/application/src/index.ts":
    'export * from "./modules/business/index.js";\nexport * from "./modules/catalog/index.js";\nexport * from "./modules/inventory/index.js";\n',
  "packages/application/src/modules/business/index.ts": 'export const business = "business";\n',
  "packages/application/src/modules/catalog/index.ts":
    'export type { ProductPackRepository, ProductRepository } from "./ports.js";\nexport * from "./products.js";\n',
  "packages/application/src/modules/catalog/ports.ts":
    'export interface ProductRepository {\n  readonly kind: "product";\n}\nexport interface ProductPackRepository {\n  readonly kind: "pack";\n}\n',
  "packages/application/src/modules/catalog/products.ts": 'export const createUpdateProduct = "update-product";\n',
  "packages/application/src/modules/inventory/index.ts":
    'export type { InventoryMovementRepository, StockBalanceRepository } from "./ports.js";\nexport * from "./goods-receipts.js";\n',
  "packages/application/src/modules/inventory/ports.ts":
    'export interface InventoryMovementRepository {\n  readonly kind: "movement";\n}\nexport interface StockBalanceRepository {\n  readonly kind: "balance";\n}\n',
  "packages/application/src/modules/inventory/goods-receipts.ts":
    'export const createPostGoodsReceipt = "post-goods-receipt";\n',
  "packages/database/src/repositories/product-repository.ts": 'export const productRepository = "products";\n',
};

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
  write(root, "packages/ai/package.json", JSON.stringify({ name: "@tali/ai", private: true, type: "module" }));
  for (const [file, source] of Object.entries(FIXTURE_SOURCES)) write(root, file, source);
  for (const { file, source } of CASES) write(root, file, source);
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
      ["domain", "database", "shared", "application"].map((name) => [
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

    for (const { file: from, expectedRule } of CASES) {
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
