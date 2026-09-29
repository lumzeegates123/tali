#!/usr/bin/env node
/*
 * Checks the TALI_COMPAT_REPORT line that the diagnostics screen logs on a
 * device (release build, Hermes) against test/fixtures/kernel-compat.golden.json.
 *
 *   adb logcat -d -s ReactNativeJS:I > logcat.txt
 *   node scripts/compare-device-report.mjs logcat.txt
 *
 * Exits non-zero unless the engine is Hermes, the kernel section matches the
 * Node.js golden output byte for byte, and the UUIDv7 checks passed using the
 * secure random source only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "TALI_COMPAT_REPORT ";
const logPath = process.argv[2];
if (logPath === undefined) {
  console.error("usage: compare-device-report.mjs <logcat file>");
  process.exit(2);
}

const raw = readFileSync(logPath);
// PowerShell redirection writes UTF-16LE with a byte order mark.
const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString("utf16le") : raw.toString("utf8");
const line = text
  .split(/\r?\n/)
  .filter((entry) => entry.includes(PREFIX))
  .at(-1);
if (line === undefined) {
  console.error(`no ${PREFIX.trim()} line in ${logPath}`);
  process.exit(1);
}
const report = JSON.parse(line.slice(line.indexOf(PREFIX) + PREFIX.length));

const golden = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "kernel-compat.golden.json"),
  "utf8",
);
const kernel = `${JSON.stringify(report.kernel, null, 2)}\n`;

const failures = [];
if (report.engine?.hermes !== true) failures.push("engine is not Hermes");
if (kernel !== golden) {
  const expected = JSON.parse(golden).cases;
  for (const [name, outcome] of Object.entries({ ...expected, ...report.kernel.cases })) {
    if (JSON.stringify(report.kernel.cases[name]) !== JSON.stringify(expected[name])) {
      failures.push(
        `kernel case ${name}: device ${JSON.stringify(report.kernel.cases[name])}, golden ${JSON.stringify(expected[name] ?? outcome)}`,
      );
    }
  }
  if (failures.length === 0 || report.kernel.bigintPrimitive !== "bigint")
    failures.push("kernel section differs from golden");
}
const uuid = report.uuidV7;
if (uuid?.status !== "complete") failures.push(`UUIDv7 not generated: ${JSON.stringify(uuid)}`);
else {
  if (uuid.checks.passed !== true) failures.push(`UUIDv7 checks failed: ${JSON.stringify(uuid.checks)}`);
  if (uuid.checks.randomSourceCalls.mathRandom !== 0) failures.push("Math.random was called during UUIDv7 generation");
}

console.log(
  JSON.stringify(
    { engine: report.engine, kernelCases: Object.keys(report.kernel.cases).length, uuidV7: uuid },
    null,
    2,
  ),
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("device report matches the golden kernel output; UUIDv7 checks passed");
