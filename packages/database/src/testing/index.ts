/**
 * @tali/database/testing: helpers for integration tests in other packages.
 * Never imported by production code. Exposes no Prisma types.
 */
export type { TestDatabaseUrls } from "./test-database.js";
export {
  assertDisposableDatabase,
  countDatabaseSessions,
  createTestDatabase,
  testDatabaseUrls,
} from "./test-database.js";
export { assertFixtureSession, FixtureSafetyError, fixtureTargetUrl } from "./fixture-safety.js";
export type { InventoryConsistencyIssue, InventoryConsistencyKind } from "../inventory/consistency-query.js";
export type { CatalogSnapshot, InventorySnapshot, TenancySnapshot } from "./tenancy-fixtures.js";
export {
  addTestCurrencies,
  readCatalogSnapshot,
  readInventoryConsistency,
  readInventorySnapshot,
  readTenancySnapshot,
  removeTestCurrencies,
  resetTenancyTables,
  TENANCY_TABLES,
  TEST_CURRENCIES,
  tenancyFixtures,
} from "./tenancy-fixtures.js";
