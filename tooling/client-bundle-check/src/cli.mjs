#!/usr/bin/env node
// @ts-check
/**
 * Client-bundle secret check (Wave C). Builds the web app and exports the
 * Android bundle with every server variable set to a canary value, then scans
 * the client-delivered output for server variable names, placeholder secrets
 * and canaries. A defence in depth: dependency boundaries and the public/server
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
import { canaryEnvironment, forbiddenNeedles, THIRD_PARTY_IDENTIFIERS } from "./policy.mjs";
import { listFiles, scanFiles } from "./scan.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const webDir = join(root, "apps/web");
const mobileDir = join(root, "apps/mobile");
// The resolved public app config (including `extra`) is embedded in native
// builds and update manifests but is not part of the `expo export` output.
const mobilePublicConfig = join(mobileDir, ".expo/client-bundle-check/public-config.json");

/** Browser-delivered web output: static chunks plus prerendered HTML and RSC payloads. */
function webClientFiles() {
  const staticFiles = listFiles(join(webDir, ".next/static"));
  const appDir = join(webDir, ".next/server/app");
  const prerendered = existsSync(appDir) ? listFiles(appDir).filter((file) => /\.(html|rsc|body)$/u.test(file)) : [];
  return [...staticFiles, ...prerendered];
}

function mobileClientFiles() {
  return listFiles(join(mobileDir, "dist"));
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
  rmSync(join(mobileDir, "dist"), { recursive: true, force: true });
  run(mobileDir, ["expo", "export", "--platform", "android", "--output-dir", "dist"], mobileEnv);
  const publicConfig = run(mobileDir, ["expo", "config", "--type", "public", "--json"], mobileEnv, {
    captureStdout: true,
  });
  mkdirSync(dirname(mobilePublicConfig), { recursive: true });
  writeFileSync(mobilePublicConfig, publicConfig);
}

if (!process.argv.includes("--scan-only")) build();

const needles = forbiddenNeedles();
const targets = [
  { name: "web (.next static and prerendered output)", files: webClientFiles() },
  { name: "mobile (Expo Android export)", files: mobileClientFiles() },
  {
    name: "mobile (public app config embedded in native builds)",
    files: existsSync(mobilePublicConfig) ? [mobilePublicConfig] : [],
  },
];

let failed = false;
for (const target of targets) {
  if (target.files.length === 0) {
    console.error(`client-bundle-check: ${target.name}: no files to scan; build output is missing.`);
    failed = true;
    continue;
  }
  const findings = scanFiles(target.files, needles, root, THIRD_PARTY_IDENTIFIERS);
  if (findings.length === 0) {
    console.log(
      `client-bundle-check: ${target.name}: ${target.files.length} file(s), ${needles.length} forbidden needle(s), clean.`,
    );
  } else {
    failed = true;
    for (const finding of findings) {
      console.error(`client-bundle-check: ${finding.file}: contains ${finding.needle} (${finding.encoding})`);
    }
  }
}
process.exitCode = failed ? 1 : 0;
