#!/usr/bin/env node
// @ts-check
/**
 * Usage:
 *   node tooling/text-integrity/src/cli.mjs            # all tracked and untracked, non-ignored files
 *   node tooling/text-integrity/src/cli.mjs <paths...> # specific repository-relative paths
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { inspectFile } from "./check.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** @returns {string[]} */
function repositoryFiles() {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter((path) => path.length > 0))].sort();
}

const requested = process.argv.slice(2).map((path) => path.replaceAll("\\", "/"));
const files = requested.length > 0 ? requested : repositoryFiles();

/** @type {{ path: string; problem: string }[]} */
const failures = [];
let checked = 0;

for (const path of files) {
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = readFileSync(join(root, path));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")) continue;
    throw error;
  }
  checked += 1;
  for (const problem of inspectFile(path, bytes)) failures.push({ path, problem });
}

if (failures.length > 0) {
  console.error(`text-integrity: ${failures.length} violation(s) in ${checked} checked file(s):`);
  for (const { path, problem } of failures) console.error(`  ${path}: ${problem}`);
  console.error("All repository text files must be UTF-8 without BOM and without null bytes (AGENTS.md section 6).");
  process.exitCode = 1;
} else {
  console.log(`text-integrity: ${checked} file(s) checked, all UTF-8 without BOM or null bytes.`);
}
