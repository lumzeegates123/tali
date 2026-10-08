import {
  ConcurrentModificationError,
  ConflictError,
  InsufficientStockError,
  ValidationError,
  VersionConflictError,
} from "@tali/application";
import type { CatalogProduct } from "@tali/domain";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseRepositories } from "../../src/database.js";
import { readInventoryConsistency, readInventorySnapshot, readTenancySnapshot } from "../../src/testing/index.js";
import { delay, gate } from "../support/harness.js";
import { type InventoryTenant, inventoryProduct, inventoryTenant, rejection } from "../support/inventory.js";
import { appPool } from "../support/pg.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * Build 2 Slice 5 concurrency over PostgreSQL with the real unit of work
 * (ADR-008 sections 8 and 9; plan section U). Races are either run freely and
 * judged by their outcome, or forced with a gate inside a repository call and
 * observed through pg_stat_activity and pg_locks, so a passing test cannot be
 * an accident of timing. Every scenario leaves the ledger consistent.
 */
describe("inventory concurrency (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  const probe = appPool();
  afterAll(() => probe.end());

  let tenancy: Tenancy;
  let a: InventoryTenant;
  let rice: CatalogProduct;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const piece = (product: CatalogProduct, quantityMinor: string) => ({
    variantId: product.variant.id,
    quantityMinor,
    unit: "PIECE",
  });
  const receive = (lines: readonly ReturnType<typeof piece>[], using: Tenancy = tenancy) =>
    using.postGoodsReceipt.execute(a.context, { lines, idempotencyKey: key() });
  const writeOff = (lines: readonly ReturnType<typeof piece>[], idempotencyKey = key(), using: Tenancy = tenancy) =>
    using.recordWriteOff.execute(a.context, { lines, reasonCode: "THEFT_OR_LOSS", idempotencyKey });

  async function onHand(product: CatalogProduct): Promise<string | undefined> {
    const { balances } = await readInventorySnapshot();
    return balances.find((row) => row.variantId === product.variant.id)?.quantityText;
  }

  /** A repository decorator that stops after one method's work, inside the caller's transaction, until released. */
  function pauseAfter<T extends object>(repository: T, method: keyof T & string) {
    const reached = gate();
    const release = gate();
    let calls = 0;
    const original = repository[method] as (...args: unknown[]) => Promise<unknown>;
    const wrapped: T = {
      ...repository,
      async [method](...args: unknown[]) {
        const result = await original.apply(repository, args);
        calls += 1;
        reached.open();
        await release.opened;
        return result;
      },
    };
    return { wrapped, reached: reached.opened, release: release.open, calls: () => calls };
  }

  const decorated = (decorate: Partial<DatabaseRepositories>, settings = {}) =>
    harness.compose({ decorate, unitOfWork: harness.unitOfWorkWith(settings) });

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

  async function settledPair<T>(first: Promise<T>, second: Promise<T>) {
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    return { fulfilled, rejected };
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "inventory-races");
    rice = await inventoryProduct(harness, a, { name: "Rice", stockUnit: "KG" });
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  it("1. simultaneous decrements: exactly one succeeds and stock never goes below zero", async () => {
    await receive([piece(sugar, "10"), piece(beans, "10")]);
    const writeOffs = await settledPair(writeOff([piece(sugar, "6")]), writeOff([piece(sugar, "6")]));
    expect(writeOffs.fulfilled).toHaveLength(1);
    expect(writeOffs.rejected).toEqual([expect.any(InsufficientStockError)]);
    expect(await onHand(sugar)).toBe("4");

    const adjustment = tenancy.recordAdjustment.execute(a.context, {
      lines: [{ ...piece(beans, "6"), direction: "DECREASE" }],
      reasonCode: "DATA_ENTRY_CORRECTION",
      idempotencyKey: key(),
    });
    const mixed = await settledPair<unknown>(adjustment, writeOff([piece(beans, "6")]));
    expect(mixed.fulfilled).toHaveLength(1);
    expect(mixed.rejected).toEqual([expect.any(InsufficientStockError)]);
    expect(await onHand(beans)).toBe("4");

    const top = await receive([piece(sugar, "6")]);
    const reversal = tenancy.reverseGoodsReceipt.execute(a.context, { documentId: top.document.id, reason: "Return" });
    const reversalRace = await settledPair<unknown>(reversal, writeOff([piece(sugar, "6")]));
    expect(reversalRace.fulfilled).toHaveLength(1);
    expect(reversalRace.rejected).toEqual([expect.any(InsufficientStockError)]);
    expect(await onHand(sugar)).toBe("4");
  });

  describe("2. opposite-order multi-line documents", () => {
    it("repository level: the second locker waits for the first and never deadlocks (single attempt)", async () => {
      const single = harness.unitOfWorkWith({ maxAttempts: 1 });
      const both = [beans.variant.id, sugar.variant.id];
      await single.run((scope) =>
        repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set(both)),
      );
      const locked = gate();
      const release = gate();
      const first = single.run(async (scope) => {
        await repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set([...both].reverse()));
        locked.open();
        await release.opened;
      });
      await locked.opened;
      const second = single.run((scope) =>
        repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set(both)),
      );
      await blockedOn("inventory_balances");
      release.open();
      await first;
      expect((await second).balances.map((balance) => balance.variantId)).toEqual([...both].sort());
    });

    it("use-case level: 20 concurrent receipt pairs with reversed line orders all succeed on a single attempt", async () => {
      const single = harness.compose({ unitOfWork: harness.unitOfWorkWith({ maxAttempts: 1 }) });
      const receipts = Array.from({ length: 20 }, () => [
        receive([piece(beans, "1"), piece(sugar, "1")], single),
        receive([piece(sugar, "1"), piece(beans, "1")], single),
      ]).flat();
      const results = await Promise.allSettled(receipts);
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      expect(await onHand(beans)).toBe("40");
      expect(await onHand(sugar)).toBe("40");
    });
  });

  describe("3. archive versus receipt", () => {
    it("a receipt waits for an archive holding the variant, then gets CONFLICT", async () => {
      const pause = pauseAfter(repos.products, "update");
      const archiving = decorated({ products: pause.wrapped }).archiveProduct.execute(a.context, {
        productId: sugar.product.id,
        expectedVersion: 1,
      });
      await pause.reached;
      const receipt = receive([piece(sugar, "1")]);
      await blockedOn("product_variants");
      pause.release();
      await archiving;
      expect(await rejection(receipt)).toBeInstanceOf(ConflictError);
      expect((await readInventorySnapshot()).movements).toEqual([]);
    });

    it("an archive cannot take a variant held FOR SHARE by stock entry until it is released", async () => {
      const locked = gate();
      const release = gate();
      const holder = harness.unitOfWork.run(async (scope) => {
        await repos.products.lockVariantsForShare(scope, a.businessId, new Set([sugar.variant.id]));
        locked.open();
        await release.opened;
      });
      await locked.opened;
      const impatient = harness.compose({ unitOfWork: harness.unitOfWorkWith({ lockTimeoutMs: 200, maxAttempts: 1 }) });
      expect(
        await rejection(
          impatient.archiveProduct.execute(a.context, { productId: sugar.product.id, expectedVersion: 1 }),
        ),
      ).toBeInstanceOf(ConcurrentModificationError);
      release.open();
      await holder;
      const archived = await tenancy.archiveProduct.execute(a.context, {
        productId: sugar.product.id,
        expectedVersion: 1,
      });
      expect(archived.item.product.status).toBe("ARCHIVED");
    });
  });

  describe("4. concurrent initial threshold", () => {
    const setFirst = (using: Tenancy = tenancy) =>
      using.setLowStockThreshold.execute(a.context, {
        variantId: rice.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "500", unit: "KG" },
      });

    it("two expectedVersion=0 sets: one creates version 1, the other is VERSION_CONFLICT", async () => {
      const race = await settledPair(setFirst(), setFirst());
      expect(race.fulfilled).toEqual([expect.objectContaining({ changed: true, version: 1 })]);
      expect(race.rejected).toEqual([expect.any(VersionConflictError)]);
      expect((await readInventorySnapshot()).thresholds).toHaveLength(1);
    });

    it("forced: the second creator blocks on ON CONFLICT, then gets VERSION_CONFLICT", async () => {
      const pause = pauseAfter(repos.inventoryThresholds, "insertIfAbsent");
      const first = setFirst(decorated({ inventoryThresholds: pause.wrapped }));
      await pause.reached;
      const second = setFirst();
      await blockedOn("inventory_stock_thresholds");
      pause.release();
      expect(await first).toMatchObject({ changed: true, version: 1 });
      expect(await rejection(second)).toBeInstanceOf(VersionConflictError);
      expect((await readInventorySnapshot()).thresholds).toHaveLength(1);
    });
  });

  it("5. two concurrent reversals of one receipt: one reverses, the other is a no-op", async () => {
    const received = await receive([piece(sugar, "3"), piece(beans, "2")]);
    const reverse = () =>
      tenancy.reverseGoodsReceipt.execute(a.context, { documentId: received.document.id, reason: "Wrong delivery" });
    const results = await Promise.all([reverse(), reverse()]);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    const { inventory, audit } = {
      inventory: await readInventorySnapshot(),
      audit: (await readTenancySnapshot()).businessAudit,
    };
    expect(inventory.movements.filter((row) => row.reversesMovementId !== null)).toHaveLength(2);
    expect(audit.filter((row) => row.action === "inventory.receipt_reversed")).toHaveLength(1);
    expect(inventory.balances.map((row) => row.quantityText)).toEqual(["0", "0"]);
  });

  describe("6 and 7. same-key concurrent commands", () => {
    it("case A: concurrent RecordOpeningStock with one key records one batch and replays the other", async () => {
      const command = { lines: [piece(sugar, "8"), piece(beans, "5")], idempotencyKey: key() };
      const results = await Promise.all([0, 1].map(() => tenancy.recordOpeningStock.execute(a.context, command)));
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.document).toEqual(results[1]?.document);
      const inventory = await readInventorySnapshot();
      const { businessAudit, businessIdempotency } = await readTenancySnapshot();
      expect(inventory.openingBatches).toHaveLength(1);
      expect(inventory.movements.filter((row) => row.type === "OPENING")).toHaveLength(2);
      expect(businessAudit.filter((row) => row.action === "inventory.opening_recorded")).toHaveLength(1);
      expect(businessIdempotency).toHaveLength(1);
    });

    it("case B: concurrent RecordWriteOff with one key removes the stock once, and the replay is not INSUFFICIENT_STOCK", async () => {
      await receive([piece(sugar, "10")]);
      const idempotencyKey = key();
      const results = await Promise.all([0, 1].map(() => writeOff([piece(sugar, "6")], idempotencyKey)));
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(await onHand(sugar)).toBe("4");
      const inventory = await readInventorySnapshot();
      expect(inventory.movements.filter((row) => row.type === "WRITE_OFF")).toHaveLength(1);
      const { businessAudit } = await readTenancySnapshot();
      expect(businessAudit.filter((row) => row.action === "inventory.written_off")).toHaveLength(1);
    });
  });

  describe("8. forced interleaving of same-key requests", () => {
    async function interleave<T extends { readonly replayed: boolean }>(
      run: (using: Tenancy) => Promise<T>,
    ): Promise<readonly [T, T]> {
      const pause = pauseAfter(repos.inventoryBalances, "lockForUpdate");
      const using = decorated({ inventoryBalances: pause.wrapped });
      const first = run(using);
      await pause.reached;
      const second = run(using);
      const blocked = await blockedOn("business_idempotency_records");
      const held = await relationsLockedBy(blocked);
      expect(held).not.toContain("inventory_balances");
      expect(held).not.toContain("product_variants");
      expect(pause.calls()).toBe(1);
      pause.release();
      const results = [await first, await second] as const;
      expect(pause.calls()).toBe(1);
      expect(results.map((result) => result.replayed)).toEqual([false, true]);
      return results;
    }

    it("case A: the second opening waits on the claimed key, takes no stock lock, and replays", async () => {
      const command = { lines: [piece(sugar, "8"), piece(beans, "5")], idempotencyKey: key() };
      const [original, replay] = await interleave((using) => using.recordOpeningStock.execute(a.context, command));
      expect(replay).toEqual({ ...original, replayed: true });
      expect((await readInventorySnapshot()).movements).toHaveLength(2);
    });

    it("case B: the second write-off waits on the claimed key, takes no stock lock, and replays", async () => {
      await receive([piece(sugar, "10")]);
      const idempotencyKey = key();
      const [original, replay] = await interleave((using) => writeOff([piece(sugar, "6")], idempotencyKey, using));
      expect(replay).toEqual({ ...original, replayed: true });
      expect(await onHand(sugar)).toBe("4");
    });
  });

  it("9. a rolled-back claim leaves nothing behind, and the same key later runs fresh", async () => {
    await receive([piece(sugar, "10")]);
    const idempotencyKey = key();
    const before = { inventory: await readInventorySnapshot(), tenancy: await readTenancySnapshot() };
    expect(await rejection(writeOff([piece(sugar, "11")], idempotencyKey))).toBeInstanceOf(InsufficientStockError);
    const after = { inventory: await readInventorySnapshot(), tenancy: await readTenancySnapshot() };
    expect(after.inventory).toEqual(before.inventory);
    expect(after.tenancy.businessIdempotency).toEqual(before.tenancy.businessIdempotency);
    expect(after.tenancy.businessAudit).toEqual(before.tenancy.businessAudit);
    await receive([piece(sugar, "5")]);
    const retried = await writeOff([piece(sugar, "11")], idempotencyKey);
    expect(retried.replayed).toBe(false);
    expect(await onHand(sugar)).toBe("4");
  });

  describe("extras", () => {
    const changeUnit = () =>
      tenancy.updateProduct.execute(a.context, { productId: rice.product.id, expectedVersion: 1, stockUnit: "G" });
    const setThreshold = (using: Tenancy = tenancy) =>
      using.setLowStockThreshold.execute(a.context, {
        variantId: rice.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "500", unit: "KG" },
      });

    it("a unit change racing a threshold set: the threshold commits first, so the unit change is rejected", async () => {
      const pause = pauseAfter(repos.inventoryThresholds, "insertIfAbsent");
      const setting = setThreshold(decorated({ inventoryThresholds: pause.wrapped }));
      await pause.reached;
      const changing = changeUnit();
      await blockedOn("product_variants");
      pause.release();
      expect(await setting).toMatchObject({ changed: true });
      expect(await rejection(changing)).toBeInstanceOf(ConflictError);
    });

    it("a threshold set racing a unit change: the unit change commits first, so the threshold is rejected", async () => {
      const pause = pauseAfter(repos.products, "update");
      const changing = decorated({ products: pause.wrapped }).updateProduct.execute(a.context, {
        productId: rice.product.id,
        expectedVersion: 1,
        stockUnit: "G",
      });
      await pause.reached;
      const setting = setThreshold();
      await blockedOn("product_variants");
      pause.release();
      expect((await changing).item.variant.stockUnit).toBe("G");
      expect(await rejection(setting)).toBeInstanceOf(ValidationError);
      expect((await readInventorySnapshot()).thresholds).toEqual([]);
    });

    it("a lock timeout writes nothing", async () => {
      await receive([piece(sugar, "10")]);
      const locked = gate();
      const release = gate();
      const holder = harness.unitOfWork.run(async (scope) => {
        await repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set([sugar.variant.id]));
        locked.open();
        await release.opened;
      });
      await locked.opened;
      const before = { inventory: await readInventorySnapshot(), tenancy: await readTenancySnapshot() };
      const impatient = harness.compose({ unitOfWork: harness.unitOfWorkWith({ lockTimeoutMs: 200, maxAttempts: 1 }) });
      expect(await rejection(writeOff([piece(sugar, "1")], key(), impatient))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      expect(await readInventorySnapshot()).toEqual(before.inventory);
      expect((await readTenancySnapshot()).businessIdempotency).toEqual(before.tenancy.businessIdempotency);
      expect((await readTenancySnapshot()).businessAudit).toEqual(before.tenancy.businessAudit);
      release.open();
      await holder;
    });
  });
});
