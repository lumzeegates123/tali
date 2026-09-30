import { DependencyUnavailableError } from "@tali/application";
import { parseCurrencyCode } from "@tali/domain";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/index.js";
import { createTestDatabase, testDatabaseUrls } from "../../src/testing/index.js";
import { appPool } from "../support/pg.js";

describe("database connectivity", () => {
  const database = createTestDatabase();
  const app = appPool();

  afterAll(async () => {
    await database.disconnect();
    await app.end();
  });

  it("pings PostgreSQL through the application role", async () => {
    await expect(database.ping()).resolves.toBeUndefined();
  });

  it("connects as the least-privileged application role, not the owner", async () => {
    const { rows } = await app.query<{ user: string; superuser: string }>(
      "SELECT current_user AS user, current_setting('is_superuser') AS superuser",
    );
    expect(rows[0]).toEqual({ user: "tali_app", superuser: "off" });
  });

  it("reports an unreachable database as DependencyUnavailableError", async () => {
    const url = new URL(testDatabaseUrls().app);
    url.port = "1";
    const unreachable = createDatabase({ connectionString: url.toString(), connectionTimeoutMs: 1_000 });
    try {
      await expect(unreachable.ping()).rejects.toBeInstanceOf(DependencyUnavailableError);
    } finally {
      await unreachable.disconnect();
    }
  });

  it("reports an unreachable database inside a unit of work as DependencyUnavailableError", async () => {
    const url = new URL(testDatabaseUrls().app);
    url.port = "1";
    const unreachable = createDatabase({ connectionString: url.toString(), connectionTimeoutMs: 1_000 });
    try {
      const failure = await unreachable.unitOfWork
        .run((scope) => unreachable.repositories.currencies.findByCode(scope, parseCurrencyCode("KES")))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DependencyUnavailableError);
      expect((failure as Error).message).toBe("The database is unavailable");
    } finally {
      await unreachable.disconnect();
    }
  });

  it("rejects wrong credentials as DependencyUnavailableError", async () => {
    const url = new URL(testDatabaseUrls().app);
    url.password = "wrong-password";
    const rejected = createDatabase({ connectionString: url.toString(), connectionTimeoutMs: 2_000 });
    try {
      await expect(rejected.ping()).rejects.toBeInstanceOf(DependencyUnavailableError);
    } finally {
      await rejected.disconnect();
    }
  });
});
