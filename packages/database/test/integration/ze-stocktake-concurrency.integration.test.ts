import { ConflictError, StocktakeStaleError, VersionConflictError } from "@tali/application";
import type { CatalogProduct, StocktakeId } from "@tali/domain";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseRepositories } from "../../src/database.js";
import { readInventoryConsistency, readInventorySnapshot, readTenancySnapshot } from "../../src/testing/index.js";
import { delay, gate } from "../support/harness.js";
import { type InventoryTenant, inventoryProduct, inventoryTenant, rejection } from "../support/inventory.js";
import { appPool } from "../support/pg.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * Build 2 Slice 6 stocktake concurrency over PostgreSQL with the real unit of
 * work (ADR-008 section 12; Slice 6 plan W4). Races are forced with a gate
 * inside one side's repository call and observed through pg_stat_activity
 * and pg_locks, or run freely on a single-attempt unit of work so that a
 * deadlock could not be hidden by a retry. Every scenario leaves the ledger
 * consistent.
 */
describe("stocktake concurrency (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  const probe = appPool();
  afterAll(() => probe.end());

  let tenancy: Tenancy;
  let a: InventoryTenant;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const piece = (product: CatalogProduct, quantityMinor: string) => ({
    variantId: product.variant.id,
    quantityMinor,
    unit: "PIECE",
  });
  const pieces = (quantityMinor: string) => ({ quantityMinor, unit: "PIECE" });
  const receive = (lines: readonly ReturnType<typeof piece>[], using: Tenancy = tenancy) =>
    using.postGoodsReceipt.execute(a.context, { lines, idempotencyKey: key() });
  const adjust = (lines: readonly ReturnType<typeof piece>[], using: Tenancy = tenancy) =>
    using.recordAdjustment.execute(a.context, {
      lines: lines.map((line) => ({ ...line, direction: "INCREASE" as const })),
      reasonCode: "FOUND_STOCK",
      idempotencyKey: key(),
    });
  const start = async (using: Tenancy = tenancy, idempotencyKey = key()) =>
    (await using.createStocktake.execute(a.context, { idempotencyKey })).stocktake.stocktakeId;
  const count = (
    stocktakeId: StocktakeId,
    product: CatalogProduct,
    quantityMinor: string,
    expectedVersion?: number,
    using: Tenancy = tenancy,
  ) =>
    using.recordStocktakeCount.execute(a.context, {
      stocktakeId,
      variantId: product.variant.id,
      count: pieces(quantityMinor),
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  const versionOf = async (stocktakeId: StocktakeId) =>
    (await tenancy.getStocktake.execute(a.context, { stocktakeId })).version;
  const post = (stocktakeId: StocktakeId, expectedVersion: number, using: Tenancy = tenancy) =>
    using.postStocktake.execute(a.context, { stocktakeId, expectedVersion });
  const cancel = (stocktakeId: StocktakeId, expectedVersion: number, using: Tenancy = tenancy) =>
    using.cancelStocktake.execute(a.context, { stocktakeId, expectedVersion });
  const statusOf = async (stocktakeId: StocktakeId) =>
    (await tenancy.getStocktake.execute(a.context, { stocktakeId })).status;

  async function onHand(product: CatalogProduct): Promise<string | undefined> {
    const { balances } = await readInventorySnapshot();
    return balances.find((row) => row.variantId === product.variant.id)?.quantityText;
  }

  async function corrections() {
    return (await readInventorySnapshot()).movements.filter((row) => row.type === "COUNT_CORRECTION");
  }

  /** A repository decorator that stops after one method's work, inside the caller's transaction, until released. */
  function pauseAfter<T extends object>(repository: T, method: keyof T & string) {
    const reached = gate();
    const release = gate();
    const original = repository[method] as (...args: unknown[]) => Promise<unknown>;
    const wrapped: T = {
      ...repository,
      async [method](...args: unknown[]) {
        const result = await original.apply(repository, args);
        reached.open();
        await release.opened;
        return result;
      },
    };
    return { wrapped, reached: reached.opened, release: release.open };
  }

  const decorated = (decorate: Partial<DatabaseRepositories>) =>
    harness.compose({ decorate, unitOfWork: harness.unitOfWorkWith({ maxAttempts: 1 }) });

  /** The PID of the one backend blocked on a heavyweight lock while running a statement that mentions `text`. */
  async function blockedOn(text: string): Promise<number> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const { rows } = await probe.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%${text}%`],
      );
      if (rows.length === 1 && rows[0] !== undefined) return rows[0].pid;
      await delay(20);
    }
    throw new Error(`no backend is blocked on a statement mentioning ${text}`);
  }

  async function relationsLockedBy(pid: number): Promise<string[]> {
    const { rows } = await probe.query<{ relname: string }>(
      `SELECT DISTINCT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
       WHERE l.pid = $1 AND l.granted ORDER BY c.relname`,
      [pid],
    );
    return rows.map((row) => row.relname);
  }

  /** Nothing is waiting on a lock: the other side ran to completion without blocking. */
  async function nobodyBlocked(): Promise<void> {
    const { rows } = await probe.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    expect(rows[0]?.waiting).toBe(0);
  }

  async function settledPair<T>(first: Promise<T>, second: Promise<T>) {
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    return { fulfilled, rejected };
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "stocktake-races");
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
    await receive([piece(beans, "10"), piece(sugar, "10")]);
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  describe("1. counter versus counter", () => {
    it("two recounts from the same line version: one wins, the other is VERSION_CONFLICT", async () => {
      const id = await start();
      await count(id, beans, "5");
      const single = harness.compose({ unitOfWork: harness.unitOfWorkWith({ maxAttempts: 1 }) });
      const race = await settledPair(count(id, beans, "6", 1, single), count(id, beans, "7", 1, single));
      expect(race.fulfilled.map((result) => result.line.version)).toEqual([2]);
      expect(race.rejected).toEqual([expect.any(VersionConflictError)]);
      const [line] = (await readInventorySnapshot()).stocktakeLines;
      expect(line).toMatchObject({ version: 2 });
    });

    it("forced: the second recounter waits on the stocktake row, then is VERSION_CONFLICT", async () => {
      const id = await start();
      await count(id, beans, "5");
      const pause = pauseAfter(repos.stocktakeLines, "update");
      const first = count(id, beans, "6", 1, decorated({ stocktakeLines: pause.wrapped }));
      await pause.reached;
      const second = count(id, beans, "7", 1);
      await blockedOn("FROM stocktakes");
      pause.release();
      expect((await first).line.version).toBe(2);
      expect(await rejection(second)).toBeInstanceOf(VersionConflictError);
    });

    async function firstCountSettled(id: StocktakeId, before: { movements: number; audit: number }) {
      const after = await readInventorySnapshot();
      expect(after.stocktakeLines).toHaveLength(1);
      expect(after.stocktakeLines[0]).toMatchObject({ version: 1 });
      expect(await versionOf(id)).toBe(2);
      expect(after.movements).toHaveLength(before.movements);
      expect((await readTenancySnapshot()).businessAudit).toHaveLength(before.audit);
    }

    const firstCountBaseline = async () => ({
      movements: (await readInventorySnapshot()).movements.length,
      audit: (await readTenancySnapshot()).businessAudit.length,
    });

    it("two first counts of one variant: one creates the line, the other is VERSION_CONFLICT", async () => {
      const id = await start();
      const before = await firstCountBaseline();
      const single = harness.compose({ unitOfWork: harness.unitOfWorkWith({ maxAttempts: 1 }) });
      const race = await settledPair(
        count(id, beans, "6", undefined, single),
        count(id, beans, "7", undefined, single),
      );
      expect(race.fulfilled.map((result) => result.line.version)).toEqual([1]);
      expect(race.rejected).toEqual([expect.any(VersionConflictError)]);
      await firstCountSettled(id, before);
    });

    it("forced: the second first count waits on the stocktake row, then sees the new line and is VERSION_CONFLICT", async () => {
      const id = await start();
      const before = await firstCountBaseline();
      const pause = pauseAfter(repos.stocktakeLines, "insert");
      const first = count(id, beans, "6", undefined, decorated({ stocktakeLines: pause.wrapped }));
      await pause.reached;
      const second = count(id, beans, "7", undefined, decorated({}));
      const waiting = await blockedOn("FROM stocktakes");
      expect(await relationsLockedBy(waiting)).not.toContain("stocktake_lines");
      pause.release();
      expect((await first).line.version).toBe(1);
      expect(await rejection(second)).toBeInstanceOf(VersionConflictError);
      await firstCountSettled(id, before);
    });
  });

  describe("2. count versus receipt", () => {
    it("a receipt still open while counting: the count does not wait, records the committed balance, and the post is STOCKTAKE_STALE", async () => {
      const id = await start();
      const pause = pauseAfter(repos.inventoryBalances, "apply");
      const receipt = receive([piece(beans, "3")], decorated({ inventoryBalances: pause.wrapped }));
      await pause.reached;
      const counted = await count(id, beans, "10");
      expect(counted.line.visibility === "FULL" ? counted.line.expectedAtCount.amountMinor : undefined).toBe(10n);
      pause.release();
      await receipt;
      const before = await readInventorySnapshot();
      expect(await rejection(post(id, await versionOf(id)))).toBeInstanceOf(StocktakeStaleError);
      expect(await readInventorySnapshot()).toEqual(before);
      expect(await statusOf(id)).toBe("DRAFT");
    });

    it("a count still open while receiving: the receipt does not wait, and the post is STOCKTAKE_STALE", async () => {
      const id = await start();
      const pause = pauseAfter(repos.stocktakeLines, "insert");
      const counting = count(id, beans, "10", undefined, decorated({ stocktakeLines: pause.wrapped }));
      await pause.reached;
      await receive([piece(beans, "3")]);
      await nobodyBlocked();
      pause.release();
      await counting;
      expect(await rejection(post(id, await versionOf(id)))).toBeInstanceOf(StocktakeStaleError);
      expect(await onHand(beans)).toBe("13");
    });

    it("a receipt committed before counting is part of the expected quantity, and the post corrects from it", async () => {
      const id = await start();
      await receive([piece(beans, "3")]);
      await count(id, beans, "12");
      const result = await post(id, await versionOf(id));
      expect(result.movements.map((m) => m.delta.amountMinor)).toEqual([-1n]);
      expect(await onHand(beans)).toBe("12");
    });
  });

  describe("3 and 4. post versus receipt or adjustment", () => {
    for (const [name, move] of [
      ["receipt", receive],
      ["adjustment", adjust],
    ] as const) {
      it(`post holds the balances: the ${name} waits, then applies on the corrected balance`, async () => {
        const id = await start();
        await count(id, beans, "7");
        const pause = pauseAfter(repos.inventoryBalances, "lockForUpdate");
        const posting = post(id, await versionOf(id), decorated({ inventoryBalances: pause.wrapped }));
        await pause.reached;
        const moving = move([piece(beans, "2")]);
        const waiter = await blockedOn("inventory_balances");
        expect(await relationsLockedBy(waiter)).not.toContain("stocktakes");
        pause.release();
        expect((await posting).movements.map((m) => m.delta.amountMinor)).toEqual([-3n]);
        await moving;
        expect(await onHand(beans)).toBe("9");
      });

      it(`the ${name} holds the balances: the post waits, then is STOCKTAKE_STALE and writes nothing`, async () => {
        const id = await start();
        await count(id, beans, "7");
        await count(id, sugar, "10");
        const version = await versionOf(id);
        const pause = pauseAfter(repos.inventoryBalances, "lockForUpdate");
        const moving = move([piece(beans, "2")], decorated({ inventoryBalances: pause.wrapped }));
        await pause.reached;
        const posting = post(id, version);
        await blockedOn("inventory_balances");
        pause.release();
        await moving;
        const error = await rejection(posting);
        expect(error).toBeInstanceOf(StocktakeStaleError);
        expect((error as StocktakeStaleError).staleVariantIds).toEqual([beans.variant.id]);
        expect(await statusOf(id)).toBe("DRAFT");
        expect(await corrections()).toEqual([]);
        expect(await onHand(beans)).toBe("12");
      });
    }
  });

  it("5. post versus post: one posts, the other is a no-op, and the corrections are written once", async () => {
    const id = await start();
    await count(id, beans, "7");
    await count(id, sugar, "12");
    const version = await versionOf(id);
    const results = await Promise.all([post(id, version), post(id, version)]);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(await corrections()).toHaveLength(2);
    const audit = (await readTenancySnapshot()).businessAudit.filter(
      (row) => row.action === "inventory.stocktake_posted",
    );
    expect(audit).toHaveLength(1);
    expect([await onHand(beans), await onHand(sugar)]).toEqual(["7", "12"]);
  });

  describe("6. post versus count", () => {
    it("post holds the stocktake: the count waits, then is CONFLICT on the POSTED stocktake", async () => {
      const id = await start();
      await count(id, beans, "7");
      const pause = pauseAfter(repos.stocktakes, "findByIdForUpdate");
      const posting = post(id, await versionOf(id), decorated({ stocktakes: pause.wrapped }));
      await pause.reached;
      const counting = count(id, sugar, "3");
      await blockedOn("FROM stocktakes");
      pause.release();
      expect((await posting).changed).toBe(true);
      expect(await rejection(counting)).toBeInstanceOf(ConflictError);
      expect((await readInventorySnapshot()).stocktakeLines).toHaveLength(1);
    });

    it("count holds the stocktake: the post waits, then is VERSION_CONFLICT and writes nothing", async () => {
      const id = await start();
      await count(id, beans, "7");
      const version = await versionOf(id);
      const pause = pauseAfter(repos.stocktakes, "findByIdForUpdate");
      const counting = count(id, sugar, "3", undefined, decorated({ stocktakes: pause.wrapped }));
      await pause.reached;
      const posting = post(id, version);
      await blockedOn("FROM stocktakes");
      pause.release();
      expect((await counting).stocktake.version).toBe(version + 1);
      expect(await rejection(posting)).toBeInstanceOf(VersionConflictError);
      expect(await statusOf(id)).toBe("DRAFT");
      expect(await corrections()).toEqual([]);
    });
  });

  describe("7. cancel versus post", () => {
    it("post first: the waiting cancel is CONFLICT", async () => {
      const id = await start();
      await count(id, beans, "7");
      const version = await versionOf(id);
      const pause = pauseAfter(repos.stocktakes, "findByIdForUpdate");
      const posting = post(id, version, decorated({ stocktakes: pause.wrapped }));
      await pause.reached;
      const cancelling = cancel(id, version);
      await blockedOn("FROM stocktakes");
      pause.release();
      expect((await posting).changed).toBe(true);
      expect(await rejection(cancelling)).toBeInstanceOf(ConflictError);
      expect(await statusOf(id)).toBe("POSTED");
    });

    it("cancel first: the waiting post is CONFLICT and writes no correction", async () => {
      const id = await start();
      await count(id, beans, "7");
      const version = await versionOf(id);
      const pause = pauseAfter(repos.stocktakes, "findByIdForUpdate");
      const cancelling = cancel(id, version, decorated({ stocktakes: pause.wrapped }));
      await pause.reached;
      const posting = post(id, version);
      await blockedOn("FROM stocktakes");
      pause.release();
      expect((await cancelling).changed).toBe(true);
      expect(await rejection(posting)).toBeInstanceOf(ConflictError);
      expect(await corrections()).toEqual([]);
      expect(await onHand(beans)).toBe("10");
    });
  });

  describe("8. create versus create", () => {
    it("free race with two keys: one DRAFT, one CONFLICT, and no orphan idempotency record", async () => {
      const before = (await readTenancySnapshot()).businessIdempotency.length;
      const race = await settledPair(start(), start());
      expect(race.fulfilled).toHaveLength(1);
      expect(race.rejected).toEqual([expect.any(ConflictError)]);
      expect((await readInventorySnapshot()).stocktakes).toHaveLength(1);
      expect((await readTenancySnapshot()).businessIdempotency).toHaveLength(before + 1);
    });

    it("forced: the second insert waits on the one-DRAFT index, is CONFLICT, and its key runs fresh once the first is terminal", async () => {
      const before = (await readTenancySnapshot()).businessIdempotency.length;
      const pause = pauseAfter(repos.stocktakes, "insert");
      const first = start(decorated({ stocktakes: pause.wrapped }));
      await pause.reached;
      const secondKey = key();
      const second = start(tenancy, secondKey);
      await blockedOn("stocktakes");
      pause.release();
      const firstId = await first;
      expect(await rejection(second)).toBeInstanceOf(ConflictError);
      expect((await readTenancySnapshot()).businessIdempotency).toHaveLength(before + 1);
      expect(
        (await readTenancySnapshot()).businessAudit.filter((row) => row.action === "inventory.stocktake_started"),
      ).toHaveLength(1);

      await cancel(firstId, 1);
      const retried = await tenancy.createStocktake.execute(a.context, { idempotencyKey: secondKey });
      expect(retried).toMatchObject({ replayed: false, stocktake: { status: "DRAFT", version: 1 } });
      expect(retried.stocktake.stocktakeId).not.toBe(firstId);
    });
  });

  it("9. multi-line posts racing reverse-order receipts and adjustments never deadlock on a single attempt", async () => {
    const single = harness.compose({ unitOfWork: harness.unitOfWorkWith({ maxAttempts: 1 }) });
    let posted = 0;
    let stale = 0;
    for (let round = 0; round < 20; round += 1) {
      const id = await start(single);
      await count(id, beans, "10", undefined, single);
      await count(id, sugar, "10", undefined, single);
      const version = await versionOf(id);
      const reversed = [piece(sugar, "1"), piece(beans, "1")];
      const moving = round % 2 === 0 ? receive(reversed, single) : adjust(reversed, single);
      const [postResult, moveResult] = await Promise.allSettled([post(id, version, single), moving]);
      expect(moveResult.status).toBe("fulfilled");
      if (postResult.status === "fulfilled") {
        posted += 1;
      } else {
        expect(postResult.reason).toBeInstanceOf(StocktakeStaleError);
        stale += 1;
        await cancel(id, version, single);
      }
    }
    expect(posted + stale).toBe(20);
    const { movements } = await readInventorySnapshot();
    expect(movements.filter((row) => row.type === "COUNT_CORRECTION").length).toBeLessThanOrEqual(2 * posted);
  }, 120_000);
});
