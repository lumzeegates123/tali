import { ConcurrentModificationError, type TransactionScope, ValidationError } from "@tali/application";
import { describe, expect, it } from "vitest";
import { sqlStateOf, TransactionConflict } from "../../src/errors/postgres-errors.js";
import { PrismaUnitOfWork, type UnitOfWorkSettings } from "../../src/unit-of-work/prisma-unit-of-work.js";
import { transactionClient } from "../../src/unit-of-work/transaction-scope.js";
import { gate, useFixtureHarness, uuid } from "../support/harness.js";

const NOW = "2026-09-29T08:00:00.000Z";

/**
 * ADR-004 sections 11 and 13: bounded lock_timeout on every transaction, and
 * whole-callback retry of serialization failures and deadlocks only, at most
 * three attempts, with jittered backoff inside a deadline.
 */
describe("PrismaUnitOfWork: lock_timeout and bounded retry", () => {
  const { client, owner } = useFixtureHarness();

  function unitOfWork(settings: Partial<UnitOfWorkSettings> = {}) {
    return new PrismaUnitOfWork(client, { maxWaitMs: 5_000, timeoutMs: 15_000, ...settings });
  }

  /** Raises a real PostgreSQL error with the given SQLSTATE inside the transaction (fixed statements, no SQL building). */
  async function raise(scope: TransactionScope, sqlState: "40001" | "40P01" | "23505" | "55P03"): Promise<never> {
    const tx = transactionClient(scope);
    switch (sqlState) {
      case "40001":
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '40001'; END $$`;
        break;
      case "40P01":
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '40P01'; END $$`;
        break;
      case "23505":
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '23505'; END $$`;
        break;
      case "55P03":
        await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'synthetic' USING ERRCODE = '55P03'; END $$`;
        break;
    }
    throw new Error("the statement should have failed");
  }

  async function insertUser(scope: TransactionScope, n: number) {
    await transactionClient(scope).$executeRaw`
      INSERT INTO users (id, display_name, status, created_at, updated_at)
      VALUES (${uuid(n)}::uuid, 'Attempt', 'ACTIVE', ${NOW}::timestamptz, ${NOW}::timestamptz)`;
  }

  const userIds = async () =>
    (await owner.query<{ id: string }>(`SELECT id::text FROM users ORDER BY id`)).rows.map((row) => row.id);

  describe("lock_timeout", () => {
    const current = (uow: PrismaUnitOfWork) =>
      uow.run(async (scope) => {
        const rows = await transactionClient(scope).$queryRaw<{ value: string }[]>`
          SELECT current_setting('lock_timeout') AS value`;
        return rows[0]?.value;
      });

    it("defaults to 5 s and is configurable per unit of work", async () => {
      expect(await current(unitOfWork())).toBe("5s");
      expect(await current(unitOfWork({ lockTimeoutMs: 250 }))).toBe("250ms");
    });

    it("is transaction-local: the pooled connection returns to the server default", async () => {
      await current(unitOfWork({ lockTimeoutMs: 250 }));
      const rows = await client.$queryRaw<{ value: string }[]>`SELECT current_setting('lock_timeout') AS value`;
      expect(rows[0]?.value).toBe("0");
    });

    it.each([0, 5_001, 1.5, Number.NaN])("rejects lockTimeoutMs %s", (lockTimeoutMs) => {
      expect(() => unitOfWork({ lockTimeoutMs })).toThrow(/lockTimeoutMs must be an integer from 1 to 5000/);
    });

    it.each([0, 4])("rejects maxAttempts %s", (maxAttempts) => {
      expect(() => unitOfWork({ maxAttempts })).toThrow(/maxAttempts must be an integer from 1 to 3/);
    });
  });

  describe("retry", () => {
    it.each(["40001", "40P01"] as const)(
      "retries %s, rolling back each failed attempt, and then commits",
      async (state) => {
        const sleeps: number[] = [];
        const uow = unitOfWork({ jitter: (maxMs) => maxMs, sleep: async (ms) => void sleeps.push(ms) });
        let attempts = 0;
        const result = await uow.run(async (scope) => {
          attempts += 1;
          await insertUser(scope, attempts);
          if (attempts < 3) await raise(scope, state);
          return "committed";
        });
        expect(result).toBe("committed");
        expect(attempts).toBe(3);
        expect(sleeps).toEqual([20, 40]);
        expect(await userIds()).toEqual([uuid(3)]);
      },
    );

    it("stops after three attempts with CONCURRENT_MODIFICATION; the conflict stays internal as the cause", async () => {
      const uow = unitOfWork({ sleep: async () => undefined });
      let attempts = 0;
      const error = await uow
        .run(async (scope) => {
          attempts += 1;
          await raise(scope, "40001");
        })
        .catch((caught: unknown) => caught);
      expect(attempts).toBe(3);
      expect(error).toBeInstanceOf(ConcurrentModificationError);
      expect((error as ConcurrentModificationError).retryable).toBe(true);
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(TransactionConflict);
      expect(sqlStateOf(cause)).toBe("40001");
    });

    it("maxAttempts 1 disables retry", async () => {
      let attempts = 0;
      await expect(
        unitOfWork({ maxAttempts: 1 }).run(async (scope) => {
          attempts += 1;
          await raise(scope, "40P01");
        }),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(attempts).toBe(1);
    });

    it("no retry starts past the deadline", async () => {
      let clock = 0;
      const uow = unitOfWork({ deadlineMs: 100, monotonicNow: () => clock, sleep: async () => undefined });
      let attempts = 0;
      await expect(
        uow.run(async (scope) => {
          attempts += 1;
          clock += 150;
          await raise(scope, "40001");
        }),
      ).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(attempts).toBe(1);
    });

    it("the backoff is capped and jittered from zero", async () => {
      const bounds: number[] = [];
      const uow = unitOfWork({
        backoff: { baseMs: 150, maxMs: 200 },
        jitter: (maxMs) => {
          bounds.push(maxMs);
          return 0;
        },
        sleep: async () => undefined,
      });
      await expect(uow.run((scope) => raise(scope, "40001"))).rejects.toBeInstanceOf(ConcurrentModificationError);
      expect(bounds).toEqual([150, 200, 200]);
    });

    it.each([
      ["an ApplicationError", () => new ValidationError("bad input", [])],
      ["a plain Error", () => new Error("bug")],
    ])("never retries %s and rethrows it unchanged", async (_, make) => {
      const thrown = make();
      let attempts = 0;
      const error = await unitOfWork()
        .run(async (scope) => {
          attempts += 1;
          await insertUser(scope, attempts);
          throw thrown;
        })
        .catch((caught: unknown) => caught);
      expect(error).toBe(thrown);
      expect(attempts).toBe(1);
      expect(await userIds()).toEqual([]);
    });

    it("never retries other database errors (a unique violation propagates with its SQLSTATE)", async () => {
      let attempts = 0;
      const error = await unitOfWork()
        .run(async (scope) => {
          attempts += 1;
          await raise(scope, "23505");
        })
        .catch((caught: unknown) => caught);
      expect(attempts).toBe(1);
      expect(error).not.toBeInstanceOf(ConcurrentModificationError);
      expect(sqlStateOf(error)).toBe("23505");
    });

    it("a lock timeout is CONCURRENT_MODIFICATION and is not retried", async () => {
      let attempts = 0;
      const error = await unitOfWork()
        .run(async (scope) => {
          attempts += 1;
          await raise(scope, "55P03");
        })
        .catch((caught: unknown) => caught);
      expect(attempts).toBe(1);
      expect(error).toBeInstanceOf(ConcurrentModificationError);
      expect(sqlStateOf((error as Error).cause)).toBe("55P03");
    });

    it("a real deadlock is detected by PostgreSQL, the victim is retried, and both transactions commit", async () => {
      await owner.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at)
         VALUES ($1, 'First', 'ACTIVE', $3, $3), ($2, 'Second', 'ACTIVE', $3, $3)`,
        [uuid(1), uuid(2), NOW],
      );
      const uow = unitOfWork();
      const locked = { first: gate(), second: gate() };
      const attempts = { first: 0, second: 0 };
      const touch = (scope: TransactionScope, n: number, name: string) =>
        transactionClient(scope).$executeRaw`
          UPDATE users SET display_name = ${name}, updated_at = updated_at WHERE id = ${uuid(n)}::uuid`;
      const crossing = (self: "first" | "second", mine: number, theirs: number) =>
        uow.run(async (scope) => {
          attempts[self] += 1;
          await touch(scope, mine, self);
          if (attempts[self] === 1) {
            locked[self].open();
            await locked[self === "first" ? "second" : "first"].opened;
          }
          await touch(scope, theirs, self);
        });
      await Promise.all([crossing("first", 1, 2), crossing("second", 2, 1)]);
      expect(attempts.first + attempts.second).toBe(3);
      const { rows } = await owner.query<{ display_name: string }>(`SELECT display_name FROM users ORDER BY id`);
      const winner = attempts.first === 2 ? "first" : "second";
      expect(rows.map((row) => row.display_name)).toEqual([winner, winner]);
    });
  });
});
