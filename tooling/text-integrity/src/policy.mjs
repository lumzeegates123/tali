// @ts-check
/**
 * Repository text-integrity policy (AGENTS.md section 6, ADR-002 section 19).
 * Every file that is not explicitly listed as binary is treated as text and
 * must be UTF-8 without a byte-order mark and without null bytes.
 */

/** Explicit binary exclusion list, by lowercase file extension. */
export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".avif",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".m4a",
  ".wasm",
]);

/**
 * Repository-relative paths (forward slashes) that may carry a UTF-8 BOM
 * because a specific tool requires it. Empty by policy; additions need review.
 * @type {ReadonlySet<string>}
 */
export const UTF8_BOM_ALLOWED_PATHS = new Set([]);
