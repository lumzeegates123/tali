// Drift check (ADR-002 section 5). Requires MIGRATION_DATABASE_URL and
// SHADOW_DATABASE_URL (owner role). Two comparisons:
//   1. committed migrations vs the Prisma schema: catches a schema change with
//      no migration.
//   2. committed migrations vs the target database: catches manual changes to
//      objects Prisma models.
// Prisma does not diff CHECK constraints, partial indexes or grants; those are
// verified by scripts/verify-schema.mjs.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const prismaBin = join(dirname(createRequire(import.meta.url).resolve("prisma/package.json")), "build/index.js");

const checks = [
  ["committed migrations vs Prisma schema", ["--to-schema", "prisma/schema"]],
  ["committed migrations vs target database", ["--to-config-datasource"]],
];

let failed = false;
for (const [label, target] of checks) {
  const result = spawnSync(
    process.execPath,
    [prismaBin, "migrate", "diff", "--from-migrations", "prisma/migrations", ...target, "--exit-code"],
    { cwd: packageRoot, encoding: "utf8", env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" } },
  );
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status === 0) {
    console.log(`ok    ${label}`);
  } else {
    failed = true;
    console.error(`DRIFT ${label} (exit ${result.status})\n${output}\n`);
  }
}
process.exit(failed ? 1 : 0);
