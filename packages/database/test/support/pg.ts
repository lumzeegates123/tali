import pg from "pg";
import { testDatabaseUrls } from "../../src/testing/index.js";

/**
 * Raw pg pools for test setup and for SQL-level assertions (role privileges,
 * catalog checks) that must not go through the code under test.
 */
export function ownerPool(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrls().owner, max: 4 });
}

export function appPool(): pg.Pool {
  return new pg.Pool({ connectionString: testDatabaseUrls().app, max: 4 });
}

/** Resolves with the PostgreSQL SQLSTATE of a rejected query. */
export async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  throw new Error("expected the query to fail");
}
