import pg from "pg";
import { assertFixtureSession, type FixtureEnv, fixtureTargetUrl } from "./fixture-safety.js";

/**
 * Runs work in a verified owner session on the disposable test database.
 * Internal to the database package (its signature has a pg type), so it is
 * never exported from the testing entry point.
 */
export async function withFixtureSession<T>(env: FixtureEnv, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const target = fixtureTargetUrl(env);
  const client = new pg.Client({ connectionString: target, application_name: "tali-test-fixtures" });
  await client.connect();
  try {
    await assertFixtureSession(client, target);
    return await work(client);
  } finally {
    await client.end();
  }
}
