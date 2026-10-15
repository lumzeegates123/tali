import { ConflictError, InsufficientStockError, StocktakeStaleError, VersionConflictError } from "@tali/application";
import type { CatalogProduct, StocktakeId } from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInventoryConsistency, readInventorySnapshot, readTenancySnapshot } from "../../src/testing/index.js";
import { type InventoryTenant, inventoryProduct, inventoryTenant } from "../support/inventory.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * TALI_SOAK_ITERATIONS is a test-only override for the Slice 8 evidence runs;
 * `pnpm test:integration` uses the default.
 */
function soakIterations(): number {
  const raw = process.env["TALI_SOAK_ITERATIONS"];
  if (raw === undefined || raw === "") return 5;
  if (!/^[1-9]\d{0,2}$/.test(raw)) throw new Error("TALI_SOAK_ITERATIONS must be an integer from 1 to 999");
  return Number(raw);
}

const ITERATIONS = soakIterations();
const SCENARIO_TIMEOUT_MS = 600_000;

/**
 * Build 2 Slice 8 concurrency soak over PostgreSQL (ADR-008 sections 8, 9 and
 * 12): the Slice 5 and 6 races repeated freely on a single-attempt unit of
 * work, so a deadlock or serialization failure cannot be hidden by a retry.
 * Each iteration asserts the exact outcome set; after every iteration the
 * movement and audit counts match the effective changes, no movement is
 * duplicated, every balance equals the sum and count of its movements, and
 * the consistency query is empty. Iteration order and quantities are fixed:
 * there is no randomness, only real scheduling.
 */
describe(`inventory concurrency soak, ${ITERATIONS} iterations per scenario (PostgreSQL)`, () => {
  const harness = useTenancyHarness();
  let tenancy: Tenancy;
  let single: Tenancy;
  let a: InventoryTenant;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const piece = (product: CatalogProduct, quantityMinor: string) => ({
    variantId: product.variant.id,
    quantityMinor,
    unit: "PIECE",
  });
  type Line = ReturnType<typeof piece>;
  const receive = (lines: readonly Line[], using: Tenancy = single) =>
    using.postGoodsReceipt.execute(a.context, { lines, idempotencyKey: key() });
  const writeOff = (lines: readonly Line[]) =>
    single.recordWriteOff.execute(a.context, { lines, reasonCode: "THEFT_OR_LOSS", idempotencyKey: key() });
  const adjust = (lines: readonly Line[], direction: "INCREASE" | "DECREASE") =>
    single.recordAdjustment.execute(a.context, {
      lines: lines.map((line) => ({ ...line, direction })),
      reasonCode: "DATA_ENTRY_CORRECTION",
      idempotencyKey: key(),
    });
  const start = async (idempotencyKey = key()) =>
    (await single.createStocktake.execute(a.context, { idempotencyKey })).stocktake.stocktakeId;
  const count = (stocktakeId: StocktakeId, product: CatalogProduct, quantityMinor: string, expectedVersion?: number) =>
    single.recordStocktakeCount.execute(a.context, {
      stocktakeId,
      variantId: product.variant.id,
      count: { quantityMinor, unit: "PIECE" },
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  const versionOf = async (stocktakeId: StocktakeId) =>
    (await tenancy.getStocktake.execute(a.context, { stocktakeId })).version;
  const post = (stocktakeId: StocktakeId, expectedVersion: number) =>
    single.postStocktake.execute(a.context, { stocktakeId, expectedVersion });
  const cancel = (stocktakeId: StocktakeId, expectedVersion: number) =>
    single.cancelStocktake.execute(a.context, { stocktakeId, expectedVersion });

  async function onHand(product: CatalogProduct): Promise<bigint> {
    const { balances } = await readInventorySnapshot();
    return BigInt(balances.find((row) => row.variantId === product.variant.id)?.quantityText ?? "0");
  }

  async function settledPair<T, U>(first: Promise<T>, second: Promise<U>) {
    const results = await Promise.allSettled<[Promise<T>, Promise<U>]>([first, second]);
    const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
    return { results, fulfilled, rejected };
  }

  /** Expected totals, advanced by each iteration's effective changes only. */
  const expected = { movements: 0, audit: new Map<string, number>() };
  const effective = (movements: number, ...actions: string[]) => {
    expected.movements += movements;
    for (const action of actions) expected.audit.set(action, (expected.audit.get(action) ?? 0) + 1);
  };

  async function settledLedger(scenario: string, iteration: number) {
    const label = `${scenario}, iteration ${iteration + 1}`;
    const inventory = await readInventorySnapshot();
    const audit = (await readTenancySnapshot()).businessAudit.filter((row) => row.businessId === a.businessId);
    expect(inventory.movements.length, label).toBe(expected.movements);
    for (const [action, total] of expected.audit) {
      expect(audit.filter((row) => row.action === action).length, `${label}: ${action}`).toBe(total);
    }
    const expectedAudit = [...expected.audit.values()].reduce((total, value) => total + value, 0);
    expect(audit.filter((row) => row.action.startsWith("inventory.")).length, `${label}: audit total`).toBe(
      expectedAudit,
    );
    const identities = inventory.movements.map((row) =>
      [
        row.type,
        row.variantId,
        row.openingBatchId ?? row.goodsReceiptId ?? row.adjustmentId ?? row.stocktakeId,
        row.reversesMovementId,
      ].join("|"),
    );
    expect(new Set(identities).size, `${label}: duplicate movement`).toBe(identities.length);
    for (const balance of inventory.balances) {
      const own = inventory.movements.filter(
        (row) => row.locationId === balance.locationId && row.variantId === balance.variantId,
      );
      const sum = own.reduce((total, row) => total + BigInt(row.deltaText), 0n);
      expect(BigInt(balance.quantityText), `${label}: balance equals the movement sum`).toBe(sum);
      expect(balance.version, `${label}: balance version equals the movement count`).toBe(own.length);
    }
    expect(await readInventoryConsistency(), label).toEqual([]);
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    single = harness.compose({ unitOfWork: harness.unitOfWorkWith({ maxAttempts: 1 }) });
    a = await inventoryTenant(harness, "inventory-soak");
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
    expected.movements = 0;
    expected.audit.clear();
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  it(
    "decrement versus decrement: exactly one of two competing decrements wins and stock never goes negative",
    async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        await receive([piece(sugar, "6")]);
        effective(1, "inventory.received");
        const competitor = i % 2 === 0 ? writeOff([piece(sugar, "6")]) : adjust([piece(sugar, "6")], "DECREASE");
        const race = await settledPair<unknown, unknown>(competitor, writeOff([piece(sugar, "6")]));
        expect(race.fulfilled).toHaveLength(1);
        expect(race.rejected).toEqual([expect.any(InsufficientStockError)]);
        const adjustedWon = i % 2 === 1 && race.results[0].status === "fulfilled";
        effective(1, adjustedWon ? "inventory.adjusted" : "inventory.written_off");
        expect(await onHand(sugar)).toBe(0n);
        await settledLedger("decrement versus decrement", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "opposite-order multi-line documents: two receipt pairs per iteration with reversed line orders all succeed",
    async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const results = await Promise.allSettled([
          receive([piece(beans, "1"), piece(sugar, "1")]),
          receive([piece(sugar, "1"), piece(beans, "1")]),
          receive([piece(beans, "1"), piece(sugar, "1")]),
          receive([piece(sugar, "1"), piece(beans, "1")]),
        ]);
        expect(results.filter((result) => result.status === "rejected")).toEqual([]);
        for (let receipt = 0; receipt < 4; receipt += 1) effective(2, "inventory.received");
        expect([await onHand(beans), await onHand(sugar)]).toEqual([BigInt(4 * (i + 1)), BigInt(4 * (i + 1))]);
        await settledLedger("opposite-order documents", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "receipt versus adjustment in opposite line orders: both succeed",
    async () => {
      await receive([piece(beans, "100"), piece(sugar, "100")], tenancy);
      effective(2, "inventory.received");
      for (let i = 0; i < ITERATIONS; i += 1) {
        const direction = i % 2 === 0 ? "INCREASE" : "DECREASE";
        const results = await Promise.allSettled([
          receive([piece(beans, "2"), piece(sugar, "2")]),
          adjust([piece(sugar, "1"), piece(beans, "1")], direction),
        ]);
        expect(results.filter((result) => result.status === "rejected")).toEqual([]);
        effective(2, "inventory.received");
        effective(2, "inventory.adjusted");
        await settledLedger("receipt versus adjustment", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const [name, move, action] of [
    ["receipt", (lines: readonly Line[]) => receive(lines), "inventory.received"],
    ["adjustment", (lines: readonly Line[]) => adjust(lines, "INCREASE"), "inventory.adjusted"],
  ] as const) {
    it(
      `post versus ${name}: the ${name} always applies; the post either corrects first or is STOCKTAKE_STALE`,
      async () => {
        await receive([piece(beans, "10")], tenancy);
        effective(1, "inventory.received");
        for (let i = 0; i < ITERATIONS; i += 1) {
          const before = await onHand(beans);
          const id = await start();
          effective(0, "inventory.stocktake_started");
          const counted = before + (i % 2 === 0 ? 1n : -1n);
          await count(id, beans, counted.toString());
          const version = await versionOf(id);
          const [postResult, moveResult] = (
            await settledPair<unknown, unknown>(post(id, version), move([piece(beans, "1")]))
          ).results;
          expect(moveResult.status).toBe("fulfilled");
          effective(1, action);
          if (postResult.status === "fulfilled") {
            effective(1, "inventory.stocktake_posted");
            expect(await onHand(beans)).toBe(counted + 1n);
          } else {
            expect(postResult.reason).toBeInstanceOf(StocktakeStaleError);
            await cancel(id, version);
            effective(0, "inventory.stocktake_cancelled");
            expect(await onHand(beans)).toBe(before + 1n);
          }
          await settledLedger(`post versus ${name}`, i);
        }
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "post versus post: one posts, the other is a no-op, and the corrections are written once",
    async () => {
      await receive([piece(beans, "10"), piece(sugar, "10")], tenancy);
      effective(2, "inventory.received");
      for (let i = 0; i < ITERATIONS; i += 1) {
        const step = i % 2 === 0 ? 1n : -1n;
        const id = await start();
        effective(0, "inventory.stocktake_started");
        await count(id, beans, ((await onHand(beans)) + step).toString());
        await count(id, sugar, ((await onHand(sugar)) - step).toString());
        const version = await versionOf(id);
        const race = await settledPair(post(id, version), post(id, version));
        expect(race.rejected).toEqual([]);
        expect(race.fulfilled.map((result) => result.changed).sort()).toEqual([false, true]);
        expect(race.fulfilled.map((result) => result.movements.length).sort()).toEqual([0, 2]);
        effective(2, "inventory.stocktake_posted");
        await settledLedger("post versus post", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "count versus count: two recounts from one line version, one wins and the other is VERSION_CONFLICT",
    async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const id = await start();
        effective(0, "inventory.stocktake_started");
        const first = await count(id, beans, "5");
        const race = await settledPair(
          count(id, beans, "6", first.line.version),
          count(id, beans, "7", first.line.version),
        );
        expect(race.fulfilled.map((result) => result.line.version)).toEqual([first.line.version + 1]);
        expect(race.rejected).toEqual([expect.any(VersionConflictError)]);
        await cancel(id, await versionOf(id));
        effective(0, "inventory.stocktake_cancelled");
        await settledLedger("count versus count", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "cancel versus post: exactly one wins and the loser is CONFLICT",
    async () => {
      await receive([piece(beans, "10")], tenancy);
      effective(1, "inventory.received");
      for (let i = 0; i < ITERATIONS; i += 1) {
        const id = await start();
        effective(0, "inventory.stocktake_started");
        await count(id, beans, ((await onHand(beans)) + (i % 2 === 0 ? 1n : -1n)).toString());
        const version = await versionOf(id);
        const [postResult, cancelResult] = (await settledPair(post(id, version), cancel(id, version))).results;
        const outcomes = [postResult.status, cancelResult.status].sort();
        expect(outcomes).toEqual(["fulfilled", "rejected"]);
        const loser: unknown =
          postResult.status === "rejected" ? postResult.reason : (cancelResult as PromiseRejectedResult).reason;
        expect(loser).toBeInstanceOf(ConflictError);
        if (postResult.status === "fulfilled") {
          expect(postResult.value.changed).toBe(true);
          effective(1, "inventory.stocktake_posted");
        } else {
          effective(0, "inventory.stocktake_cancelled");
        }
        await settledLedger("cancel versus post", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "create versus create: one DRAFT and one CONFLICT, with exactly one idempotency record per iteration",
    async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const before = (await readTenancySnapshot()).businessIdempotency.length;
        const race = await settledPair(start(), start());
        expect(race.fulfilled).toHaveLength(1);
        expect(race.rejected).toEqual([expect.any(ConflictError)]);
        expect((await readTenancySnapshot()).businessIdempotency).toHaveLength(before + 1);
        effective(0, "inventory.stocktake_started");
        const [id] = race.fulfilled;
        if (id === undefined) throw new Error("expected one DRAFT");
        await cancel(id, await versionOf(id));
        effective(0, "inventory.stocktake_cancelled");
        await settledLedger("create versus create", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "reversal versus reversal: one reverses, the other is a no-op with no extra movement or audit record",
    async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const received = await receive([piece(sugar, "2"), piece(beans, "1")]);
        effective(2, "inventory.received");
        const reverse = () =>
          single.reverseGoodsReceipt.execute(a.context, { documentId: received.document.id, reason: "Wrong delivery" });
        const race = await settledPair(reverse(), reverse());
        expect(race.rejected).toEqual([]);
        expect(race.fulfilled.map((result) => result.changed).sort()).toEqual([false, true]);
        effective(2, "inventory.receipt_reversed");
        expect([await onHand(sugar), await onHand(beans)]).toEqual([0n, 0n]);
        await settledLedger("reversal versus reversal", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "reversal versus write-off of the same stock: exactly one wins and stock never goes negative",
    async () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const received = await receive([piece(sugar, "6")]);
        effective(1, "inventory.received");
        const reversal = single.reverseGoodsReceipt.execute(a.context, {
          documentId: received.document.id,
          reason: "Return",
        });
        const race = await settledPair<unknown, unknown>(reversal, writeOff([piece(sugar, "6")]));
        expect(race.fulfilled).toHaveLength(1);
        expect(race.rejected).toEqual([expect.any(InsufficientStockError)]);
        effective(1, race.results[0].status === "fulfilled" ? "inventory.receipt_reversed" : "inventory.written_off");
        expect(await onHand(sugar)).toBe(0n);
        await settledLedger("reversal versus write-off", i);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
