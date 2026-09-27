// @ts-check
import { BINARY_EXTENSIONS, UTF8_BOM_ALLOWED_PATHS } from "./policy.mjs";

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];
const UTF32_LE_BOM = [0xff, 0xfe, 0x00, 0x00];
const UTF32_BE_BOM = [0x00, 0x00, 0xfe, 0xff];

const UTF16_SAMPLE_BYTES = 4096;

/**
 * @param {Uint8Array} bytes
 * @param {readonly number[]} prefix
 */
function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

/**
 * Heuristic for UTF-16 without a BOM: mostly-ASCII UTF-16 text has a null in
 * the same half of most 2-byte code units.
 * @param {Uint8Array} bytes
 */
function looksLikeUtf16WithoutBom(bytes) {
  const length = Math.min(bytes.length, UTF16_SAMPLE_BYTES) & ~1;
  if (length < 2) return false;
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < length; index += 2) {
    if (bytes[index] === 0 && bytes[index + 1] !== 0) evenNulls += 1;
    if (bytes[index + 1] === 0 && bytes[index] !== 0) oddNulls += 1;
  }
  const units = length / 2;
  const paired = Math.max(evenNulls, oddNulls);
  return paired >= 4 && paired / units >= 0.6;
}

/**
 * Returns the policy violations for one file's content (empty when clean).
 * @param {Uint8Array} bytes
 * @param {{ allowUtf8Bom?: boolean }} [options]
 * @returns {string[]}
 */
export function inspectText(bytes, options = {}) {
  if (startsWith(bytes, UTF32_LE_BOM) || startsWith(bytes, UTF32_BE_BOM)) {
    return ["UTF-32 byte-order mark: file is not UTF-8"];
  }
  if (startsWith(bytes, UTF16_LE_BOM) || startsWith(bytes, UTF16_BE_BOM)) {
    return ["UTF-16 byte-order mark: file is not UTF-8"];
  }

  /** @type {string[]} */
  const violations = [];
  if (startsWith(bytes, UTF8_BOM) && options.allowUtf8Bom !== true) {
    violations.push("UTF-8 byte-order mark (BOM) is prohibited");
  }

  const firstNull = bytes.indexOf(0);
  if (firstNull !== -1) {
    violations.push(
      looksLikeUtf16WithoutBom(bytes)
        ? "UTF-16 text without a byte-order mark (alternating null bytes)"
        : `null byte at offset ${firstNull}`,
    );
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    violations.push("invalid UTF-8 byte sequence");
  }

  return violations;
}

/**
 * @param {string} relativePath repository-relative path with forward slashes
 */
export function isBinaryPath(relativePath) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot));
}

/**
 * @param {string} relativePath repository-relative path with forward slashes
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function inspectFile(relativePath, bytes) {
  if (isBinaryPath(relativePath)) return [];
  return inspectText(bytes, { allowUtf8Bom: UTF8_BOM_ALLOWED_PATHS.has(relativePath) });
}
