import { afterAll, describe, expect, it } from "vitest";
import { useFixtureHarness, uuid } from "../support/harness.js";
import { appPool, sqlState } from "../support/pg.js";

/**
 * Role protection (Wave B section 7), on the fixture table protected_entry
 * (the grant pattern for future ledger and audit tables): the
 * application role can read and append but never UPDATE, DELETE or TRUNCATE,
 * and has no DDL capability; the owner/migration role keeps full schema
 * control. SQLSTATE 42501 = insufficient_privilege.
 */
describe("role protection", () => {
  const { client, owner } = useFixtureHarness();
  const app = appPool();
  afterAll(async () => {
    await app.end();
  });

  const seed = () =>
    app.query(
      `INSERT INTO test_fixtures.protected_entry (id, note, amount_minor, created_at) VALUES ($1, 'original', 100, now())`,
      [uuid(1)],
    );

  describe("application role (tali_app)", () => {
    it("may insert and read protected rows", async () => {
      await seed();
      const { rows } = await app.query<{ note: string }>(`SELECT note FROM test_fixtures.protected_entry`);
      expect(rows).toEqual([{ note: "original" }]);
    });

    it("is denied UPDATE", async () => {
      await seed();
      expect(await sqlState(app.query(`UPDATE test_fixtures.protected_entry SET note = 'tampered'`))).toBe("42501");
    });

    it("is denied DELETE", async () => {
      await seed();
      expect(await sqlState(app.query(`DELETE FROM test_fixtures.protected_entry`))).toBe("42501");
    });

    it("is denied TRUNCATE", async () => {
      expect(await sqlState(app.query(`TRUNCATE test_fixtures.protected_entry`))).toBe("42501");
    });

    it("is denied update and delete through Prisma too", async () => {
      await seed();
      const update = client.$executeRaw`UPDATE test_fixtures.protected_entry SET note = 'tampered' WHERE id = ${uuid(1)}::uuid`;
      await expect(update).rejects.toThrow(/permission denied|42501/i);
      await expect(client.$executeRaw`DELETE FROM test_fixtures.protected_entry`).rejects.toThrow(
        /permission denied|42501/i,
      );
      const { rows } = await owner.query<{ note: string }>(`SELECT note FROM test_fixtures.protected_entry`);
      expect(rows).toEqual([{ note: "original" }]);
    });

    it("retains UPDATE and DELETE on ordinary (unprotected) tables", async () => {
      await app.query(`INSERT INTO test_fixtures.transaction_probe (id, label) VALUES ($1, 'x')`, [uuid(1)]);
      await app.query(`UPDATE test_fixtures.transaction_probe SET counter = 1`);
      await app.query(`DELETE FROM test_fixtures.transaction_probe`);
    });

    it.each([
      ["create a table in public", `CREATE TABLE public.rogue (id int)`],
      ["create a table in a schema it may use", `CREATE TABLE test_fixtures.rogue (id int)`],
      ["alter a table", `ALTER TABLE test_fixtures.protected_entry ADD COLUMN rogue text`],
      ["drop a table", `DROP TABLE test_fixtures.protected_entry`],
      ["create a schema", `CREATE SCHEMA rogue`],
      ["read the migrations table", `SELECT * FROM public._prisma_migrations`],
    ])("has no DDL or migration capability: cannot %s", async (_label, sql) => {
      expect(await sqlState(app.query(sql))).toBe("42501");
    });

    it("cannot grant itself privileges (PostgreSQL warns and grants nothing)", async () => {
      await seed();
      await app.query(`GRANT UPDATE, DELETE ON test_fixtures.protected_entry TO tali_app`);
      expect(await sqlState(app.query(`UPDATE test_fixtures.protected_entry SET note = 'tampered'`))).toBe("42501");
      expect(await sqlState(app.query(`DELETE FROM test_fixtures.protected_entry`))).toBe("42501");
    });
  });

  describe("owner/migration role (tali_owner)", () => {
    it("keeps schema-migration capability on protected tables (checked inside a rolled-back transaction)", async () => {
      const connection = await owner.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(`ALTER TABLE test_fixtures.protected_entry ADD COLUMN migration_probe text`);
        await connection.query(
          `CREATE INDEX protected_entry_probe_idx ON test_fixtures.protected_entry (migration_probe)`,
        );
        await connection.query(`ALTER TABLE test_fixtures.protected_entry DROP COLUMN migration_probe`);
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
    });

    it("privileges are exactly the intended set", async () => {
      const { rows } = await owner.query<{ privilege: string }>(
        `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
         WHERE grantee = 'tali_app' AND table_schema = 'test_fixtures' AND table_name = 'protected_entry'
         ORDER BY privilege_type`,
      );
      expect(rows.map((row) => row.privilege)).toEqual(["INSERT", "SELECT"]);
    });
  });
});
