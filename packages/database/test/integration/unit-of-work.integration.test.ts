import type { TransactionScope } from "@tali/application";
import { describeUnitOfWorkContract } from "@tali/application/testing/contracts";
import { describe, expect, it } from "vitest";
import { findProbe, insertProbe } from "../support/fixture-repositories.js";
import { gate, useFixtureHarness, uuid } from "../support/harness.js";

const harness = useFixtureHarness();
const { unitOfWork, owner } = harness;

describeUnitOfWorkContract("PrismaUnitOfWork (PostgreSQL)", () => unitOfWork);

describe("PrismaUnitOfWork", () => {
  const count = async () =>
    Number((await owner.query<{ n: string }>("SELECT count(*) AS n FROM test_fixtures.transaction_probe")).rows[0]?.n);

  it("a nested run joins the outer transaction: an outer failure rolls back the inner writes", async () => {
    let innerScope: TransactionScope | undefined;
    let outerScope: TransactionScope | undefined;
    await expect(
      unitOfWork.run(async (outer) => {
        outerScope = outer;
        await insertProbe(outer, uuid(1), "outer");
        await unitOfWork.run(async (inner) => {
          innerScope = inner;
          await insertProbe(inner, uuid(2), "inner (nested use case)");
        });
        throw new Error("outer fails after the nested use case succeeded");
      }),
    ).rejects.toThrow("outer fails");
    expect(innerScope).toBe(outerScope);
    expect(await count()).toBe(0);
  });

  it("a nested run sees the outer transaction's uncommitted writes and commits with it", async () => {
    await unitOfWork.run(async (outer) => {
      await insertProbe(outer, uuid(1), "outer");
      const seen = await unitOfWork.run((inner) => findProbe(inner, uuid(1)));
      expect(seen?.label).toBe("outer");
    });
    expect(await count()).toBe(1);
  });

  it("a nested run may not raise the isolation level", async () => {
    await expect(
      unitOfWork.run(async () => unitOfWork.run(async () => "never", { isolationLevel: "serializable" })),
    ).rejects.toThrow(/cannot raise isolation/);
    await expect(
      unitOfWork.run(async () => unitOfWork.run(async () => "ok", { isolationLevel: "read-committed" }), {
        isolationLevel: "serializable",
      }),
    ).resolves.toBe("ok");
  });

  it("independent concurrent runs are separate transactions", async () => {
    const written = gate();
    const release = gate();
    const first = unitOfWork.run(async (scope) => {
      await insertProbe(scope, uuid(1), "first");
      written.open();
      await release.opened;
      throw new Error("first rolls back");
    });
    await written.opened;
    await unitOfWork.run((scope) => insertProbe(scope, uuid(2), "second"));
    release.open();
    await expect(first).rejects.toThrow("first rolls back");
    expect(await count()).toBe(1);
  });

  it("a scope cannot be used after its transaction has finished", async () => {
    let leaked: TransactionScope | undefined;
    await unitOfWork.run(async (scope) => {
      leaked = scope;
    });
    await expect(insertProbe(leaked as TransactionScope, uuid(1), "late")).rejects.toThrow(
      /not an open PrismaUnitOfWork transaction/,
    );
  });

  it("a scope from another unit of work implementation is rejected", async () => {
    const foreign = Object.freeze({}) as unknown as TransactionScope;
    await expect(insertProbe(foreign, uuid(1), "foreign")).rejects.toThrow(/not an open PrismaUnitOfWork transaction/);
  });

  it("a transaction exceeding its timeout is aborted and rolled back", async () => {
    const { PrismaUnitOfWork } = await import("../../src/unit-of-work/prisma-unit-of-work.js");
    const short = new PrismaUnitOfWork(harness.client, { maxWaitMs: 2_000, timeoutMs: 300 });
    await expect(
      short.run(async (scope) => {
        await insertProbe(scope, uuid(1), "slow");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await insertProbe(scope, uuid(2), "after timeout");
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });
});
