// @ts-check
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * @typedef {{ readonly label: string; readonly value: string }} Needle
 * @typedef {{ readonly file: string; readonly needle: string; readonly encoding: "utf8" | "utf16le" }} Finding
 */

/**
 * Every file under `dir`, recursively.
 * @param {string} dir
 * @returns {string[]}
 */
export function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Searches raw bytes for each needle in UTF-8 and UTF-16LE, so JavaScript,
 * HTML, RSC payloads and Hermes bytecode string tables are all covered.
 * @param {readonly string[]} files
 * @param {readonly Needle[]} needles
 * @param {string} root report paths relative to this directory
 * @returns {Finding[]}
 */
export function scanFiles(files, needles, root) {
  const patterns = needles.flatMap((needle) => [
    { needle, encoding: /** @type {const} */ ("utf8"), bytes: Buffer.from(needle.value, "utf8") },
    { needle, encoding: /** @type {const} */ ("utf16le"), bytes: Buffer.from(needle.value, "utf16le") },
  ]);
  /** @type {Finding[]} */
  const findings = [];
  for (const file of files) {
    const content = readFileSync(file);
    for (const { needle, encoding, bytes } of patterns) {
      if (content.includes(bytes)) {
        findings.push({ file: relative(root, file).replaceAll("\\", "/"), needle: needle.label, encoding });
      }
    }
  }
  return findings;
}
