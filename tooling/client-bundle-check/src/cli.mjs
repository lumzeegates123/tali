#!/usr/bin/env node
// @ts-check
/**
 * Client-bundle secret check (Wave C). Builds the web app and exports the
 * Android and iOS bundles with every server variable set to a canary value,
 * then scans the client-delivered output for server variable names,
 * placeholder secrets and canaries. Mobile bundles are exported twice: as
 * JavaScript, scanned for names and values, and as Hermes bytecode, scanned
 * for values. A defence in depth: dependency boundaries and the public/server
 * config split remain the primary protection.
 *
 * Usage:
 *   node tooling/client-bundle-check/src/cli.mjs              # build, export, scan
 *   node tooling/client-bundle-check/src/cli.mjs --scan-only  # scan existing output
 *
 * Builds run directly (not through Turbo, whose strict environment mode would
 * strip the canaries) and need the workspace packages built first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canaryEnvironment, forbiddenNeedles, forbiddenValueNeedles, THIRD_PARTY_IDENTIFIERS } from "./policy.mjs";
import { listFiles, scanFiles } from "./scan.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webDir = join(root, "apps/web");
const mobileDir = join(root, "apps/mobile");
// The resolved public app config (including `extra`) is embedded in native
// builds and update manifests but is not part of the `expo export` output.
const mobilePublicConfig = join(mobileDir, ".expo/client-bundle-check/public-config.json");
// The same Android and iOS bundles as Hermes bytecode, the form shipped in builds.
const mobileBytecodeDir = join(mobileDir, ".expo/client-bundle-check/hermes");

/** Browser-delivered web output: static chunks plus prerendered HTML and RSC payloads. */
function webClientFiles() {
  const staticFiles = listFiles(join(webDir, ".next/static"));
  const appDir = join(webDir, ".next/server/app");
  const prerendered = existsSync(appDir) ? listFiles(appDir).filter((file) => /\.(html|rsc|body)$/u.test(file)) : [];
  return [...staticFiles, ...prerendered];
}

/** @param {string} dir */
function filesIn(dir) {
  return existsSync(dir) ? listFiles(dir) : [];
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {{ captureStdout?: boolean }} [options]
 * @returns {string}
 */
function run(cwd, args, env, options = {}) {
  const result = spawnSync("pnpm", ["exec", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", options.captureStdout === true ? "pipe" : "inherit", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`client-bundle-check: "${args.join(" ")}" failed in ${cwd}`);
  }
  return result.stdout ?? "";
}

function build() {
  const canaries = canaryEnvironment();
  const shared = { ...canaries, CI: "1", NEXT_TELEMETRY_DISABLED: "1", EXPO_NO_TELEMETRY: "1" };
  rmSync(join(webDir, ".next"), { recursive: true, force: true });
  run(webDir, ["next", "build"], {
    ...shared,
    NEXT_PUBLIC_TALI_ENV: "test",
    NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3910",
  });
  const mobileEnv = {
    ...shared,
    EXPO_PUBLIC_TALI_ENV: "test",
    EXPO_PUBLIC_API_BASE_URL: "http://127.0.0.1:3910",
  };
  const platforms = ["--platform", "android", "--platform", "ios"];
  rmSync(join(mobileDir, "dist"), { recursive: true, force: true });
  run(mobileDir, ["expo", "export", ...platforms, "--no-bytecode", "--output-dir", "dist"], mobileEnv);
  rmSync(mobileBytecodeDir, { recursive: true, force: true });
  run(mobileDir, ["expo", "export", ...platforms, "--output-dir", mobileBytecodeDir], mobileEnv);
  const publicConfig = run(mobileDir, ["expo", "config", "--type", "public", "--json"], mobileEnv, {
    captureStdout: true,
  });
  mkdirSync(dirname(mobilePublicConfig), { recursive: true });
  writeFileSync(mobilePublicConfig, publicConfig);
}

if (!process.argv.includes("--scan-only")) build();

const names = { needles: forbiddenNeedles(), masks: THIRD_PARTY_IDENTIFIERS };
const values = { needles: forbiddenValueNeedles(), masks: [] };
const targets = [
  { name: "web (.next static and prerendered output)", files: webClientFiles(), ...names },
  { name: "mobile (Expo Android and iOS JavaScript export)", files: filesIn(join(mobileDir, "dist")), ...names },
  { name: "mobile (Expo Android and iOS Hermes bytecode export)", files: filesIn(mobileBytecodeDir), ...values },
  {
    name: "mobile (public app config embedded in native builds)",
    files: existsSync(mobilePublicConfig) ? [mobilePublicConfig] : [],
    ...names,
  },
];

let failed = false;
for (const target of targets) {
  if (target.files.length === 0) {
    console.error(`client-bundle-check: ${target.name}: no files to scan; build output is missing.`);
    failed = true;
    continue;
  }
  const findings = scanFiles(target.files, target.needles, root, target.masks);
  if (findings.length === 0) {
    console.log(
      `client-bundle-check: ${target.name}: ${target.files.length} file(s), ${target.needles.length} forbidden needle(s), clean.`,
    );
  } else {
    failed = true;
    for (const finding of findings) {
      console.error(`client-bundle-check: ${finding.file}: contains ${finding.needle} (${finding.encoding})`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
