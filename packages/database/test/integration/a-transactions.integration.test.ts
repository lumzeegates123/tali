import { ConcurrentModificationError, type UnitOfWork } from "@tali/application";
import { describe, expect, it } from "vitest";
import { sqlStateOf } from "../../src/errors/postgres-errors.js";
import { PrismaUnitOfWork } from "../../src/unit-of-work/prisma-unit-of-work.js";
import { currentIsolationLevel, findProbe, insertProbe, setProbeCounter } from "../support/fixture-repositories.js";
import { gate, useFixtureHarness, uuid } from "../support/harness.js";

/** Criterion A: interactive transactions. */
describe("A. interactive transactions", () => {
  const { client, unitOfWork, owner } = useFixtureHarness();

  const count = async () =>
    Number((await owner.query<{ n: string }>("SELECT count(*) AS n FROM test_fixtures.transaction_probe")).rows[0]?.n);

  it("commits multiple statements, with reads seeing earlier writes in the same transaction", async () => {
    const result = await unitOfWork.run(async (scope) => {
      await insertProbe(scope, uuid(1), "first");
      await insertProbe(scope, uuid(2), "second");
      await setProbeCounter(scope, uuid(1), 5);
      return findProbe(scope, uuid(1));
    });
    expect(result).toEqual({ id: uuid(1), label: "first", counter: 5 });
    expect(await count()).toBe(2);
  });

  it("rolls back every statement when the work throws", async () => {
    const failure = new Error("fail after two writes");
    await expect(
      unitOfWork.run(async (scope) => {
        await insertProbe(scope, uuid(1), "first");
        await insertProbe(scope, uuid(2), "second");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await count()).toBe(0);
  });

  it("rolls back when a later statement fails in the database", async () => {
    await expect(
      unitOfWork.run(async (scope) => {
        await insertProbe(scope, uuid(1), "first");
        await insertProbe(scope, uuid(1), "duplicate primary key");
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it("does not expose uncommitted writes to other connections", async () => {
    const written = gate();
    const release = gate();
    const transaction = unitOfWork.run(async (scope) => {
      await insertProbe(scope, uuid(1), "pending");
      written.open();
      await release.opened;
    });
    await written.opened;
    expect(await count()).toBe(0);
    release.open();
    await transaction;
    expect(await count()).toBe(1);
  });

  it.each([
    ["read-committed", "read committed"],
    ["repeatable-read", "repeatable read"],
    ["serializable", "serializable"],
  ] as const)("runs at the configured isolation level: %s", async (level, expected) => {
    await expect(unitOfWork.run(currentIsolationLevel, { isolationLevel: level })).resolves.toBe(expected);
  });

  it("defaults to read committed", async () => {
    await expect(unitOfWork.run(currentIsolationLevel)).resolves.toBe("read committed");
  });

  it("isolation is real: repeatable read keeps its snapshot, read committed sees concurrent commits", async () => {
    await owner.query(`INSERT INTO test_fixtures.transaction_probe (id, label, counter) VALUES ($1, 'x', 1)`, [
      uuid(1),
    ]);

    const observe = (isolationLevel: "read-committed" | "repeatable-read") =>
      unitOfWork.run(
        async (scope) => {
          const before = (await findProbe(scope, uuid(1)))?.counter;
          await owner.query(`UPDATE test_fixtures.transaction_probe SET counter = counter + 1 WHERE id = $1`, [
            uuid(1),
          ]);
          const after = (await findProbe(scope, uuid(1)))?.counter;
          return { before, after };
        },
        { isolationLevel },
      );

    expect(await observe("repeatable-read")).toEqual({ before: 1, after: 1 });
    expect(await observe("read-committed")).toEqual({ before: 2, after: 3 });
  });

  // Classic write skew: each transaction reads both rows, then writes the row the other read.
  async function writeSkew(uow: UnitOfWork) {
    await owner.query(
      `INSERT INTO test_fixtures.transaction_probe (id, label, counter) VALUES ($1, 'a', 0), ($2, 'b', 0)`,
      [uuid(1), uuid(2)],
    );
    const bothRead = { a: gate(), b: gate() };
    let attempts = 0;
    const skew = (self: "a" | "b", readFirst: string, write: string) =>
      uow.run(
        async (scope) => {
          attempts += 1;
          await findProbe(scope, readFirst);
          await findProbe(scope, write);
          bothRead[self].open();
          await Promise.all([bothRead.a.opened, bothRead.b.opened]);
          await setProbeCounter(scope, write, 1);
        },
        { isolationLevel: "serializable" },
      );
    const results = await Promise.allSettled([skew("a", uuid(2), uuid(1)), skew("b", uuid(1), uuid(2))]);
    return { results, attempts };
  }

  it("serializable aborts one of two conflicting transactions (SQLSTATE 40001); without retry it is CONCURRENT_MODIFICATION", async () => {
    const noRetry = new PrismaUnitOfWork(client, { maxWaitMs: 5_000, timeoutMs: 15_000, maxAttempts: 1 });
    const { results, attempts } = await writeSkew(noRetry);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(attempts).toBe(2);
    const reason = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(ConcurrentModificationError);
    expect(sqlStateOf(reason.cause)).toBe("40001");
  });

  it("with the default retry policy the aborted transaction re-runs and both commit", async () => {
    const { results, attempts } = await writeSkew(unitOfWork);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(attempts).toBe(3);
    const { rows } = await owner.query<{ counter: number }>(
      `SELECT counter FROM test_fixtures.transaction_probe ORDER BY id`,
    );
    expect(rows.map((row) => row.counter)).toEqual([1, 1]);
  });
});
