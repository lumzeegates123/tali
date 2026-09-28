import pg from "pg";
import { testDatabaseUrls } from "../../src/testing/index.js";
import { createFixtures, dropFixtures } from "./fixtures.js";
import { prisma } from "./prisma-cli.js";

/**
 * Applies committed migrations to the disposable test database, exactly as CI
 * and deployments do, then adds the test-only fixture schema (never a
 * migration). The teardown removes the fixtures again, so the database is left
 * exactly as the migration chain built it.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const result = prisma(["migrate", "deploy"], testDatabaseUrls().owner);
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed against the test database:\n${result.output}`);
  }
  const owner = new pg.Client({ connectionString: testDatabaseUrls().owner });
  await owner.connect();
  try {
    await createFixtures(owner);
  } finally {
    await owner.end();
  }

  return async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrls().owner });
    await client.connect();
    try {
      await dropFixtures(client);
    } finally {
      await client.end();
    }
  };
}
