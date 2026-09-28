// @ts-check
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");

/**
 * Workspace packages publish compiled `dist/` output through `exports`, and
 * `dist/` is excluded from the graph. Without these aliases every cross-package
 * edge would resolve into `dist/` and silently disappear, so each exported
 * subpath is mapped back to the source file it is compiled from. Only exported
 * subpaths are aliased: deep imports stay unresolvable and fail the check.
 * @returns {Record<string, string>}
 */
function workspaceSourceAliases() {
  const fs = require("node:fs");
  /** @type {Record<string, string>} */
  const aliases = {};
  for (const group of ["packages", "apps"]) {
    const groupDir = path.join(repositoryRoot, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      const manifestPath = path.join(groupDir, entry.name, "package.json");
      if (!entry.isDirectory() || !fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        const built = typeof target === "string" ? target : target.default;
        const match = /^\.\/dist\/(.+)\.js$/u.exec(built ?? "");
        if (!match) continue;
        const specifier = subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
        aliases[`${specifier}$`] = path.join(groupDir, entry.name, "src", `${match[1]}.ts`);
      }
    }
  }
  return aliases;
}

module.exports = { resolve: { alias: workspaceSourceAliases() } };
