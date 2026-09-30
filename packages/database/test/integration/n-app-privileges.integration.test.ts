import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlStateOf } from "../../src/errors/postgres-errors.js";
import { useFixtureHarness } from "../support/harness.js";
import { appPool, sqlState } from "../support/pg.js";

const INSUFFICIENT_PRIVILEGE = "42501";

const BUILD_1_TABLES = [
  "currencies",
  "users",
  "external_identities",
  "businesses",
  "business_locations",
  "business_memberships",
  "business_invitations",
  "devices",
  "business_audit_records",
  "platform_audit_records",
  "user_idempotency_records",
  "business_idempotency_records",
] as const;

const INSERT_ONLY_TABLES = [
  "external_identities",
  "business_audit_records",
  "platform_audit_records",
  "user_idempotency_records",
  "business_idempotency_records",
] as const;

/**
 * The runtime role's privileges (ADR-005 section 20; ADR-004 sections 4.2 and
 * 8.1): no DELETE or TRUNCATE anywhere, insert-only audit, idempotency and
 * identity-link tables, and read-only reference currencies. Checked both over
 * a raw connection and through the Prisma client the adapters use.
 */
describe("tali_app privileges on the Build 1 tables", () => {
  const { client } = useFixtureHarness();
  let app: pg.Pool;

  beforeAll(() => {
    app = appPool();
  });

  afterAll(async () => {
    await app.end();
  });

  it("the connection under test really is the application role", async () => {
    const { rows } = await app.query<{ user: string }>(`SELECT current_user AS user`);
    expect(rows[0]?.user).toBe("tali_app");
    const viaPrisma = await client.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
    expect(viaPrisma[0]?.user).toBe("tali_app");
  });

  it.each(BUILD_1_TABLES)("%s: DELETE and TRUNCATE are denied", async (table) => {
    expect(await sqlState(app.query(`DELETE FROM ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`TRUNCATE ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each(INSERT_ONLY_TABLES)("%s: UPDATE is denied (insert-only)", async (table) => {
    expect(await sqlState(app.query(`UPDATE ${table} SET id = id`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("currencies are read-only reference data", async () => {
    const { rows } = await app.query(`SELECT code FROM currencies WHERE code = 'NGN'`);
    expect(rows).toEqual([{ code: "NGN" }]);
    expect(await sqlState(app.query(`INSERT INTO currencies (code, minor_unit_digits) VALUES ('ZZZ', 2)`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(app.query(`UPDATE currencies SET minor_unit_digits = 3 WHERE code = 'NGN'`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("the application role cannot change the schema or become the owner", async () => {
    expect(await sqlState(app.query(`ALTER TABLE users ADD COLUMN extra text`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`DROP TABLE business_audit_records`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(app.query(`SET ROLE tali_owner`))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("the Prisma client path is refused by the database too, with the SQLSTATE preserved", async () => {
    const denied = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return sqlStateOf(error);
      }
      throw new Error("expected the statement to be denied");
    };
    expect(await denied(() => client.$executeRaw`DELETE FROM business_memberships`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await denied(() => client.$executeRaw`UPDATE business_audit_records SET reason = NULL`)).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await denied(() => client.$executeRaw`TRUNCATE users`)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
