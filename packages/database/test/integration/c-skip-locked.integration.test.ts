import { describe, expect, it } from "vitest";
import { claimJobs, type ClaimedJob } from "../support/fixture-repositories.js";
import { delay, gate, useFixtureHarness, uuid } from "../support/harness.js";

/** Criterion C: FOR UPDATE SKIP LOCKED batch claiming by concurrent workers. */
describe("C. FOR UPDATE SKIP LOCKED batch claiming", () => {
  const { unitOfWork, owner } = useFixtureHarness();

  const seedJobs = async (count: number) => {
    const values = Array.from({ length: count }, (_, index) => `('${uuid(index + 1)}', ${index + 1})`).join(", ");
    await owner.query(`INSERT INTO test_fixtures.job_claim (id, sequence) VALUES ${values}`);
  };

  it("a claim does not wait on rows locked by an in-flight claim; it takes the next unlocked rows", async () => {
    await seedJobs(10);
    const claimedA = gate();
    const release = gate();
    let batchA: ClaimedJob[] = [];

    const workerA = unitOfWork.run(async (scope) => {
      batchA = await claimJobs(scope, "worker-a", 4);
      claimedA.open();
      await release.opened;
    });
    await claimedA.opened;

    const started = performance.now();
    const batchB = await unitOfWork.run((scope) => claimJobs(scope, "worker-b", 4));
    const elapsed = performance.now() - started;

    release.open();
    await workerA;

    expect(batchA.map((job) => job.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(batchB.map((job) => job.sequence).sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("two concurrent workers drain the queue with no job claimed twice and none missed", async () => {
    const total = 200;
    await seedJobs(total);

    const drain = async (workerId: string): Promise<string[]> => {
      const claimed: string[] = [];
      for (;;) {
        const batch = await unitOfWork.run(async (scope) => {
          const jobs = await claimJobs(scope, workerId, 7);
          await delay(5); // hold locks briefly so the workers genuinely overlap
          return jobs;
        });
        if (batch.length === 0) return claimed;
        claimed.push(...batch.map((job) => job.id));
      }
    };

    const [a, b] = await Promise.all([drain("worker-a"), drain("worker-b")]);
    const overlap = a.filter((id) => new Set(b).has(id));

    expect(overlap).toEqual([]);
    expect(new Set([...a, ...b]).size).toBe(total);
    expect(a.length + b.length).toBe(total);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);

    const { rows } = await owner.query<{ claimed_by: string; n: string }>(
      `SELECT claimed_by, count(*) AS n FROM test_fixtures.job_claim GROUP BY claimed_by ORDER BY claimed_by`,
    );
    expect(rows).toEqual([
      { claimed_by: "worker-a", n: String(a.length) },
      { claimed_by: "worker-b", n: String(b.length) },
    ]);
  });

  it("a claim rolled back by a failing worker is released and claimable again", async () => {
    await seedJobs(3);
    await expect(
      unitOfWork.run(async (scope) => {
        await claimJobs(scope, "crashing-worker", 3);
        throw new Error("handler crashed");
      }),
    ).rejects.toThrow("handler crashed");
    const reclaimed = await unitOfWork.run((scope) => claimJobs(scope, "worker-b", 10));
    expect(reclaimed).toHaveLength(3);
  });
});
