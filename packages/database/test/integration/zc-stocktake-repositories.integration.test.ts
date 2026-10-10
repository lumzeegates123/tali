import {
  ConcurrentModificationError,
  ConflictError,
  type InventoryItemRow,
  parsePageRequest,
  parseProductSearch,
  STOCKTAKE_IN_PROGRESS,
  type TransactionScope,
} from "@tali/application";
import type { CatalogProduct, LocationId, Stocktake, StocktakeLine } from "@tali/domain";
import {
  BusinessDate,
  createProduct,
  deriveLowStock,
  parseBarcode,
  parseProductName,
  parseSku,
  parseStocktakeId,
  parseUnitCode,
  Quantity,
  restoreStocktake,
  restoreStocktakeLine,
  startStocktake,
} from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInventoryConsistency, readInventorySnapshot } from "../../src/testing/index.js";
import {
  type InventoryTenant,
  inventoryProduct,
  inventoryTenant,
  rejection,
  secondLocation,
} from "../support/inventory.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * The Build 2 Slice 6 repositories over PostgreSQL (ADR-008 section 12; Slice
 * 6 plan W4): stocktake headers and lines, the movement history reads, and
 * the inventory item reader, each scoped by business (and location where it
 * applies). Headers and lines are written through the repositories as the
 * use cases write them; stock is moved through the Slice 5 use cases.
 */
describe("stocktake and inventory read repositories (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  let tenancy: Tenancy;
  let a: InventoryTenant;
  let b: InventoryTenant;
  let rice: CatalogProduct;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const run = <T>(work: (scope: TransactionScope) => Promise<T>) => harness.unitOfWork.run(work);
  const piece = (product: CatalogProduct, quantityMinor: string, unit = "PIECE") => ({
    variantId: product.variant.id,
    quantityMinor,
    unit,
  });
  const page = (limit: number, after?: string) =>
    parsePageRequest({ limit, ...(after === undefined ? {} : { after }) });

  function draft(t: InventoryTenant, locationId: LocationId = t.locationId): Stocktake {
    const world = harness.world();
    return startStocktake({
      id: parseStocktakeId(world.ids.newId("Stocktake")),
      businessId: t.businessId,
      locationId,
      createdByMembershipId: t.membershipId,
      createdAt: world.clock.now(),
    });
  }

  async function inserted(t: InventoryTenant, locationId?: LocationId): Promise<Stocktake> {
    const stocktake = draft(t, locationId);
    await run((scope) => repos.stocktakes.insert(scope, stocktake));
    return stocktake;
  }

  function bumped(stocktake: Stocktake): Stocktake {
    return restoreStocktake({ ...stocktake, status: "DRAFT", version: stocktake.version + 1 });
  }

  function cancelled(stocktake: Stocktake, t: InventoryTenant): Stocktake {
    return restoreStocktake({
      ...stocktake,
      status: "CANCELLED",
      version: stocktake.version + 1,
      cancelledByMembershipId: t.membershipId,
      cancelledAt: harness.world().clock.now(),
    });
  }

  function posted(stocktake: Stocktake, t: InventoryTenant): Stocktake {
    return restoreStocktake({
      ...stocktake,
      status: "POSTED",
      version: stocktake.version + 1,
      postedByMembershipId: t.membershipId,
      postedAt: harness.world().clock.now(),
      businessDate: BusinessDate.parse("2026-09-29"),
    });
  }

  function line(
    stocktake: Stocktake,
    t: InventoryTenant,
    product: CatalogProduct,
    countedMinor: bigint,
    overrides: { readonly expectedMinor?: bigint; readonly balanceVersion?: number } = {},
  ): StocktakeLine {
    const unit = product.variant.stockUnit;
    return restoreStocktakeLine({
      businessId: stocktake.businessId,
      stocktakeId: stocktake.id,
      variantId: product.variant.id,
      status: "COUNTED",
      countedQuantity: Quantity.ofMinor(countedMinor, unit),
      stockUnitAtCount: unit,
      expectedAtCount: Quantity.ofMinor(overrides.expectedMinor ?? 0n, unit),
      balanceVersionAtCount: overrides.balanceVersion ?? 0,
      version: 1,
      countedByMembershipId: t.membershipId,
      countedAt: harness.world().clock.now(),
    });
  }

  function recounted(previous: StocktakeLine, countedMinor: bigint): StocktakeLine {
    return restoreStocktakeLine({
      ...previous,
      countedQuantity: Quantity.ofMinor(countedMinor, previous.stockUnitAtCount),
      version: previous.version + 1,
    });
  }

  function removed(previous: StocktakeLine): StocktakeLine {
    return restoreStocktakeLine({ ...previous, status: "REMOVED", version: previous.version + 1 });
  }

  async function withLines(stocktake: Stocktake, lines: readonly StocktakeLine[]): Promise<void> {
    await run(async (scope) => {
      for (const each of lines) await repos.stocktakeLines.insert(scope, each);
    });
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "stocktake-repos-a");
    b = await inventoryTenant(harness, "stocktake-repos-b");
    rice = await inventoryProduct(harness, a, { name: "Rice", stockUnit: "KG" });
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  describe("StocktakeRepository", () => {
    it("inserts and restores a DRAFT, scoped by business and ID, with and without FOR UPDATE", async () => {
      const stocktake = await inserted(a);
      expect(await run((scope) => repos.stocktakes.findById(scope, a.businessId, stocktake.id))).toEqual(stocktake);
      expect(await run((scope) => repos.stocktakes.findByIdForUpdate(scope, a.businessId, stocktake.id))).toEqual(
        stocktake,
      );
      expect(await run((scope) => repos.stocktakes.findById(scope, b.businessId, stocktake.id))).toBeUndefined();
      expect(
        await run((scope) => repos.stocktakes.findByIdForUpdate(scope, b.businessId, stocktake.id)),
      ).toBeUndefined();
      const unknown = parseStocktakeId(harness.world().ids.newId("Stocktake"));
      expect(await run((scope) => repos.stocktakes.findById(scope, a.businessId, unknown))).toBeUndefined();
      expect(await run((scope) => repos.stocktakes.findByIdForUpdate(scope, a.businessId, unknown))).toBeUndefined();
    });

    it("a second DRAFT at one location is STOCKTAKE_IN_PROGRESS; other locations and terminal stocktakes do not block", async () => {
      const first = await inserted(a);
      const error = await rejection(run((scope) => repos.stocktakes.insert(scope, draft(a))));
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).message).toBe(STOCKTAKE_IN_PROGRESS);

      const backStore = await secondLocation(harness, a.businessId);
      await inserted(a, backStore);
      await inserted(b);

      await run((scope) => repos.stocktakes.update(scope, first, cancelled(first, a)));
      const next = await inserted(a);
      await run((scope) => repos.stocktakes.update(scope, next, posted(next, a)));
      await inserted(a);
      const stored = (await readInventorySnapshot()).stocktakes.filter((row) => row.locationId === a.locationId);
      expect(stored.map((row) => row.status).sort()).toEqual(["CANCELLED", "DRAFT", "POSTED"]);
    });

    it("updates only from the version read, writes the lifecycle columns, and refuses another business's row", async () => {
      const stocktake = await inserted(a);
      const v2 = bumped(stocktake);
      await run((scope) => repos.stocktakes.update(scope, stocktake, v2));
      expect(
        await rejection(run((scope) => repos.stocktakes.update(scope, stocktake, bumped(stocktake)))),
      ).toBeInstanceOf(ConcurrentModificationError);

      const foreign = restoreStocktake({ ...v2, businessId: b.businessId, locationId: v2.locationId });
      expect(await rejection(run((scope) => repos.stocktakes.update(scope, foreign, bumped(foreign))))).toBeInstanceOf(
        ConcurrentModificationError,
      );

      const done = posted(v2, a);
      await run((scope) => repos.stocktakes.update(scope, v2, done));
      expect(await run((scope) => repos.stocktakes.findById(scope, a.businessId, stocktake.id))).toEqual(done);
      expect(await rejection(run((scope) => repos.stocktakes.update(scope, done, posted(done, a))))).toBeInstanceOf(
        Error,
      );
      const [row] = (await readInventorySnapshot()).stocktakes;
      expect(row).toMatchObject({ status: "POSTED", version: 3, businessDate: "2026-09-29" });
    });

    it("lists one location's stocktakes by ID with a status filter, keyset pages and line counts", async () => {
      const backStore = await secondLocation(harness, a.businessId);
      const first = await inserted(a);
      await withLines(first, [line(first, a, beans, 4n), line(first, a, sugar, 2n)]);
      await run(async (scope) => {
        const sugarLine = await repos.stocktakeLines.find(scope, a.businessId, first.id, sugar.variant.id);
        if (sugarLine === undefined) throw new Error("missing line");
        await repos.stocktakeLines.update(scope, sugarLine, removed(sugarLine));
        await repos.stocktakes.update(scope, first, cancelled(first, a));
      });
      const second = await inserted(a);
      await inserted(a, backStore);
      await inserted(b);

      const all = await run((scope) => repos.stocktakes.list(scope, a.businessId, a.locationId, {}, page(10)));
      expect(all.items.map((item) => item.stocktake.id)).toEqual([first.id, second.id].sort());
      expect(all.nextCursor).toBeNull();
      const counts = new Map(all.items.map((item) => [item.stocktake.id, item.lineCounts]));
      expect(counts.get(first.id)).toEqual({ counted: 1, removed: 1, nonZeroVariance: 0, zeroVariance: 0 });
      expect(counts.get(second.id)).toEqual({ counted: 0, removed: 0, nonZeroVariance: 0, zeroVariance: 0 });

      const drafts = await run((scope) =>
        repos.stocktakes.list(scope, a.businessId, a.locationId, { status: "DRAFT" }, page(10)),
      );
      expect(drafts.items.map((item) => item.stocktake.id)).toEqual([second.id]);

      const one = await run((scope) => repos.stocktakes.list(scope, a.businessId, a.locationId, {}, page(1)));
      expect(one.items).toHaveLength(1);
      expect(one.nextCursor).toBe(one.items[0]?.stocktake.id);
      const rest = await run((scope) =>
        repos.stocktakes.list(scope, a.businessId, a.locationId, {}, page(1, one.nextCursor ?? undefined)),
      );
      expect(rest.items.map((item) => item.stocktake.id)).toEqual(
        [first.id, second.id].sort().filter((id) => id !== one.nextCursor),
      );
      expect(rest.nextCursor).toBeNull();

      const theirs = await run((scope) => repos.stocktakes.list(scope, b.businessId, a.locationId, {}, page(10)));
      expect(theirs.items).toEqual([]);
    });
  });

  describe("StocktakeLineRepository", () => {
    it("inserts and restores lines in their stock unit, scoped by business; a duplicate insert is a concurrent modification", async () => {
      const stocktake = await inserted(a);
      const riceLine = line(stocktake, a, rice, 2_500n, { expectedMinor: 1_000n, balanceVersion: 3 });
      await withLines(stocktake, [riceLine]);
      const found = await run((scope) => repos.stocktakeLines.find(scope, a.businessId, stocktake.id, rice.variant.id));
      expect(found).toEqual(riceLine);
      expect(found?.countedQuantity.unit).toBe(parseUnitCode("KG"));
      expect(
        await run((scope) => repos.stocktakeLines.find(scope, b.businessId, stocktake.id, rice.variant.id)),
      ).toBeUndefined();
      expect(await rejection(withLines(stocktake, [line(stocktake, a, rice, 1n)]))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      const [row] = (await readInventorySnapshot()).stocktakeLines;
      expect(row).toMatchObject({ countedText: "2500", stockUnitCode: "KG", version: 1, varianceText: null });
    });

    it("updates count fields only from the version read, and removal keeps the counted history", async () => {
      const stocktake = await inserted(a);
      const first = line(stocktake, a, beans, 4n);
      await withLines(stocktake, [first]);
      const second = recounted(first, 6n);
      await run((scope) => repos.stocktakeLines.update(scope, first, second));
      expect(
        await rejection(run((scope) => repos.stocktakeLines.update(scope, first, recounted(first, 7n)))),
      ).toBeInstanceOf(ConcurrentModificationError);
      const gone = removed(second);
      await run((scope) => repos.stocktakeLines.update(scope, second, gone));
      const found = await run((scope) =>
        repos.stocktakeLines.find(scope, a.businessId, stocktake.id, beans.variant.id),
      );
      expect(found).toEqual(gone);
      expect(found?.countedQuantity.amountMinor).toBe(6n);
      const foreign = restoreStocktakeLine({ ...gone, businessId: b.businessId });
      expect(
        await rejection(run((scope) => repos.stocktakeLines.update(scope, foreign, recounted(foreign, 1n)))),
      ).toBeInstanceOf(ConcurrentModificationError);
    });

    it("lists counted lines and pages every line by variant ID, and counts them by status", async () => {
      const stocktake = await inserted(a);
      const lines = [line(stocktake, a, rice, 1n), line(stocktake, a, beans, 2n), line(stocktake, a, sugar, 3n)];
      await withLines(stocktake, lines);
      const sorted = [...lines].sort((x, y) => (x.variantId < y.variantId ? -1 : 1));
      const middle = sorted[1] as StocktakeLine;
      await run((scope) => repos.stocktakeLines.update(scope, middle, removed(middle)));

      const counted = await run((scope) => repos.stocktakeLines.listCounted(scope, a.businessId, stocktake.id));
      expect(counted.map((each) => each.variantId)).toEqual([sorted[0]?.variantId, sorted[2]?.variantId]);
      const first = await run((scope) => repos.stocktakeLines.listPage(scope, a.businessId, stocktake.id, page(2)));
      expect(first.items.map((each) => each.variantId)).toEqual(sorted.slice(0, 2).map((each) => each.variantId));
      expect(first.nextCursor).toBe(sorted[1]?.variantId);
      const rest = await run((scope) =>
        repos.stocktakeLines.listPage(scope, a.businessId, stocktake.id, page(2, first.nextCursor ?? undefined)),
      );
      expect(rest.items.map((each) => each.variantId)).toEqual([sorted[2]?.variantId]);
      expect(rest.nextCursor).toBeNull();

      expect(await run((scope) => repos.stocktakeLines.countForStocktake(scope, a.businessId, stocktake.id))).toBe(3);
      expect(await run((scope) => repos.stocktakeLines.countByStatus(scope, a.businessId, stocktake.id))).toEqual({
        counted: 2,
        removed: 1,
        nonZeroVariance: 0,
        zeroVariance: 0,
      });
      expect(await run((scope) => repos.stocktakeLines.countForStocktake(scope, b.businessId, stocktake.id))).toBe(0);
      expect(await run((scope) => repos.stocktakeLines.listCounted(scope, b.businessId, stocktake.id))).toEqual([]);
    });

    describe("applyPostingVariances", () => {
      let stocktake: Stocktake;
      let riceLine: StocktakeLine;
      let beansLine: StocktakeLine;
      let sugarLine: StocktakeLine;
      const variance = (target: StocktakeLine, minor: bigint, lineVersion = target.version) => ({
        variantId: target.variantId,
        lineVersion,
        variance: Quantity.ofMinor(minor, target.stockUnitAtCount),
      });

      beforeEach(async () => {
        stocktake = await inserted(a);
        riceLine = line(stocktake, a, rice, 1_000n);
        beansLine = line(stocktake, a, beans, 2n);
        sugarLine = line(stocktake, a, sugar, 3n);
        await withLines(stocktake, [riceLine, beansLine, sugarLine]);
      });

      it("writes each variance once, in any input order, without changing a line version", async () => {
        await run((scope) =>
          repos.stocktakeLines.applyPostingVariances(scope, a.businessId, stocktake.id, [
            variance(sugarLine, 0n),
            variance(riceLine, -250n),
            variance(beansLine, 5n),
          ]),
        );
        const lines = (await readInventorySnapshot()).stocktakeLines;
        const byVariant = new Map(lines.map((row) => [row.variantId, row]));
        expect(byVariant.get(rice.variant.id)).toMatchObject({ varianceText: "-250", version: 1 });
        expect(byVariant.get(beans.variant.id)).toMatchObject({ varianceText: "5", version: 1 });
        expect(byVariant.get(sugar.variant.id)).toMatchObject({ varianceText: "0", version: 1 });
        expect(await run((scope) => repos.stocktakeLines.countByStatus(scope, a.businessId, stocktake.id))).toEqual({
          counted: 3,
          removed: 0,
          nonZeroVariance: 2,
          zeroVariance: 1,
        });
      });

      it("rejects a stale version, a REMOVED line, a variance already written or another business, leaving no partial set", async () => {
        await run((scope) => repos.stocktakeLines.update(scope, sugarLine, removed(sugarLine)));
        const before = (await readInventorySnapshot()).stocktakeLines;
        const attempts = [
          [variance(riceLine, 1n), variance(beansLine, 1n, 2)],
          [variance(riceLine, 1n), variance(sugarLine, 1n, 2)],
          [variance(beansLine, 1n), variance(beansLine, 2n)],
        ];
        for (const variances of attempts) {
          expect(
            await rejection(
              run((scope) => repos.stocktakeLines.applyPostingVariances(scope, a.businessId, stocktake.id, variances)),
            ),
          ).toBeInstanceOf(Error);
          expect((await readInventorySnapshot()).stocktakeLines).toEqual(before);
        }
        expect(
          await rejection(
            run((scope) =>
              repos.stocktakeLines.applyPostingVariances(scope, b.businessId, stocktake.id, [variance(riceLine, 1n)]),
            ),
          ),
        ).toBeInstanceOf(ConcurrentModificationError);

        await run((scope) =>
          repos.stocktakeLines.applyPostingVariances(scope, a.businessId, stocktake.id, [variance(riceLine, 1n)]),
        );
        const written = await readInventorySnapshot();
        expect(
          await rejection(
            run((scope) =>
              repos.stocktakeLines.applyPostingVariances(scope, a.businessId, stocktake.id, [
                variance(beansLine, 1n),
                variance(riceLine, 2n),
              ]),
            ),
          ),
        ).toBeInstanceOf(ConcurrentModificationError);
        expect(await readInventorySnapshot()).toEqual(written);
      });

      it("rejects a variance in a unit other than the line's stock unit", async () => {
        expect(
          await rejection(
            run((scope) =>
              repos.stocktakeLines.applyPostingVariances(scope, a.businessId, stocktake.id, [
                { variantId: riceLine.variantId, lineVersion: 1, variance: Quantity.ofMinor(1n, parseUnitCode("G")) },
              ]),
            ),
          ),
        ).toBeInstanceOf(ConcurrentModificationError);
      });
    });
  });

  describe("InventoryMovementRepository", () => {
    it("lists a document's originals then reversals, each by variant ID, for every source kind and only this business", async () => {
      const opening = await tenancy.recordOpeningStock.execute(a.context, {
        lines: [piece(sugar, "5"), piece(beans, "5")],
        idempotencyKey: key(),
      });
      const receipt = await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [piece(sugar, "2"), piece(beans, "3")],
        idempotencyKey: key(),
      });
      await tenancy.reverseGoodsReceipt.execute(a.context, { documentId: receipt.document.id, reason: "Wrong" });
      const adjustment = await tenancy.recordAdjustment.execute(a.context, {
        lines: [{ ...piece(beans, "1"), direction: "INCREASE" }],
        reasonCode: "FOUND_STOCK",
        idempotencyKey: key(),
      });
      await tenancy.reverseAdjustment.execute(a.context, { documentId: adjustment.document.id, reason: "Undo" });
      const { stocktake } = await tenancy.createStocktake.execute(a.context, { idempotencyKey: key() });
      for (const [product, counted] of [
        [sugar, "4"],
        [beans, "9"],
      ] as const) {
        await tenancy.recordStocktakeCount.execute(a.context, {
          stocktakeId: stocktake.stocktakeId,
          variantId: product.variant.id,
          count: { quantityMinor: counted, unit: "PIECE" },
        });
      }
      await tenancy.postStocktake.execute(a.context, { stocktakeId: stocktake.stocktakeId, expectedVersion: 3 });
      const theirs = await inventoryProduct(harness, b, { name: "Theirs" });
      await tenancy.postGoodsReceipt.execute(b.context, { lines: [piece(theirs, "1")], idempotencyKey: key() });

      const variantOrder = [sugar.variant.id, beans.variant.id].sort();
      const list = (
        businessId: typeof a.businessId,
        source: Parameters<typeof repos.inventoryMovements.listForSource>[2],
      ) => run((scope) => repos.inventoryMovements.listForSource(scope, businessId, source));

      const openingRows = await list(a.businessId, { kind: "OPENING_BATCH", id: opening.document.id });
      expect(openingRows.map((m) => [m.type, m.variantId])).toEqual(variantOrder.map((id) => ["OPENING", id]));

      const receiptRows = await list(a.businessId, { kind: "GOODS_RECEIPT", id: receipt.document.id });
      expect(receiptRows.map((m) => [m.reversesMovementId === undefined, m.variantId])).toEqual([
        ...variantOrder.map((id) => [true, id]),
        ...variantOrder.map((id) => [false, id]),
      ]);
      expect(receiptRows.slice(2).map((m) => m.reversesMovementId)).toEqual(receiptRows.slice(0, 2).map((m) => m.id));

      const adjustmentRows = await list(a.businessId, { kind: "ADJUSTMENT", id: adjustment.document.id });
      expect(adjustmentRows.map((m) => m.reversesMovementId === undefined)).toEqual([true, false]);

      const stocktakeRows = await list(a.businessId, { kind: "STOCKTAKE", id: stocktake.stocktakeId });
      expect(stocktakeRows.map((m) => [m.type, m.variantId, m.delta.amountMinor])).toEqual(
        variantOrder.map((id) => ["COUNT_CORRECTION", id, id === sugar.variant.id ? -1n : 4n]),
      );
      expect(stocktakeRows.every((m) => m.source.kind === "STOCKTAKE" && m.locationId === a.locationId)).toBe(true);

      expect(await list(b.businessId, { kind: "GOODS_RECEIPT", id: receipt.document.id })).toEqual([]);
      expect(await list(b.businessId, { kind: "STOCKTAKE", id: stocktake.stocktakeId })).toEqual([]);
    });

    it("lists one stock item's movements newest first with a movement cursor resolved only in that stock item", async () => {
      const received = await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [piece(rice, "1000", "KG")],
        idempotencyKey: key(),
      });
      for (const quantity of ["500", "250"]) {
        await tenancy.postGoodsReceipt.execute(a.context, {
          lines: [piece(rice, quantity, "KG")],
          idempotencyKey: key(),
        });
      }
      await tenancy.reverseGoodsReceipt.execute(a.context, { documentId: received.document.id, reason: "Return" });
      const list = (request: ReturnType<typeof page>, variantId = rice.variant.id, locationId = a.locationId) =>
        run((scope) => repos.inventoryMovements.listForItem(scope, a.businessId, locationId, variantId, request));

      const all = await list(page(10));
      expect(all?.items.map((m) => m.balanceVersion)).toEqual([4, 3, 2, 1]);
      expect(all?.items[0]?.reversesMovementId).toBe(all?.items[3]?.id);
      expect(all?.items.every((m) => m.delta.unit === parseUnitCode("KG"))).toBe(true);
      expect(all?.nextCursor).toBeNull();

      const first = await list(page(3));
      expect(first?.items.map((m) => m.balanceVersion)).toEqual([4, 3, 2]);
      expect(first?.nextCursor).toBe(first?.items[2]?.id);
      const second = await list(page(3, first?.nextCursor ?? undefined));
      expect(second?.items.map((m) => m.balanceVersion)).toEqual([1]);
      expect(second?.nextCursor).toBeNull();
      const end = await list(page(3, second?.items[0]?.id));
      expect(end).toEqual({ items: [], nextCursor: null });

      const backStore = await secondLocation(harness, a.businessId);
      const elsewhere = await tenancy.postGoodsReceipt.execute(
        { ...a.context, locationId: backStore },
        { lines: [piece(rice, "1", "KG")], idempotencyKey: key() },
      );
      const otherVariant = await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [piece(beans, "1")],
        idempotencyKey: key(),
      });
      const theirs = await inventoryProduct(harness, b, { name: "Theirs" });
      await tenancy.postGoodsReceipt.execute(b.context, { lines: [piece(theirs, "1")], idempotencyKey: key() });
      const { movements } = await readInventorySnapshot();
      const idOf = (predicate: (row: (typeof movements)[number]) => boolean) => movements.find(predicate)?.id as string;
      const foreignCursors = [
        harness.world().ids.newId("InventoryMovement"),
        idOf((row) => row.goodsReceiptId === elsewhere.document.id),
        idOf((row) => row.goodsReceiptId === otherVariant.document.id),
        idOf((row) => row.businessId === b.businessId),
      ];
      for (const cursor of foreignCursors) expect(await list(page(3, cursor))).toBeUndefined();
      expect((await list(page(10), rice.variant.id, backStore))?.items).toHaveLength(1);
    });
  });

  describe("InventoryItemReader", () => {
    async function productWith(
      name: string,
      options: { readonly sku?: string; readonly barcode?: string; readonly trackInventory?: boolean } = {},
    ): Promise<CatalogProduct> {
      const world = harness.world();
      const { item } = createProduct({
        id: world.ids.newId("Product"),
        variantId: world.ids.newId("ProductVariant"),
        businessId: a.businessId,
        name: parseProductName(name),
        ...(options.sku === undefined ? {} : { sku: parseSku(options.sku) }),
        ...(options.barcode === undefined ? {} : { barcode: parseBarcode(options.barcode) }),
        stockUnit: parseUnitCode("PIECE"),
        trackInventory: options.trackInventory ?? true,
        createdByMembershipId: a.membershipId,
        now: world.clock.now(),
      });
      await run((scope) => repos.products.insert(scope, item));
      return item;
    }

    const listAll = async (query: { readonly q?: string; readonly lowStockOnly?: boolean } = {}, limit = 100) => {
      const rows: InventoryItemRow[] = [];
      let after: string | undefined;
      for (;;) {
        const result = await run((scope) =>
          repos.inventoryItems.listItems(
            scope,
            a.businessId,
            a.locationId,
            {
              ...(query.q === undefined ? {} : { search: parseProductSearch(query.q) }),
              lowStockOnly: query.lowStockOnly ?? false,
            },
            page(limit, after),
          ),
        );
        rows.push(...result.items);
        if (result.nextCursor === null) return rows;
        after = result.nextCursor;
      }
    };
    const getItem = (product: CatalogProduct, businessId = a.businessId, locationId = a.locationId) =>
      run((scope) => repos.inventoryItems.getItem(scope, businessId, locationId, product.variant.id));
    const archive = (product: CatalogProduct) =>
      tenancy.archiveProduct.execute(a.context, { productId: product.product.id, expectedVersion: 1 });
    const threshold = (product: CatalogProduct, minor: string, expectedVersion = 0) =>
      tenancy.setLowStockThreshold.execute(a.context, {
        variantId: product.variant.id,
        expectedVersion,
        threshold: { quantityMinor: minor, unit: product.variant.stockUnit },
      });

    it("shows tracked ACTIVE items with or without stock and tracked ARCHIVED items with stock, in list and detail alike", async () => {
      const untracked = await productWith("Carrier bag", { trackInventory: false });
      const archivedEmpty = await productWith("Old stock");
      const archivedHeld = await productWith("Clearance");
      await tenancy.postGoodsReceipt.execute(a.context, { lines: [piece(archivedHeld, "2")], idempotencyKey: key() });
      await archive(archivedEmpty);
      await archive(archivedHeld);

      const listed = await listAll();
      const visible = [rice, beans, sugar, archivedHeld].map((p) => p.variant.id as string).sort();
      expect(listed.map((row) => row.variantId)).toEqual(visible);
      expect(listed.find((row) => row.variantId === rice.variant.id)).toMatchObject({
        onHand: Quantity.zero(parseUnitCode("KG")),
        balanceVersion: 0,
        thresholdVersion: 0,
        productStatus: "ACTIVE",
        trackInventory: true,
      });
      expect(listed.find((row) => row.variantId === archivedHeld.variant.id)).toMatchObject({
        productStatus: "ARCHIVED",
        onHand: Quantity.ofMinor(2n, parseUnitCode("PIECE")),
        balanceVersion: 1,
      });
      for (const product of [rice, beans, sugar, archivedHeld]) {
        expect(await getItem(product)).toEqual(listed.find((row) => row.variantId === product.variant.id));
      }
      for (const product of [untracked, archivedEmpty]) expect(await getItem(product)).toBeUndefined();
      expect(await getItem(rice, b.businessId)).toBeUndefined();
      const backStore = await secondLocation(harness, a.businessId);
      expect(await getItem(archivedHeld, a.businessId, backStore)).toBeUndefined();
      expect(await getItem(rice, a.businessId, backStore)).toMatchObject({ balanceVersion: 0 });
    });

    it("reports a missing, cleared and configured threshold with its stored version", async () => {
      await threshold(beans, "3");
      await threshold(sugar, "4");
      await tenancy.clearLowStockThreshold.execute(a.context, { variantId: sugar.variant.id, expectedVersion: 1 });
      const rows = new Map((await listAll()).map((row) => [row.variantId, row]));
      expect(rows.get(rice.variant.id)?.threshold).toBeUndefined();
      expect(rows.get(rice.variant.id)?.thresholdVersion).toBe(0);
      expect(rows.get(beans.variant.id)?.threshold).toEqual(Quantity.ofMinor(3n, parseUnitCode("PIECE")));
      expect(rows.get(beans.variant.id)?.thresholdVersion).toBe(1);
      expect(rows.get(sugar.variant.id)?.threshold).toBeUndefined();
      expect(rows.get(sugar.variant.id)?.thresholdVersion).toBe(2);
    });

    it("searches names as case-insensitive literals and SKU or barcode as exact normalized keys", async () => {
      const percent = await productWith("100% Pure_Honey", { sku: "hny-1", barcode: "4006381333931" });
      const plain = await productWith("Pure Honey 100");
      const names = async (q: string) => (await listAll({ q })).map((row) => row.variantId);
      expect(await names("100%")).toEqual([percent.variant.id]);
      expect(await names("e_h")).toEqual([percent.variant.id]);
      expect((await names("pure")).sort()).toEqual([percent.variant.id, plain.variant.id].sort());
      expect(await names("HNY-1")).toEqual([percent.variant.id]);
      expect(await names("HNY")).toEqual([]);
      expect(await names("04006381333931")).toEqual([percent.variant.id]);
      expect(await names("%")).toEqual([percent.variant.id]);
    });

    it("filters low stock in SQL before paging, matching deriveLowStock for every visible item", async () => {
      const zeroAtZero = await productWith("Zero at zero");
      const archivedLow = await productWith("Archived low");
      await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [piece(beans, "3"), piece(sugar, "5"), piece(archivedLow, "1"), piece(rice, "2000", "KG")],
        idempotencyKey: key(),
      });
      await threshold(beans, "3");
      await threshold(sugar, "4");
      await threshold(zeroAtZero, "0");
      await threshold(archivedLow, "5");
      await threshold(rice, "1999");
      await archive(archivedLow);
      const cleared = await productWith("Cleared");
      await threshold(cleared, "9");
      await tenancy.clearLowStockThreshold.execute(a.context, { variantId: cleared.variant.id, expectedVersion: 1 });

      const visible = await listAll();
      const expected = visible
        .filter((row) =>
          deriveLowStock({
            variantStatus: row.productStatus,
            trackInventory: row.trackInventory,
            stockUnit: row.stockUnit,
            threshold: row.threshold,
            onHand: row.onHand,
          }),
        )
        .map((row) => row.variantId);
      expect(expected.sort()).toEqual([beans.variant.id, zeroAtZero.variant.id].sort());
      expect((await listAll({ lowStockOnly: true })).map((row) => row.variantId)).toEqual(expected);
      expect((await listAll({ lowStockOnly: true }, 1)).map((row) => row.variantId)).toEqual(expected);
      expect((await listAll({ lowStockOnly: true, q: "zero" })).map((row) => row.variantId)).toEqual([
        zeroAtZero.variant.id,
      ]);
    });

    it("pages by variant ID ascending", async () => {
      const ids = [rice, beans, sugar].map((p) => p.variant.id as string).sort();
      expect((await listAll({}, 1)).map((row) => row.variantId)).toEqual(ids);
      const first = await run((scope) =>
        repos.inventoryItems.listItems(scope, a.businessId, a.locationId, {}, page(2)),
      );
      expect(first.items.map((row) => row.variantId)).toEqual(ids.slice(0, 2));
      expect(first.nextCursor).toBe(ids[1]);
    });
  });
});
