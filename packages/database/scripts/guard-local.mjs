// Refuses to continue unless MIGRATION_DATABASE_URL targets a loopback host.
// Guards the commands that must never run against a shared or deployed
// database: `prisma migrate dev` (may reset) and `prisma migrate reset`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const raw = process.env.MIGRATION_DATABASE_URL;
if (raw === undefined) {
  console.error("MIGRATION_DATABASE_URL is not set.");
  process.exit(1);
}
const { hostname } = new URL(raw);
if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
  console.error(
    `Refusing: this command is for local development only, but MIGRATION_DATABASE_URL points at ${hostname}.`,
  );
  process.exit(1);
}
