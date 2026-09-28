import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

/*
 * Prisma CLI configuration (migrations only). The CLI connects as the
 * migration/owner role; the running API and worker never see these URLs.
 *
 *   MIGRATION_DATABASE_URL  owner role, target database
 *   SHADOW_DATABASE_URL     owner role, disposable shadow database
 *                           (migrate dev and the drift check only)
 *
 * Locally, values are read from the repository-root .env when present.
 * Variables already set in the environment (CI) take precedence.
 */
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const url = process.env["MIGRATION_DATABASE_URL"];
const shadowDatabaseUrl = process.env["SHADOW_DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema",
  migrations: { path: "prisma/migrations" },
  ...(url === undefined
    ? {}
    : { datasource: { url, ...(shadowDatabaseUrl === undefined ? {} : { shadowDatabaseUrl }) } }),
});
