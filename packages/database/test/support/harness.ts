import { afterAll, beforeEach } from "vitest";
import { createPrismaClient } from "../../src/client/prisma-client.js";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { PrismaUnitOfWork } from "../../src/unit-of-work/prisma-unit-of-work.js";
import { truncateFixtures } from "./fixtures.js";
import { ownerPool } from "./pg.js";

/**
 * Per-file harness: a Prisma client connected as the APPLICATION role (the
 * code under test never runs as the owner), a unit of work over it, and an
 * owner pool for setup and assertions. Fixture tables are truncated before
 * each test.
 */
export function useFixtureHarness(options: { readonly transactionTimeoutMs?: number } = {}) {
  const client = createPrismaClient({
    connectionString: testDatabaseUrls().app,
    maxConnections: 8,
    applicationName: "tali-database-test",
  });
  const unitOfWork = new PrismaUnitOfWork(client, {
    maxWaitMs: 5_000,
    timeoutMs: options.transactionTimeoutMs ?? 15_000,
  });
  const owner = ownerPool();

  beforeEach(async () => {
    await truncateFixtures();
  });

  afterAll(async () => {
    await client.$disconnect();
    await owner.end();
  });

  return { client, unitOfWork, owner };
}

export function uuid(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus the function that resolves it: used to hold a transaction open. */
export function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
