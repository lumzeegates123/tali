/**
 * @tali/database: PostgreSQL infrastructure (ADR-002 section 5).
 *
 * The public surface exposes application ports and lifecycle only. Prisma
 * (the generated client, its types and the driver adapter) is an internal
 * implementation detail and must never appear in these exports; this is
 * checked by src/containment.test.ts and dependency-cruiser.
 */
export type { Database, DatabaseOptions, DatabaseRepositories } from "./database.js";
export { createDatabase } from "./database.js";
