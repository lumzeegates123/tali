import { describe, expect, it } from "vitest";
import { testDatabaseUrls } from "../../src/testing/index.js";
import {
  addTestCurrencies,
  assertFixtureSession,
  createFixtures,
  dropFixtures,
  FixtureSafetyError,
  fixtureTargetUrl,
  removeTestCurrencies,
  resetTenancyTables,
  truncateFixtures,
} from "../support/fixtures.js";
import { ownerPool } from "../support/pg.js";

const TEST_OWNER_URL = testDatabaseUrls().owner;
// Synthetic local-only credentials (docker-compose.yml); the development database is tali_local.
const LOCAL_DEVELOPMENT_URL = "postgresql://tali_owner:local-only-owner@127.0.0.1:55432/tali_local";

/** Test-only fixture DDL fails closed on anything but the configured disposable test database. */
describe("test fixture safety", () => {
  it("accepts only TALI_ENV=test with the configured integration-test database", () => {
    expect(fixtureTargetUrl({ TALI_ENV: "test", TEST_MIGRATION_DATABASE_URL: TEST_OWNER_URL })).toBe(TEST_OWNER_URL);
  });

  it.each([undefined, "", "local", "development", "staging", "production", "TEST"])(
    "refuses TALI_ENV=%j even against the test database",
    (taliEnv) => {
      expect(() => fixtureTargetUrl({ TALI_ENV: taliEnv, TEST_MIGRATION_DATABASE_URL: TEST_OWNER_URL })).toThrow(
        FixtureSafetyError,
      );
    },
  );

  it.each([
    ["the local development database", LOCAL_DEVELOPMENT_URL],
    ["a remote staging host", "postgresql://tali_owner:x@db.staging.example.com:5432/tali_test"],
    ["a non-test database name", "postgresql://tali_owner:x@127.0.0.1:55433/tali_production"],
    ["a name that only contains test", "postgresql://tali_owner:x@127.0.0.1:55433/tali_test_backup"],
  ])("refuses %s even with TALI_ENV=test", (_label, url) => {
    expect(() => fixtureTargetUrl({ TALI_ENV: "test", TEST_MIGRATION_DATABASE_URL: url })).toThrow(FixtureSafetyError);
  });

  it.each([
    ["createFixtures", createFixtures],
    ["dropFixtures", dropFixtures],
    ["truncateFixtures", truncateFixtures],
    ["resetTenancyTables", resetTenancyTables],
    ["addTestCurrencies", addTestCurrencies],
    ["removeTestCurrencies", removeTestCurrencies],
  ])("%s refuses a non-test configuration before connecting", async (_name, operation) => {
    await expect(operation({ TALI_ENV: "local", TEST_MIGRATION_DATABASE_URL: TEST_OWNER_URL })).rejects.toBeInstanceOf(
      FixtureSafetyError,
    );
    await expect(
      operation({ TALI_ENV: "test", TEST_MIGRATION_DATABASE_URL: LOCAL_DEVELOPMENT_URL }),
    ).rejects.toBeInstanceOf(FixtureSafetyError);
  });

  it("refuses a session whose server-reported database or role differs from the target", async () => {
    const session = (database: string, user: string) => ({
      query: () => Promise.resolve({ rows: [{ database, user }] }),
    });
    await expect(assertFixtureSession(session("tali_local", "tali_owner"), TEST_OWNER_URL)).rejects.toBeInstanceOf(
      FixtureSafetyError,
    );
    await expect(assertFixtureSession(session("tali_test", "tali_admin"), TEST_OWNER_URL)).rejects.toBeInstanceOf(
      FixtureSafetyError,
    );
    await expect(
      assertFixtureSession(session("tali_local", "tali_owner"), LOCAL_DEVELOPMENT_URL),
    ).rejects.toBeInstanceOf(FixtureSafetyError);
    await expect(assertFixtureSession(session("tali_test", "tali_owner"), TEST_OWNER_URL)).resolves.toBeUndefined();
  });

  it("the live test database session passes the server-side check", async () => {
    const owner = ownerPool();
    try {
      await expect(assertFixtureSession(owner, TEST_OWNER_URL)).resolves.toBeUndefined();
    } finally {
      await owner.end();
    }
  });
});
