import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

export interface PrismaClientOptions {
  readonly connectionString: string;
  /** Maximum pooled connections for this process. */
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  /** Tags connections in pg_stat_activity (for example "tali-api"). */
  readonly applicationName?: string;
}

/**
 * The only place a PrismaClient is constructed. Internal to packages/database:
 * neither this function nor PrismaClient is exported from the package.
 */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
  });
  return new PrismaClient({ adapter });
}
