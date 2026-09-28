import pg from "pg";
import { createDatabase, type Database } from "../database.js";

/**
 * Connection strings for the disposable integration-test database
 * (docker-compose service `postgres-test`, or the CI service container).
 * The defaults are the synthetic local-only credentials from
 * docker-compose.yml; CI overrides them through the environment.
 */
export interface TestDatabaseUrls {
  /** Application role (tali_app): what the API and worker use. */
  readonly app: string;
  /** Owner/migration role (tali_owner): migrations and test setup only. */
  readonly owner: string;
}

const DEFAULT_TEST_URLS: TestDatabaseUrls = {
  app: "postgresql://tali_app:local-only-app@127.0.0.1:55433/tali_test",
  owner: "postgresql://tali_owner:local-only-owner@127.0.0.1:55433/tali_test",
};

export function testDatabaseUrls(env: Readonly<Record<string, string | undefined>> = process.env): TestDatabaseUrls {
  const urls: TestDatabaseUrls = {
    app: env["TEST_DATABASE_URL"] ?? DEFAULT_TEST_URLS.app,
    owner: env["TEST_MIGRATION_DATABASE_URL"] ?? DEFAULT_TEST_URLS.owner,
  };
  assertDisposableDatabase(urls.app);
  assertDisposableDatabase(urls.owner);
  return urls;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Test helpers truncate and reset data, so they refuse to touch anything but a
 * loopback database whose name ends in `_test`.
 */
export function assertDisposableDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//u, "");
  if (!LOOPBACK_HOSTS.has(url.hostname) || !database.endsWith("_test")) {
    throw new Error(
      `Refusing to use ${url.hostname}/${database} as a test database: it must be on a loopback host and named *_test`,
    );
  }
}

/**
 * Counts the test database's open sessions tagged with `applicationName`
 * (pg_stat_activity). Lets process-level tests prove that a shut-down process
 * released its connections. Queries as the application role, which sees its
 * own sessions in full.
 */
export async function countDatabaseSessions(applicationName: string): Promise<number> {
  const client = new pg.Client({ connectionString: testDatabaseUrls().app });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
      [applicationName],
    );
    return rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

/** A Database connected to the test database as the application role. */
export function createTestDatabase(options: { readonly applicationName?: string } = {}): Database {
  return createDatabase({
    connectionString: testDatabaseUrls().app,
    maxConnections: 5,
    applicationName: options.applicationName ?? "tali-test",
  });
}
