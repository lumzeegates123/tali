import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const prismaBin = join(dirname(createRequire(import.meta.url).resolve("prisma/package.json")), "build/index.js");

export interface CliResult {
  readonly status: number | null;
  readonly output: string;
}

/** Runs the Prisma CLI without a shell, against an explicit migration URL. */
export function prisma(args: readonly string[], migrationUrl: string, shadowUrl?: string): CliResult {
  const result = spawnSync(process.execPath, [prismaBin, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: migrationUrl,
      ...(shadowUrl === undefined ? {} : { SHADOW_DATABASE_URL: shadowUrl }),
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
