import { testDatabaseUrls } from "./test-database.js";

/**
 * Fail-closed target checks for test fixture statements (see
 * tenancy-fixtures.ts). No driver types, so the testing entry point stays free
 * of pg and Prisma types.
 */
export type FixtureEnv = Readonly<Record<string, string | undefined>>;

export class FixtureSafetyError extends Error {
  constructor(message: string) {
    super(`Refusing to run test-fixture DDL: ${message}`);
    this.name = "FixtureSafetyError";
  }
}

/** Checks 1 and 2. Returns the only connection string fixture statements may use. */
export function fixtureTargetUrl(env: FixtureEnv = process.env): string {
  if (env["TALI_ENV"] !== "test") {
    throw new FixtureSafetyError(`TALI_ENV must be "test" (found ${JSON.stringify(env["TALI_ENV"] ?? null)})`);
  }
  try {
    return testDatabaseUrls(env).owner;
  } catch (error) {
    throw new FixtureSafetyError(error instanceof Error ? error.message : String(error));
  }
}

interface SessionIdentity {
  database: string;
  user: string;
}

interface Queryable {
  query(sql: string): Promise<{ rows: Partial<SessionIdentity>[] }>;
}

/** Check 3: the server, not the URL, confirms which database and role this session is. */
export async function assertFixtureSession(session: Queryable, targetUrl: string): Promise<void> {
  const url = new URL(targetUrl);
  const expectedDatabase = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const expectedUser = decodeURIComponent(url.username);
  const { rows } = await session.query("SELECT current_database() AS database, current_user AS user");
  const actual = rows[0];
  if (actual?.database !== expectedDatabase || !expectedDatabase.endsWith("_test") || actual.user !== expectedUser) {
    throw new FixtureSafetyError(
      `connected session is ${actual?.user ?? "?"}@${actual?.database ?? "?"}, expected ${expectedUser}@${expectedDatabase}`,
    );
  }
}
