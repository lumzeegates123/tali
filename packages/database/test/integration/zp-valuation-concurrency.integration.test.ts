import { ConflictError, IdempotencyKeyReusedError, ValuationStaleError } from "@tali/application";
import type { CatalogProduct } from "@tali/domain";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseRepositories } from "../../src/database.js";
import { readInventoryConsistency, readInventorySnapshot } from "../../src/testing/index.js";
import { gate } from "../support/harness.js";
import { type InventoryTenant, inventoryProduct, inventoryTenant, rejection } from "../support/inventory.js";
import { appPool } from "../support/pg.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

describe("inventory valuation concurrency (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  const probe = appPool();
  afterAll(() => probe.end());

  let tenancy: Tenancy;
  let a: InventoryTenant;
  let soap: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");

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

  const decorated = (decorate: Partial<DatabaseRepositories>) =>
    harness.compose({ decorate, unitOfWork: harness.unitOfWorkWith() });

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "valuation-concurrency");
    soap = await inventoryProduct(harness, a, { name: "Soap" });
    await tenancy.recordOpeningStock.execute(a.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" }],
      idempotencyKey: key(),
    });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  it("A. two valuations of the same item: one commits, the other conflicts, no duplicate journal", async () => {
    const pause = pauseAfter(repos.inventoryValuations, "lockForUpdate");
    const using = decorated({ inventoryValuations: pause.wrapped });
    const body = {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "1000", currency: "NGN" },
      reason: "Opening value",
    };
    const first = using.recordStockValuation.execute(a.context, { ...body, idempotencyKey: key() });
    await pause.reached;
    const second = using.recordStockValuation.execute(a.context, {
      ...body,
      newTotalValue: { amountMinor: "2000", currency: "NGN" },
      idempotencyKey: key(),
    });
    pause.release();
    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failed = rejected[0];
    if (failed === undefined) {
      throw new Error("expected one valuation to be rejected");
    }
    const error: unknown = failed.reason;
    expect(error instanceof ConflictError || error instanceof ValuationStaleError).toBe(true);
    const { rows } = await harness.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND valuation_id IS NOT NULL`,
      [a.businessId],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("B. valuation vs goods receipt: receipt first makes the valuation stale; no deadlock", async () => {
    const pause = pauseAfter(repos.inventoryValuations, "lockForUpdate");
    const receiving = decorated({ inventoryValuations: pause.wrapped });
    const receipt = receiving.postGoodsReceipt.execute(a.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    await pause.reached;
    const valuation = tenancy.recordStockValuation.execute(a.context, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "500", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key(),
    });
    pause.release();
    await receipt;
    expect(await rejection(valuation)).toBeInstanceOf(ValuationStaleError);
    expect((await readInventorySnapshot()).movements).toHaveLength(2);
  });

  it("C. receipt vs adjustment on the same valued item: both commit, value chain remains consistent", async () => {
    await tenancy.recordStockValuation.execute(a.context, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "1000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key(),
    });
    const results = await Promise.allSettled([
      tenancy.postGoodsReceipt.execute(a.context, {
        lines: [
          {
            variantId: soap.variant.id,
            quantityMinor: "2",
            unit: "PIECE",
            totalCost: { amountMinor: "200", currency: "NGN" },
          },
        ],
        idempotencyKey: key(),
      }),
      tenancy.recordWriteOff.execute(a.context, {
        lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
        reasonCode: "DAMAGED",
        idempotencyKey: key(),
      }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await readInventoryConsistency()).toEqual([]);
  });

  it("D. concurrent valued write-offs serialize; remaining value matches on-hand WAC", async () => {
    await tenancy.recordStockValuation.execute(a.context, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "1000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key(),
    });
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        tenancy.recordWriteOff.execute(a.context, {
          lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
          reasonCode: "DAMAGED",
          idempotencyKey: key(),
        }),
      ),
    );
    const ok = results.filter((result) => result.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await readInventoryConsistency()).toEqual([]);
  });

  it("E. duplicate keyed receipt with cost posts one journal and one movement valuation", async () => {
    const idempotencyKey = key();
    const command = {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "3",
          unit: "PIECE",
          totalCost: { amountMinor: "300", currency: "NGN" },
        },
      ],
      idempotencyKey,
    };
    await tenancy.recordStockValuation.execute(a.context, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "1000", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key(),
    });
    const pause = pauseAfter(repos.inventoryBalances, "lockForUpdate");
    const using = decorated({ inventoryBalances: pause.wrapped });
    const first = using.postGoodsReceipt.execute(a.context, command);
    await pause.reached;
    const second = using.postGoodsReceipt.execute(a.context, command);
    pause.release();
    const [original, replay] = await Promise.all([first, second]);
    expect([original.replayed, replay.replayed].sort()).toEqual([false, true]);
    const journals = await harness.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND goods_receipt_id IS NOT NULL`,
      [a.businessId],
    );
    expect(journals.rows[0]?.n).toBe("1");
    const facts = await harness.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_movement_valuations f
       JOIN inventory_movements m ON m.id = f.movement_id
       WHERE m.goods_receipt_id IS NOT NULL AND m.business_id = $1`,
      [a.businessId],
    );
    expect(facts.rows[0]?.n).toBe("1");
    expect(IdempotencyKeyReusedError).toBeDefined();
  });

  it("F. two reversals of the same valued receipt: one effect, at most one residual, no deadlock", async () => {
    await tenancy.recordStockValuation.execute(a.context, {
      variantId: soap.variant.id,
      expectedBalanceVersion: 1,
      newTotalValue: { amountMinor: "100", currency: "NGN" },
      reason: "Opening value",
      idempotencyKey: key(),
    });
    const receipt = await tenancy.postGoodsReceipt.execute(a.context, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "5",
          unit: "PIECE",
          totalCost: { amountMinor: "500", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await tenancy.recordWriteOff.execute(a.context, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "6", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    const results = await Promise.allSettled([
      tenancy.reverseGoodsReceipt.execute(a.context, {
        documentId: receipt.document.id,
        reason: "Returned after write-off",
      }),
      tenancy.reverseGoodsReceipt.execute(a.context, {
        documentId: receipt.document.id,
        reason: "Returned after write-off",
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of rejected) {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      expect(message).not.toMatch(/unique|duplicate key|23505/i);
    }
    const residuals = await harness.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_valuations
       WHERE business_id = $1 AND kind = 'REVERSAL_RESIDUAL'`,
      [a.businessId],
    );
    expect(Number(residuals.rows[0]?.n)).toBeLessThanOrEqual(1);
    const residualJournals = await harness.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
       WHERE business_id = $1 AND posting_rule = 'INVENTORY_REVERSAL_RESIDUAL'`,
      [a.businessId],
    );
    expect(Number(residualJournals.rows[0]?.n)).toBeLessThanOrEqual(1);
    const reversals = await harness.owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_movements
       WHERE business_id = $1 AND reverses_movement_id IS NOT NULL`,
      [a.businessId],
    );
    expect(reversals.rows[0]?.n).toBe("1");
    expect(await readInventoryConsistency()).toEqual([]);
  });
});
