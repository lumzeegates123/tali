import {
  ConflictError,
  IdempotencyKeyReusedError,
  type LocationBoundContext,
  NotFoundError,
  StocktakeStaleError,
  ValidationError,
  VersionConflictError,
} from "@tali/application";
import type { CatalogProduct, MembershipRole, ProductPack } from "@tali/domain";
import {
  createProduct,
  parseProductName,
  parseUnitCode,
  Quantity,
  restoreStocktakeLine,
  type StocktakeId,
} from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseRepositories } from "../../src/database.js";
import { readInventoryConsistency, readInventorySnapshot, readTenancySnapshot } from "../../src/testing/index.js";
import {
  type InventoryTenant,
  inventoryPack,
  inventoryProduct,
  inventoryTenant,
  rejection,
  secondLocation,
} from "../support/inventory.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * The Build 2 Slice 6 stocktake and inventory read use cases end to end over
 * PostgreSQL (ADR-008 section 12; Slice 6 plan W4), composed as the API
 * composes them with the real unit of work, repositories, audit recorder and
 * keyed idempotency. Failures are injected only by decorating a repository in
 * the test composition. Every scenario leaves the ledger consistent.
 */
describe("stocktake use cases (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  let tenancy: Tenancy;
  let a: InventoryTenant;
  let b: InventoryTenant;
  let rice: CatalogProduct;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const piece = (product: CatalogProduct, quantityMinor: string, unit = "PIECE") => ({
    variantId: product.variant.id,
    quantityMinor,
    unit,
  });
  const receive = (lines: readonly ReturnType<typeof piece>[], context: LocationBoundContext = a.context) =>
    tenancy.postGoodsReceipt.execute(context, { lines, idempotencyKey: key() });

  async function persisted() {
    const tenancySnapshot = await readTenancySnapshot();
    return {
      inventory: await readInventorySnapshot(),
      audit: tenancySnapshot.businessAudit,
      idempotency: tenancySnapshot.businessIdempotency,
    };
  }

  async function memberContext(t: InventoryTenant, role: MembershipRole): Promise<LocationBoundContext> {
    const user = await tenancy.registeredUser(`${role.toLowerCase()}-${t.businessId}`);
    await harness.addMember(t.businessId, user, role);
    return tenancy.boundContextFor(user, t.businessId);
  }

  async function start(context: LocationBoundContext = a.context, note?: string): Promise<StocktakeId> {
    const { stocktake } = await tenancy.createStocktake.execute(context, {
      idempotencyKey: key(),
      ...(note === undefined ? {} : { note }),
    });
    return stocktake.stocktakeId;
  }

  const count = (
    stocktakeId: string,
    product: CatalogProduct,
    counted: Parameters<Tenancy["recordStocktakeCount"]["execute"]>[1]["count"],
    expectedVersion?: number,
    context: LocationBoundContext = a.context,
  ) =>
    tenancy.recordStocktakeCount.execute(context, {
      stocktakeId,
      variantId: product.variant.id,
      count: counted,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  const pieces = (quantityMinor: string, unit = "PIECE") => ({ quantityMinor, unit });

  async function versionOf(stocktakeId: StocktakeId): Promise<number> {
    return (await tenancy.getStocktake.execute(a.context, { stocktakeId })).version;
  }
  const post = async (stocktakeId: StocktakeId, using: Tenancy = tenancy) =>
    using.postStocktake.execute(a.context, { stocktakeId, expectedVersion: await versionOf(stocktakeId) });
  const cancel = async (stocktakeId: StocktakeId) =>
    tenancy.cancelStocktake.execute(a.context, { stocktakeId, expectedVersion: await versionOf(stocktakeId) });

  const auditOf = async (action: string) =>
    (await readTenancySnapshot()).businessAudit.filter((row) => row.action === action);

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "stocktake-cases-a");
    b = await inventoryTenant(harness, "stocktake-cases-b");
    rice = await inventoryProduct(harness, a, { name: "Rice", stockUnit: "KG" });
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  describe("create", () => {
    it("a keyed replay returns the creation snapshot unchanged after count, post and cancel, with one audit record per stocktake", async () => {
      await receive([piece(beans, "5")]);
      const idempotencyKey = key();
      const created = await tenancy.createStocktake.execute(a.context, { idempotencyKey, note: "Month end" });
      expect(created).toMatchObject({ replayed: false, stocktake: { status: "DRAFT", version: 1, note: "Month end" } });
      const id = created.stocktake.stocktakeId;
      await count(id, beans, pieces("4"));
      expect(await tenancy.createStocktake.execute(a.context, { idempotencyKey, note: "Month end" })).toEqual({
        ...created,
        replayed: true,
      });
      await post(id);
      expect(await tenancy.createStocktake.execute(a.context, { idempotencyKey, note: "Month end" })).toEqual({
        ...created,
        replayed: true,
      });

      const otherKey = key();
      const second = await tenancy.createStocktake.execute(a.context, { idempotencyKey: otherKey });
      await cancel(second.stocktake.stocktakeId);
      expect(await tenancy.createStocktake.execute(a.context, { idempotencyKey: otherKey })).toEqual({
        ...second,
        replayed: true,
      });
      expect((await auditOf("inventory.stocktake_started")).map((row) => row.entityId).sort()).toEqual(
        [id, second.stocktake.stocktakeId].sort(),
      );
    });

    it("the same key with another note or location is IDEMPOTENCY_KEY_REUSED and writes nothing", async () => {
      const idempotencyKey = key();
      await tenancy.createStocktake.execute(a.context, { idempotencyKey, note: "First" });
      const backStore = await secondLocation(harness, a.businessId);
      const before = await persisted();
      expect(
        await rejection(tenancy.createStocktake.execute(a.context, { idempotencyKey, note: "Second" })),
      ).toBeInstanceOf(IdempotencyKeyReusedError);
      expect(
        await rejection(
          tenancy.createStocktake.execute({ ...a.context, locationId: backStore }, { idempotencyKey, note: "First" }),
        ),
      ).toBeInstanceOf(IdempotencyKeyReusedError);
      expect(await persisted()).toEqual(before);
    });

    it("another key while a DRAFT exists is CONFLICT; a new DRAFT is allowed once it is posted or cancelled", async () => {
      await receive([piece(beans, "5")]);
      const first = await start();
      const before = await persisted();
      expect(await rejection(start())).toBeInstanceOf(ConflictError);
      expect(await persisted()).toEqual(before);
      await cancel(first);
      const second = await start();
      await count(second, beans, pieces("5"));
      await post(second);
      const third = await start();
      expect((await tenancy.getStocktake.execute(a.context, { stocktakeId: third })).status).toBe("DRAFT");
      expect(await auditOf("inventory.stocktake_started")).toHaveLength(3);
    });

    it("another business's member cannot read, count, remove, post or cancel this business's stocktake", async () => {
      await receive([piece(beans, "5")]);
      const id = await start();
      await count(id, beans, pieces("4"));
      const before = await persisted();
      const attempts: (() => Promise<unknown>)[] = [
        () => tenancy.getStocktake.execute(b.context, { stocktakeId: id }),
        () => tenancy.listStocktakeLines.execute(b.context, { stocktakeId: id }),
        () => count(id, beans, pieces("1"), 1, b.context),
        () =>
          tenancy.removeStocktakeLine.execute(b.context, {
            stocktakeId: id,
            variantId: beans.variant.id,
            expectedVersion: 1,
          }),
        () => tenancy.postStocktake.execute(b.context, { stocktakeId: id, expectedVersion: 2 }),
        () => tenancy.cancelStocktake.execute(b.context, { stocktakeId: id, expectedVersion: 2 }),
      ];
      for (const attempt of attempts) expect(await rejection(attempt())).toBeInstanceOf(NotFoundError);
      expect((await tenancy.listStocktakes.execute(b.context)).items).toEqual([]);
      expect(await persisted()).toEqual(before);
    });
  });

  describe("count", () => {
    it("records zero, decimal, pack and pack-plus-loose counts in the stock unit, with no movement and no audit record", async () => {
      const carton = await inventoryPack(harness, beans.variant, "Carton", 24n);
      await receive([piece(beans, "30"), piece(rice, "1500", "KG")]);
      const id = await start();
      const before = await persisted();
      const zero = await count(id, sugar, pieces("0"));
      const decimal = await count(id, rice, { decimal: "2.5", unit: "KG" });
      const packed = await count(id, beans, { packId: carton.id, packCount: "2" });
      expect([zero, decimal, packed].map((result) => result.line.countedQuantity)).toEqual([
        Quantity.zero(parseUnitCode("PIECE")),
        Quantity.ofMinor(2_500n, parseUnitCode("KG")),
        Quantity.ofMinor(48n, parseUnitCode("PIECE")),
      ]);
      const loose = await count(id, beans, { packId: carton.id, packCount: "2", loose: pieces("3") }, 1);
      expect(loose.line).toMatchObject({ countedQuantity: Quantity.ofMinor(51n, parseUnitCode("PIECE")), version: 2 });
      expect(loose.line).toMatchObject({
        visibility: "FULL",
        expectedAtCount: Quantity.ofMinor(30n, parseUnitCode("PIECE")),
      });
      expect(loose.stocktake.version).toBe(5);

      const after = await persisted();
      expect(after.inventory.movements).toEqual(before.inventory.movements);
      expect(after.inventory.balances).toEqual(before.inventory.balances);
      expect(after.audit).toEqual(before.audit);
      expect(
        after.inventory.stocktakeLines.map((row) => [row.variantId, row.countedText, row.stockUnitCode]).sort(),
      ).toEqual(
        [
          [sugar.variant.id, "0", "PIECE"],
          [rice.variant.id, "2500", "KG"],
          [beans.variant.id, "51", "PIECE"],
        ].sort(),
      );
    });

    it("rejects a retired pack, an archived product with no stock and an untracked product; an archived product with stock can be counted", async () => {
      const carton: ProductPack = await inventoryPack(harness, beans.variant, "Carton", 24n);
      await tenancy.retirePack.execute(a.context, { packId: carton.id });
      const untracked = await inventoryProduct(harness, a, { name: "Bag", trackInventory: false });
      await receive([piece(sugar, "2")]);
      await tenancy.archiveProduct.execute(a.context, { productId: sugar.product.id, expectedVersion: 1 });
      await tenancy.archiveProduct.execute(a.context, { productId: rice.product.id, expectedVersion: 1 });
      const id = await start();
      const before = await persisted();
      expect(await rejection(count(id, beans, { packId: carton.id, packCount: "1" }))).toBeInstanceOf(ConflictError);
      expect(await rejection(count(id, rice, pieces("1", "KG")))).toBeInstanceOf(ConflictError);
      expect(await rejection(count(id, untracked, pieces("1")))).toBeInstanceOf(ConflictError);
      expect(await persisted()).toEqual(before);
      expect((await count(id, sugar, pieces("1"))).line.countedQuantity.amountMinor).toBe(1n);
    });

    it("bounds a stocktake at 1000 distinct lines; an existing line can still be recounted", async () => {
      const id = await start();
      const world = harness.world();
      const products = Array.from(
        { length: 1000 },
        (_, index) =>
          createProduct({
            id: world.ids.newId("Product"),
            variantId: world.ids.newId("ProductVariant"),
            businessId: a.businessId,
            name: parseProductName(`Bulk item ${index}`),
            stockUnit: parseUnitCode("PIECE"),
            trackInventory: true,
            createdByMembershipId: a.membershipId,
            now: world.clock.now(),
          }).item,
      );
      await harness.unitOfWorkWith({ timeoutMs: 110_000 }).run(async (scope) => {
        for (const item of products) await repos.products.insert(scope, item);
        for (const item of products) {
          await repos.stocktakeLines.insert(
            scope,
            restoreStocktakeLine({
              businessId: a.businessId,
              stocktakeId: id,
              variantId: item.variant.id,
              status: "COUNTED",
              countedQuantity: Quantity.ofMinor(1n, item.variant.stockUnit),
              stockUnitAtCount: item.variant.stockUnit,
              expectedAtCount: Quantity.zero(item.variant.stockUnit),
              balanceVersionAtCount: 0,
              version: 1,
              countedByMembershipId: a.membershipId,
              countedAt: world.clock.now(),
            }),
          );
        }
      });
      expect(await rejection(count(id, beans, pieces("1")))).toBeInstanceOf(ValidationError);
      const first = products[0] as CatalogProduct;
      expect((await count(id, first, pieces("2"), 1)).line.version).toBe(2);
      expect((await readInventorySnapshot()).stocktakeLines).toHaveLength(1000);
    }, 120_000);
  });

  describe("remove", () => {
    it("advances versions, keeps the counted history, writes no movement or audit, repeats as a no-op and can be recounted", async () => {
      await receive([piece(beans, "5")]);
      const id = await start();
      await count(id, beans, pieces("4"));
      const before = await persisted();
      const removal = { stocktakeId: id, variantId: beans.variant.id, expectedVersion: 1 };
      const removed = await tenancy.removeStocktakeLine.execute(a.context, removal);
      expect(removed).toMatchObject({ changed: true, stocktake: { version: 3, countedLineCount: 0 } });
      expect(removed.line).toMatchObject({
        status: "REMOVED",
        version: 2,
        countedQuantity: Quantity.ofMinor(4n, parseUnitCode("PIECE")),
      });
      const again = await tenancy.removeStocktakeLine.execute(a.context, removal);
      expect(again).toMatchObject({ changed: false, stocktake: { version: 3 }, line: { version: 2 } });
      const after = await persisted();
      expect(after.inventory.movements).toEqual(before.inventory.movements);
      expect(after.audit).toEqual(before.audit);
      expect(after.inventory.stocktakeLines).toEqual([
        expect.objectContaining({ status: "REMOVED", countedText: "4", version: 2 }),
      ]);
      const recounted = await count(id, beans, pieces("5"), 2);
      expect(recounted.line).toMatchObject({ status: "COUNTED", version: 3 });
      expect(await rejection(count(id, beans, pieces("6"), 2))).toBeInstanceOf(VersionConflictError);
    });
  });

  describe("post", () => {
    let pa: CatalogProduct;
    let pb: CatalogProduct;
    let pc: CatalogProduct;
    let pd: CatalogProduct;
    let pe: CatalogProduct;
    let id: StocktakeId;

    beforeEach(async () => {
      pa = beans;
      pb = sugar;
      pc = await inventoryProduct(harness, a, { name: "Flour" });
      pd = await inventoryProduct(harness, a, { name: "Salt" });
      pe = await inventoryProduct(harness, a, { name: "Oil" });
      await receive([piece(pa, "10"), piece(pb, "10"), piece(pc, "10"), piece(pd, "10"), piece(pe, "10")]);
      id = await start();
      await count(id, pa, pieces("7"));
      await count(id, pb, pieces("15"));
      await count(id, pc, pieces("10"));
      await count(id, pe, pieces("3"));
      await tenancy.removeStocktakeLine.execute(a.context, {
        stocktakeId: id,
        variantId: pe.variant.id,
        expectedVersion: 1,
      });
    });

    it("posts a mixed stocktake: corrections for non-zero variances only, balances set, removed and uncounted lines untouched", async () => {
      const version = await versionOf(id);
      const result = await tenancy.postStocktake.execute(a.context, { stocktakeId: id, expectedVersion: version });
      expect(result.changed).toBe(true);
      expect(result.stocktake).toMatchObject({
        status: "POSTED",
        version: version + 1,
        countedLineCount: 3,
        posting: { correctionMovementCount: 2, zeroVarianceCount: 1 },
      });
      expect(result.movements.map((m) => [m.variantId, m.delta.amountMinor])).toEqual(
        [
          [pa.variant.id, -3n],
          [pb.variant.id, 5n],
        ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
      );

      const inventory = await readInventorySnapshot();
      const lines = new Map(inventory.stocktakeLines.map((row) => [row.variantId, row]));
      expect(lines.get(pa.variant.id)).toMatchObject({ varianceText: "-3", version: 1 });
      expect(lines.get(pb.variant.id)).toMatchObject({ varianceText: "5", version: 1 });
      expect(lines.get(pc.variant.id)).toMatchObject({ varianceText: "0", version: 1 });
      expect(lines.get(pe.variant.id)).toMatchObject({ status: "REMOVED", varianceText: null, version: 2 });
      expect(lines.has(pd.variant.id)).toBe(false);

      const corrections = inventory.movements.filter((row) => row.type === "COUNT_CORRECTION");
      expect(corrections).toHaveLength(2);
      expect(corrections.every((row) => row.stocktakeId === id && row.locationId === a.locationId)).toBe(true);
      const balances = new Map(inventory.balances.map((row) => [row.variantId, row.quantityText]));
      expect([pa, pb, pc, pd, pe].map((p) => balances.get(p.variant.id))).toEqual(["7", "15", "10", "10", "10"]);

      const [audit] = await auditOf("inventory.stocktake_posted");
      expect(audit).toMatchObject({ entityId: id, locationId: a.locationId });
      expect(JSON.parse(audit?.payloadText ?? "{}")).toEqual({
        countedLineCount: 3,
        correctionMovementCount: 2,
        zeroVarianceCount: 1,
      });
      expect(inventory.stocktakes.find((row) => row.id === id)).toMatchObject({
        status: "POSTED",
        version: version + 1,
      });
    });

    it("a POSTED retry with the old expectedVersion is a no-op that writes nothing", async () => {
      const version = await versionOf(id);
      await tenancy.postStocktake.execute(a.context, { stocktakeId: id, expectedVersion: version });
      const before = await persisted();
      const retry = await tenancy.postStocktake.execute(a.context, { stocktakeId: id, expectedVersion: version });
      expect(retry).toMatchObject({
        changed: false,
        movements: [],
        stocktake: { status: "POSTED", version: version + 1 },
      });
      expect(await persisted()).toEqual(before);
    });

    it("shows the posted lines with variances in FULL, hides them in BLIND, and keeps the posted-line invariants", async () => {
      await post(id);
      const full = await tenancy.listStocktakeLines.execute(a.context, { stocktakeId: id });
      for (const view of full.items) {
        expect(view.visibility).toBe("FULL");
        if (view.visibility === "FULL") {
          expect(view.variance !== undefined).toBe(view.status === "COUNTED");
        }
      }
      const keeper = await memberContext(a, "STOCK_KEEPER");
      const blind = await tenancy.listStocktakeLines.execute(keeper, { stocktakeId: id });
      expect(blind.items).toHaveLength(4);
      for (const view of blind.items) {
        expect(view.visibility).toBe("BLIND");
        expect(Object.keys(view)).not.toContain("variance");
        expect(Object.keys(view)).not.toContain("expectedAtCount");
      }
      const { stocktakeLines, movements, stocktakes } = await readInventorySnapshot();
      const postedIds = new Set(stocktakes.filter((row) => row.status === "POSTED").map((row) => row.id));
      for (const row of stocktakeLines) {
        expect(row.varianceText !== null).toBe(postedIds.has(row.stocktakeId) && row.status === "COUNTED");
      }
      for (const movement of movements.filter((row) => row.type === "COUNT_CORRECTION")) {
        const owner = stocktakeLines.find(
          (row) => row.stocktakeId === movement.stocktakeId && row.variantId === movement.variantId,
        );
        expect(postedIds.has(movement.stocktakeId as string)).toBe(true);
        expect(owner).toMatchObject({ status: "COUNTED", varianceText: movement.deltaText });
      }
    });

    it("rolls back every write when a later posting step fails", async () => {
      const failAfter = <T extends object>(repository: T, method: keyof T & string): T => ({
        ...repository,
        async [method](...args: unknown[]) {
          await (repository[method] as (...inner: unknown[]) => Promise<unknown>).apply(repository, args);
          throw new Error(`injected failure after ${method}`);
        },
      });
      const decorations: Partial<DatabaseRepositories>[] = [
        { inventoryMovements: failAfter(repos.inventoryMovements, "insertMany") },
        { inventoryBalances: failAfter(repos.inventoryBalances, "apply") },
        { stocktakeLines: failAfter(repos.stocktakeLines, "applyPostingVariances") },
        { stocktakes: failAfter(repos.stocktakes, "update") },
        { auditWriter: failAfter(repos.auditWriter, "recordBusinessEvent") },
      ];
      const before = await persisted();
      for (const decorate of decorations) {
        await expect(post(id, harness.compose({ decorate }))).rejects.toThrow("injected failure after");
        expect(await persisted()).toEqual(before);
        expect(await readInventoryConsistency()).toEqual([]);
      }
      expect((await post(id)).changed).toBe(true);
    });

    it("the consistency check detects a corrupted balance after a COUNT_CORRECTION", async () => {
      await post(id);
      const corrupt = (delta: number) =>
        harness.owner.query(
          `UPDATE inventory_balances SET quantity_minor = quantity_minor + $3
           WHERE business_id = $1 AND variant_id = $2`,
          [a.businessId, pa.variant.id, delta],
        );
      await corrupt(1);
      try {
        expect((await readInventoryConsistency()).map((issue) => issue.kind)).toContain("BALANCE_QUANTITY_MISMATCH");
      } finally {
        await corrupt(-1);
      }
    });
  });

  describe("staleness", () => {
    it("a receipt, adjustment, write-off or stock-unit change since counting makes the post STOCKTAKE_STALE and writes nothing", async () => {
      await receive([piece(beans, "10")]);
      const unitless = await inventoryProduct(harness, a, { name: "Loose tea" });
      const cases: readonly [CatalogProduct, () => Promise<unknown>][] = [
        [beans, () => receive([piece(beans, "1")])],
        [
          beans,
          () =>
            tenancy.recordAdjustment.execute(a.context, {
              lines: [{ ...piece(beans, "1"), direction: "INCREASE" }],
              reasonCode: "FOUND_STOCK",
              idempotencyKey: key(),
            }),
        ],
        [
          beans,
          () =>
            tenancy.recordWriteOff.execute(a.context, {
              lines: [piece(beans, "1")],
              reasonCode: "DAMAGED",
              idempotencyKey: key(),
            }),
        ],
        [
          unitless,
          () =>
            tenancy.updateProduct.execute(a.context, {
              productId: unitless.product.id,
              expectedVersion: 1,
              stockUnit: "KG",
            }),
        ],
      ];
      for (const [product, intervene] of cases) {
        const id = await start();
        await count(id, product, pieces("0"));
        await count(id, sugar, pieces("0"));
        await intervene();
        const before = await persisted();
        const error = await rejection(post(id));
        expect(error).toBeInstanceOf(StocktakeStaleError);
        expect((error as StocktakeStaleError).staleVariantIds).toEqual([product.variant.id]);
        expect((error as StocktakeStaleError).staleLineCount).toBe(1);
        expect(await persisted()).toEqual(before);
        expect((await tenancy.getStocktake.execute(a.context, { stocktakeId: id })).status).toBe("DRAFT");
        await cancel(id);
      }
    });
  });

  it("corrections are written only by posting: counting, removing and cancelling write none", async () => {
    await receive([piece(beans, "10")]);
    const id = await start();
    await count(id, beans, pieces("3"));
    await count(id, sugar, pieces("2"));
    await tenancy.removeStocktakeLine.execute(a.context, {
      stocktakeId: id,
      variantId: sugar.variant.id,
      expectedVersion: 1,
    });
    await cancel(id);
    expect((await readInventorySnapshot()).movements.filter((row) => row.type === "COUNT_CORRECTION")).toEqual([]);
    const cancelled = await auditOf("inventory.stocktake_cancelled");
    expect(cancelled.map((row) => JSON.parse(row.payloadText) as unknown)).toEqual([{ countedLineCount: 1 }]);
    expect(
      await rejection(tenancy.postStocktake.execute(a.context, { stocktakeId: id, expectedVersion: 5 })),
    ).toBeInstanceOf(ConflictError);
  });

  describe("inventory reads", () => {
    it("lists, gets and pages item history at the context's location, hiding invisible and foreign items", async () => {
      const carton = await inventoryPack(harness, beans.variant, "Carton", 12n);
      await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [{ variantId: beans.variant.id, packId: carton.id, packCount: "2" }],
        idempotencyKey: key(),
      });
      await tenancy.setLowStockThreshold.execute(a.context, {
        variantId: beans.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "30", unit: "PIECE" },
      });
      const id = await start();
      await count(id, beans, pieces("20"));
      await post(id);
      const untracked = await inventoryProduct(harness, a, { name: "Bag", trackInventory: false });

      const listed = await tenancy.listInventoryItems.execute(a.context);
      expect(listed.items.map((item) => item.variantId)).toEqual([rice, beans, sugar].map((p) => p.variant.id).sort());
      const item = await tenancy.getInventoryItem.execute(a.context, { variantId: beans.variant.id });
      expect(item).toMatchObject({
        onHand: Quantity.ofMinor(20n, parseUnitCode("PIECE")),
        balanceVersion: 2,
        threshold: Quantity.ofMinor(30n, parseUnitCode("PIECE")),
        thresholdVersion: 1,
        lowStock: true,
      });
      expect(
        (await tenancy.listInventoryItems.execute(a.context, { lowStockOnly: true })).items.map((i) => i.variantId),
      ).toEqual([beans.variant.id]);
      expect(
        await rejection(tenancy.getInventoryItem.execute(a.context, { variantId: untracked.variant.id })),
      ).toBeInstanceOf(NotFoundError);
      expect(
        await rejection(tenancy.getInventoryItem.execute(b.context, { variantId: beans.variant.id })),
      ).toBeInstanceOf(NotFoundError);

      const history = await tenancy.listItemMovements.execute(a.context, { variantId: beans.variant.id, limit: 1 });
      expect(history.items.map((m) => [m.type, m.balanceVersion])).toEqual([["COUNT_CORRECTION", 2]]);
      expect(history.items[0]?.source).toEqual({ kind: "STOCKTAKE", id });
      const cursor = history.nextCursor;
      if (cursor === null) throw new Error("expected a second page");
      const older = await tenancy.listItemMovements.execute(a.context, {
        variantId: beans.variant.id,
        limit: 1,
        after: cursor,
      });
      expect(older.items.map((m) => [m.type, m.pack?.packId])).toEqual([["PURCHASE_RECEIPT", carton.id]]);
      expect(older.nextCursor).toBeNull();
      expect(
        await rejection(
          tenancy.listItemMovements.execute(a.context, {
            variantId: sugar.variant.id,
            after: cursor,
          }),
        ),
      ).toBeInstanceOf(ValidationError);
      expect(
        await rejection(tenancy.listItemMovements.execute(b.context, { variantId: beans.variant.id })),
      ).toBeInstanceOf(NotFoundError);
    });

    it("gets each document with its movements at the context's location only", async () => {
      const opening = await tenancy.recordOpeningStock.execute(a.context, {
        lines: [piece(sugar, "4")],
        idempotencyKey: key(),
      });
      const receipt = await receive([piece(sugar, "2"), piece(beans, "1")]);
      await tenancy.reverseGoodsReceipt.execute(a.context, { documentId: receipt.document.id, reason: "Wrong" });
      const adjustment = await tenancy.recordWriteOff.execute(a.context, {
        lines: [piece(sugar, "1")],
        reasonCode: "DAMAGED",
        idempotencyKey: key(),
      });

      const gotOpening = await tenancy.getOpeningBatch.execute(a.context, { documentId: opening.document.id });
      expect(gotOpening.movements.map((m) => m.type)).toEqual(["OPENING"]);
      const gotReceipt = await tenancy.getGoodsReceipt.execute(a.context, { documentId: receipt.document.id });
      expect(gotReceipt.document.status).toBe("REVERSED");
      expect(gotReceipt.movements.map((m) => m.reversesMovementId === undefined)).toEqual([true, true, false, false]);
      const gotAdjustment = await tenancy.getAdjustment.execute(a.context, { documentId: adjustment.document.id });
      expect(gotAdjustment.movements.map((m) => m.type)).toEqual(["WRITE_OFF"]);

      const backStore = await secondLocation(harness, a.businessId);
      const elsewhere = { ...a.context, locationId: backStore };
      const hidden: (() => Promise<unknown>)[] = [
        () => tenancy.getOpeningBatch.execute(elsewhere, { documentId: opening.document.id }),
        () => tenancy.getGoodsReceipt.execute(b.context, { documentId: receipt.document.id }),
        () => tenancy.getAdjustment.execute(b.context, { documentId: adjustment.document.id }),
      ];
      for (const attempt of hidden) expect(await rejection(attempt())).toBeInstanceOf(NotFoundError);
    });
  });
});
