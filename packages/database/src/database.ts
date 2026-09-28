import { DependencyUnavailableError, type UnitOfWork } from "@tali/application";
import { createPrismaClient } from "./client/prisma-client.js";
import { PrismaUnitOfWork } from "./unit-of-work/prisma-unit-of-work.js";

export interface DatabaseOptions {
  /** Application-role connection string (DATABASE_URL). Never the migration role. */
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly applicationName?: string;
  readonly transactionMaxWaitMs?: number;
  readonly transactionTimeoutMs?: number;
}

/**
 * The database as seen by composition roots (apps/api, apps/worker). Exposes
 * only application ports and lifecycle; Prisma stays inside this package.
 */
export interface Database {
  readonly unitOfWork: UnitOfWork;
  /** Round-trips to PostgreSQL. Rejects with DependencyUnavailableError when unreachable. */
  ping(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const client = createPrismaClient({
    connectionString: options.connectionString,
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.connectionTimeoutMs === undefined ? {} : { connectionTimeoutMs: options.connectionTimeoutMs }),
    ...(options.applicationName === undefined ? {} : { applicationName: options.applicationName }),
  });
  const unitOfWork = new PrismaUnitOfWork(client, {
    maxWaitMs: options.transactionMaxWaitMs ?? 5_000,
    timeoutMs: options.transactionTimeoutMs ?? 15_000,
  });

  return {
    unitOfWork,
    async ping() {
      try {
        await client.$queryRaw`SELECT 1`;
      } catch (error) {
        throw new DependencyUnavailableError("PostgreSQL is unreachable", { cause: error });
      }
    },
    async disconnect() {
      await client.$disconnect();
    },
  };
}
