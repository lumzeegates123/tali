import { testDatabaseUrls } from "../../src/testing/index.js";
import { createFixtures, dropFixtures, fixtureTargetUrl } from "./fixtures.js";
import { prisma } from "./prisma-cli.js";

/**
 * Applies committed migrations to the disposable test database, exactly as CI
 * and deployments do, then adds the test-only fixture schema (never a
 * migration). The teardown removes the fixtures again, so the database is left
 * exactly as the migration chain built it. The fixture safety checks run
 * first, so a non-test configuration is refused before any migration.
 */
export default async function setup(): Promise<() => Promise<void>> {
  fixtureTargetUrl();
  const result = prisma(["migrate", "deploy"], testDatabaseUrls().owner);
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed against the test database:\n${result.output}`);
  }
  await createFixtures();
  return async () => {
    await dropFixtures();
  };
}
