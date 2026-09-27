#!/usr/bin/env node
// @ts-check
/**
 * Runs dependency-cruiser over every workspace source root that exists, so
 * apps/ and infrastructure/ are covered automatically as soon as they are
 * created. Rules live in .dependency-cruiser.cjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

const SOURCE_ROOTS = ["packages", "apps", "tooling", "infrastructure"];

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
