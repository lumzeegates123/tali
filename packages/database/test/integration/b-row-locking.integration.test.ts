import { describe, expect, it } from "vitest";
import { lockProbe, lockProbeNoWait, setProbeCounter } from "../support/fixture-repositories.js";
import { delay, gate, useFixtureHarness, uuid } from "../support/harness.js";

/** Criterion B: SELECT ... FOR UPDATE inside an interactive transaction. */
describe("B. SELECT ... FOR UPDATE", () => {
  const { unitOfWork, owner } = useFixtureHarness();

  const seed = () =>
    owner.query(`INSERT INTO test_fixtures.transaction_probe (id, label, counter) VALUES ($1, 'locked', 0)`, [uuid(1)]);

  it("holds the row lock for the whole transaction: a NOWAIT lock attempt fails with 55P03", async () => {
    await seed();
    const locked = gate();
    const release = gate();
    const holder = unitOfWork.run(async (scope) => {
      await lockProbe(scope, uuid(1));
      locked.open();
      await release.opened;
    });
    await locked.opened;

    const contender = unitOfWork.run((scope) => lockProbeNoWait(scope, uuid(1)));
    await expect(contender).rejects.toThrow(/55P03|could not obtain lock|lock_not_available/i);

    release.open();
    await holder;
    await expect(unitOfWork.run((scope) => lockProbeNoWait(scope, uuid(1)))).resolves.toMatchObject({ id: uuid(1) });
  });

  it("a second FOR UPDATE blocks until the first transaction commits, then sees its write", async () => {
    await seed();
    const events: string[] = [];
    const locked = gate();

    const first = unitOfWork.run(async (scope) => {
      const row = await lockProbe(scope, uuid(1));
      locked.open();
      await delay(300);
      await setProbeCounter(scope, uuid(1), (row?.counter ?? 0) + 1);
      events.push("first-commit");
    });

    await locked.opened;
    const second = unitOfWork.run(async (scope) => {
      events.push("second-lock-requested");
      const row = await lockProbe(scope, uuid(1));
      events.push(`second-lock-acquired:counter=${row?.counter}`);
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["second-lock-requested", "first-commit", "second-lock-acquired:counter=1"]);
  });

  it("serializes concurrent read-modify-write: no lost updates across 10 concurrent increments", async () => {
    await seed();
    const increment = () =>
      unitOfWork.run(async (scope) => {
        const row = await lockProbe(scope, uuid(1));
        await delay(10);
        await setProbeCounter(scope, uuid(1), (row?.counter ?? 0) + 1);
      });
    await Promise.all(Array.from({ length: 10 }, increment));
    const { rows } = await owner.query<{ counter: number }>(
      `SELECT counter FROM test_fixtures.transaction_probe WHERE id = $1`,
      [uuid(1)],
    );
    expect(rows[0]?.counter).toBe(10);
  });
});
