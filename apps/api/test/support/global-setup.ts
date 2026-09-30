import { addTestCurrencies, removeTestCurrencies, resetTenancyTables } from "@tali/database/testing";

/**
 * The API suite runs against the migrated disposable test database (CI applies
 * `migrate deploy` first; locally the database suite does). It never migrates
 * itself: it only resets the Build 1 tables and adds the test-only currencies,
 * through the fixture helpers that refuse any non-test target.
 */
export default async function setup(): Promise<() => Promise<void>> {
  try {
    await resetTenancyTables();
  } catch (error) {
    throw new Error(
      "The API integration suite needs the migrated test database: run `pnpm --filter @tali/database run db:migrate:deploy` against TEST_MIGRATION_DATABASE_URL first.",
      { cause: error },
    );
  }
  await addTestCurrencies();
  return async () => {
    await resetTenancyTables();
    await removeTestCurrencies();
  };
}
