import { InsufficientStockError, StocktakeStaleError } from "@tali/application";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseRepositories } from "../../src/database.js";
import { readInventoryConsistency, readLedgerConsistency, readSalesConsistency } from "../../src/testing/index.js";
import { delay, gate } from "../support/harness.js";
import { type InventoryTenant, inventoryTenant, rejection } from "../support/inventory.js";
import { appPool } from "../support/pg.js";
import { pricedProduct, reversalInput, type SaleProduct, saleInput, saleLine } from "../support/sales.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * ZV. Sales concurrency over PostgreSQL with the real unit of work (ADR-011
 * section 14; Plan 005 S5). A sale locks variants FOR SHARE, then balances,
 * then valuations, and takes the business receipt counter last; a reversal
 * locks the sale first, then the same stock rows. Races are forced with a
 * gate inside one side's repository call and observed through
 * pg_stat_activity and pg_locks, or run freely on a single-attempt unit of
 * work so that a deadlock could not be hidden by a retry. Every scenario
 * leaves the ledger, inventory and sales consistency checks clean.
 */
describe("ZV. sales concurrency (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  const probe = appPool();
  afterAll(() => probe.end());

  let tenancy: Tenancy;
  let a: InventoryTenant;
  let soap: SaleProduct;
  let salt: SaleProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const sell = (item: SaleProduct, quantity: string, using: Tenancy = tenancy) =>
    using.recordSale.execute(
      a.context,
      saleInput(harness, [saleLine(item, quantity)], (50_000n * BigInt(quantity)).toString()),
    );
  const reverse = (saleId: string, using: Tenancy = tenancy) =>
    using.reverseSale.execute(a.context, reversalInput(harness, saleId));
  const receive = (item: SaleProduct, quantityMinor: string, using: Tenancy = tenancy) =>
    using.postGoodsReceipt.execute(a.context, {
      lines: [
        {
          variantId: item.variantId,
          quantityMinor,
          unit: "PIECE",
          totalCost: { amountMinor: (40_000n * BigInt(quantityMinor)).toString(), currency: a.currency },
        },
      ],
      idempotencyKey: key(),
    });

  async function onHand(item: SaleProduct): Promise<string | undefined> {
    const { rows } = await harness.owner.query<{ quantity: string }>(
      `SELECT quantity_minor::text AS quantity FROM inventory_balances WHERE business_id = $1 AND variant_id = $2`,
      [a.businessId, item.variantId],
    );
    return rows[0]?.quantity;
  }

  async function saleCount(): Promise<number> {
    const { rows } = await harness.owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sales WHERE business_id = $1`,
      [a.businessId],
    );
    return rows[0]?.n ?? 0;
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

  const decorated = (decorate: Partial<DatabaseRepositories> = {}) =>
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

  /** The backend running a statement that mentions `text` and is not waiting on a lock (the paused side). */
  async function runningPid(text: string): Promise<number> {
    const { rows } = await probe.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND state = 'idle in transaction' AND query ILIKE $1`,
      [`%${text}%`],
    );
    expect(rows).toHaveLength(1);
    return rows[0]?.pid ?? 0;
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "sales-races");
    soap = await pricedProduct(harness, a, { name: "Soap", quantity: "10", totalCost: "350000" });
    salt = await pricedProduct(harness, a, { name: "Salt", quantity: "10", totalCost: "350000" });
  });

  afterEach(async () => {
    expect(await readLedgerConsistency()).toEqual([]);
    expect(await readInventoryConsistency()).toEqual([]);
    expect(await readSalesConsistency()).toEqual([]);
  });

  describe("1. sale versus sale of the same stock", () => {
    it("free race: 10 on hand, two sales of 7, one sells and the other is INSUFFICIENT_STOCK", async () => {
      const single = decorated();
      const results = await Promise.allSettled([sell(soap, "7", single), sell(soap, "7", single)]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toEqual([expect.any(InsufficientStockError)]);
      expect(await onHand(soap)).toBe("3");
      expect(await saleCount()).toBe(1);
    });

    it("forced: the second waits on the balance without holding the receipt counter, then is INSUFFICIENT_STOCK", async () => {
      const pause = pauseAfter(repos.salesInventory, "lockForSale");
      const first = sell(soap, "7", decorated({ salesInventory: pause.wrapped }));
      await pause.reached;
      const second = sell(soap, "7", decorated());
      const waiter = await blockedOn("inventory_balances");
      const held = await relationsLockedBy(waiter);
      expect(held).not.toContain("sale_receipt_sequences");
      expect(held).not.toContain("inventory_valuations");
      expect(await relationsLockedBy(await runningPid("inventory_valuations"))).not.toContain("sale_receipt_sequences");
      pause.release();
      expect((await first).sale.receiptNumber).toBe("S-000001");
      expect(await rejection(second)).toBeInstanceOf(InsufficientStockError);
      expect(await onHand(soap)).toBe("3");
    });
  });

  describe("2. sales of different stock share only the receipt counter", () => {
    it("forced: the second takes its own stock locks, then waits on the counter, and numbers follow commit order", async () => {
      expect((await sell(salt, "1")).sale.receiptNumber).toBe("S-000001");
      const pause = pauseAfter(repos.saleReceiptNumbers, "issue");
      const first = sell(soap, "1", decorated({ saleReceiptNumbers: pause.wrapped }));
      await pause.reached;
      const second = sell(salt, "1", decorated());
      const waiter = await blockedOn("sale_receipt_sequences");
      const held = await relationsLockedBy(waiter);
      expect(held).toContain("inventory_balances");
      expect(held).toContain("inventory_valuations");
      pause.release();
      expect((await first).sale.receiptNumber).toBe("S-000002");
      expect((await second).sale.receiptNumber).toBe("S-000003");
      expect([await onHand(soap), await onHand(salt)]).toEqual(["9", "8"]);
    });

    it("free race: many sales of two products get distinct consecutive receipts", async () => {
      const single = decorated();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => sell(index % 2 === 0 ? soap : salt, "1", single)),
      );
      expect(results.map((result) => result.sale.receiptNumber).sort()).toEqual(
        Array.from({ length: 8 }, (_, index) => `S-${String(index + 1).padStart(6, "0")}`),
      );
    });
  });

  describe("3. sale versus stocktake post", () => {
    async function countedStocktake(quantity: string) {
      const { stocktake } = await tenancy.createStocktake.execute(a.context, { idempotencyKey: key() });
      const counted = await tenancy.recordStocktakeCount.execute(a.context, {
        stocktakeId: stocktake.stocktakeId,
        variantId: soap.variantId,
        count: { quantityMinor: quantity, unit: "PIECE" },
      });
      return { stocktakeId: stocktake.stocktakeId, version: counted.stocktake.version };
    }

    it("sale first: the post waits on the balance, then is STOCKTAKE_STALE", async () => {
      const { stocktakeId, version } = await countedStocktake("7");
      const pause = pauseAfter(repos.salesInventory, "lockForSale");
      const selling = sell(soap, "2", decorated({ salesInventory: pause.wrapped }));
      await pause.reached;
      const posting = tenancy.postStocktake.execute(a.context, { stocktakeId, expectedVersion: version });
      await blockedOn("inventory_balances");
      pause.release();
      await selling;
      expect(await rejection(posting)).toBeInstanceOf(StocktakeStaleError);
      expect(await onHand(soap)).toBe("8");
    });

    it("post first: the sale waits on the balance, then sells from the corrected balance", async () => {
      const { stocktakeId, version } = await countedStocktake("7");
      const pause = pauseAfter(repos.inventoryBalances, "lockForUpdate");
      const posting = decorated({ inventoryBalances: pause.wrapped }).postStocktake.execute(a.context, {
        stocktakeId,
        expectedVersion: version,
      });
      await pause.reached;
      const selling = sell(soap, "2", decorated());
      const waiter = await blockedOn("inventory_balances");
      expect(await relationsLockedBy(waiter)).not.toContain("sale_receipt_sequences");
      pause.release();
      expect((await posting).changed).toBe(true);
      expect((await selling).sale.status).toBe("POSTED");
      expect(await onHand(soap)).toBe("5");
    });
  });

  describe("4. reversal versus another stock mutation", () => {
    it("reversal first: the receipt waits on the balance, then both apply", async () => {
      const { sale } = await sell(soap, "2");
      const pause = pauseAfter(repos.salesInventory, "lockForSale");
      const reversing = reverse(sale.saleId, decorated({ salesInventory: pause.wrapped }));
      await pause.reached;
      const receiving = receive(soap, "3", decorated());
      await blockedOn("inventory_balances");
      pause.release();
      expect((await reversing).sale.status).toBe("REVERSED");
      await receiving;
      expect(await onHand(soap)).toBe("13");
    });

    it("receipt first: the reversal waits on the balance holding only the sale, then both apply", async () => {
      const { sale } = await sell(soap, "2");
      const pause = pauseAfter(repos.inventoryBalances, "lockForUpdate");
      const receiving = receive(soap, "3", decorated({ inventoryBalances: pause.wrapped }));
      await pause.reached;
      const reversing = reverse(sale.saleId, decorated());
      const waiter = await blockedOn("inventory_balances");
      const held = await relationsLockedBy(waiter);
      expect(held).toContain("sales");
      expect(held).not.toContain("sale_receipt_sequences");
      pause.release();
      await receiving;
      expect((await reversing).sale.status).toBe("REVERSED");
      expect(await onHand(soap)).toBe("13");
    });

    it("reversal versus reversal of one sale: one reverses, the other is CONFLICT", async () => {
      const { sale } = await sell(soap, "2");
      const single = decorated();
      const results = await Promise.allSettled([reverse(sale.saleId, single), reverse(sale.saleId, single)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await onHand(soap)).toBe("10");
    });
  });

  it("5. overlapping multi-line sales and reversals never deadlock on a single attempt and never go negative", async () => {
    const single = decorated();
    let sold = 0;
    let short = 0;
    const recorded: string[] = [];
    for (let round = 0; round < 15; round += 1) {
      const forward = [saleLine(soap, "1"), saleLine(salt, "2")];
      const backward = [saleLine(salt, "1"), saleLine(soap, "2")];
      const work: Promise<unknown>[] = [
        single.recordSale.execute(a.context, saleInput(harness, forward, "150000")),
        single.recordSale.execute(a.context, saleInput(harness, backward, "150000")),
      ];
      const victim = recorded.shift();
      if (victim !== undefined) work.push(reverse(victim, single));
      const results = await Promise.allSettled(work);
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          expect(index).toBeLessThan(2);
          expect(result.reason).toBeInstanceOf(InsufficientStockError);
          short += 1;
        } else if (index < 2) {
          sold += 1;
          recorded.push((result.value as { sale: { saleId: string } }).sale.saleId);
        }
      }
      expect(BigInt((await onHand(soap)) ?? "0")).toBeGreaterThanOrEqual(0n);
      expect(BigInt((await onHand(salt)) ?? "0")).toBeGreaterThanOrEqual(0n);
    }
    expect(sold + short).toBe(30);
    expect(sold).toBeGreaterThan(0);
  }, 120_000);
});
