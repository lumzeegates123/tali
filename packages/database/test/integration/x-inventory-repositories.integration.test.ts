import { ConcurrentModificationError, sealLockedBalances, type TransactionScope } from "@tali/application";
import {
  type AdjustmentReason,
  BusinessDate,
  type CatalogProduct,
  createGoodsReceipt,
  createInventoryAdjustment,
  createInventoryRecording,
  createOpeningBatch,
  type InventoryMovement,
  type InventoryMovementSource,
  type InventoryMovementType,
  type InventoryRecording,
  type LocationId,
  parseGoodsReceiptReference,
  parseInventoryNote,
  parseInventoryReasonNote,
  parsePackSnapshot,
  parseTimeZoneId,
  planStockChange,
  type ProductVariantId,
  Quantity,
  restoreStockBalance,
  restoreStockThreshold,
  reverseDocumentMovements,
  reverseGoodsReceipt,
  reverseInventoryAdjustment,
  type StockChangeLine,
} from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInventoryConsistency } from "../../src/testing/index.js";
import { gate } from "../support/harness.js";
import {
  type InventoryTenant,
  inventoryPack,
  inventoryProduct,
  inventoryTenant,
  rejection,
  secondLocation,
} from "../support/inventory.js";
import { sqlState } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const LOCK_NOT_AVAILABLE = "55P03";
const LAGOS = parseTimeZoneId("Africa/Lagos");

/**
 * The Build 2 Slice 5 inventory adapters (ADR-008 sections 7, 8 and 11)
 * against the migrated test database, as the application role: balance
 * creation and ascending row locks, the version-guarded balance write, the
 * append-only movement ledger and its original-line listing, document headers
 * and their one reversal, thresholds, the catalog's inventory state reader,
 * and the DATE round trip. Every scenario leaves the ledger consistent.
 */
describe("inventory repositories (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  let a: InventoryTenant;
  let b: InventoryTenant;
  let rice: CatalogProduct;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const ids = () => harness.world().ids;
  const run = <T>(work: (scope: TransactionScope) => Promise<T>) => harness.unitOfWork.run(work);
  const qty = (minor: bigint, product: CatalogProduct) => Quantity.ofMinor(minor, product.variant.stockUnit);
  const recording = (t: InventoryTenant, now = harness.world().clock.now()): InventoryRecording =>
    createInventoryRecording({
      actorMembershipId: t.membershipId,
      sourceChannel: "web",
      correlationId: "test-request",
      now,
      timeZone: LAGOS,
    });

  beforeEach(async () => {
    a = await inventoryTenant(harness, "inventory-repos-a");
    b = await inventoryTenant(harness, "inventory-repos-b");
    rice = await inventoryProduct(harness, a, { name: "Rice", stockUnit: "KG" });
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  /** Locks, plans, appends and applies one document's lines in one transaction, as the use cases do. */
  async function post(props: {
    readonly t?: InventoryTenant;
    readonly locationId?: LocationId;
    readonly type: InventoryMovementType;
    readonly source: InventoryMovementSource;
    readonly lines: readonly Omit<StockChangeLine, "movementId">[];
    readonly reason?: AdjustmentReason;
    readonly recording?: InventoryRecording;
  }): Promise<readonly InventoryMovement[]> {
    const t = props.t ?? a;
    const locationId = props.locationId ?? t.locationId;
    return run(async (scope) => {
      const variantIds = new Set(props.lines.map((line) => line.variantId));
      await repos.products.lockVariantsForShare(scope, t.businessId, variantIds);
      const locked = await repos.inventoryBalances.lockForUpdate(scope, t.businessId, locationId, variantIds);
      const plan = planStockChange({
        businessId: t.businessId,
        locationId,
        type: props.type,
        source: props.source,
        lines: props.lines.map((line) => ({ ...line, movementId: ids().newId("InventoryMovement") })),
        balances: locked.balances,
        ...(props.reason === undefined ? {} : { reason: props.reason }),
        recording: props.recording ?? recording(t),
      });
      await repos.inventoryMovements.insertMany(scope, plan.movements);
      await repos.inventoryBalances.apply(scope, locked, plan.balances);
      return plan.movements;
    });
  }

  async function receipt(t: InventoryTenant = a, locationId: LocationId = t.locationId) {
    const header = createGoodsReceipt({
      id: ids().newId("GoodsReceipt"),
      businessId: t.businessId,
      locationId,
      reference: parseGoodsReceiptReference("INV-1"),
      note: parseInventoryNote("Morning delivery"),
      recording: recording(t),
    });
    await run((scope) => repos.goodsReceipts.insert(scope, header));
    return header;
  }

  const receiptSource = (id: string) => ({ kind: "GOODS_RECEIPT", id }) as InventoryMovementSource;

  describe("balances", () => {
    it("lockForUpdate creates missing rows at version 0 in the stock unit, in ascending order, and keeps existing rows", async () => {
      const doc = await receipt();
      await post({
        type: "PURCHASE_RECEIPT",
        source: receiptSource(doc.id),
        lines: [{ variantId: beans.variant.id, delta: qty(7n, beans) }],
      });
      const requested = [sugar.variant.id, rice.variant.id, beans.variant.id];
      const locked = await run((scope) =>
        repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set(requested)),
      );
      expect(locked.balances.map((balance) => balance.variantId)).toEqual([...requested].sort());
      const byVariant = new Map(locked.balances.map((balance) => [balance.variantId, balance]));
      expect(byVariant.get(rice.variant.id)).toEqual({
        businessId: a.businessId,
        locationId: a.locationId,
        variantId: rice.variant.id,
        quantity: Quantity.zero(rice.variant.stockUnit),
        version: 0,
      });
      expect(byVariant.get(rice.variant.id)?.quantity.unit).toBe("KG");
      expect(byVariant.get(beans.variant.id)).toMatchObject({ quantity: qty(7n, beans), version: 1 });
      const { rows } = await harness.owner.query<{ variant_id: string; quantity: string; version: number }>(
        `SELECT variant_id::text, quantity_minor::text AS quantity, version FROM inventory_balances
         WHERE business_id = $1 ORDER BY variant_id`,
        [a.businessId],
      );
      expect(rows).toHaveLength(3);
      expect(
        await run((scope) => repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set())),
      ).toMatchObject({ balances: [] });
    });

    const holdBalances = async (variantIds: readonly ProductVariantId[]) => {
      const locked = gate();
      const release = gate();
      const holder = run(async (scope) => {
        await repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set(variantIds));
        locked.open();
        await release.opened;
      });
      await locked.opened;
      return async () => {
        release.open();
        await holder;
      };
    };
    const lockQuickly = (variantIds: readonly ProductVariantId[]) =>
      harness
        .unitOfWorkWith({ lockTimeoutMs: 200 })
        .run((scope) => repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set(variantIds)));

    it("a concurrent first lock of the same stock item waits for the creating transaction instead of failing", async () => {
      const finish = await holdBalances([rice.variant.id]);
      expect(await rejection(lockQuickly([rice.variant.id]))).toBeInstanceOf(ConcurrentModificationError);
      const waiting = run((scope) =>
        repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set([rice.variant.id])),
      );
      await finish();
      expect((await waiting).balances).toHaveLength(1);
      const { rows } = await harness.owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM inventory_balances WHERE variant_id = $1`,
        [rice.variant.id],
      );
      expect(rows[0]?.n).toBe("1");
    });

    it("holds existing balance rows FOR UPDATE until the transaction ends", async () => {
      await run((scope) =>
        repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set([rice.variant.id])),
      );
      const finish = await holdBalances([rice.variant.id]);
      expect(
        await sqlState(
          harness.owner.query(`SELECT 1 FROM inventory_balances WHERE variant_id = $1 FOR UPDATE NOWAIT`, [
            rice.variant.id,
          ]),
        ),
      ).toBe(LOCK_NOT_AVAILABLE);
      expect(await rejection(lockQuickly([rice.variant.id]))).toBeInstanceOf(ConcurrentModificationError);
      expect((await lockQuickly([beans.variant.id])).balances).toHaveLength(1);
      await finish();
      expect((await lockQuickly([rice.variant.id])).balances).toHaveLength(1);
    });

    it("apply writes only locked balances at their locked version; a stale version is ConcurrentModificationError", async () => {
      const doc = await receipt();
      const [movement] = await post({
        type: "PURCHASE_RECEIPT",
        source: receiptSource(doc.id),
        lines: [{ variantId: rice.variant.id, delta: qty(1500n, rice) }],
      });
      await run(async (scope) => {
        expect(await repos.inventoryBalances.find(scope, a.businessId, a.locationId, rice.variant.id)).toEqual({
          businessId: a.businessId,
          locationId: a.locationId,
          variantId: rice.variant.id,
          quantity: qty(1500n, rice),
          version: 1,
          lastMovementId: movement?.id,
        });
        expect(await repos.inventoryBalances.find(scope, b.businessId, a.locationId, rice.variant.id)).toBe(undefined);
      });
      const stockItem = { businessId: a.businessId, locationId: a.locationId };
      const stale = sealLockedBalances({
        ...stockItem,
        balances: [
          restoreStockBalance({ ...stockItem, variantId: rice.variant.id, quantity: qty(0n, rice), version: 0 }),
        ],
      });
      const next = restoreStockBalance({
        ...stockItem,
        variantId: rice.variant.id,
        quantity: qty(1n, rice),
        version: 1,
        lastMovementId: ids().newId("InventoryMovement"),
      });
      expect(await rejection(run((scope) => repos.inventoryBalances.apply(scope, stale, [next])))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      const unlocked = restoreStockBalance({
        ...stockItem,
        variantId: beans.variant.id,
        quantity: qty(0n, beans),
        version: 0,
      });
      await expect(run((scope) => repos.inventoryBalances.apply(scope, stale, [unlocked]))).rejects.toThrow(
        "only a locked balance can be applied",
      );
      await run(async (scope) => {
        expect((await repos.inventoryBalances.find(scope, a.businessId, a.locationId, rice.variant.id))?.version).toBe(
          1,
        );
      });
    });
  });

  describe("movements", () => {
    it("listOriginals returns one document's originals only, by variant ascending, with rows inserted out of order", async () => {
      const doc = await receipt();
      const other = await receipt();
      const first = await post({
        type: "PURCHASE_RECEIPT",
        source: receiptSource(doc.id),
        lines: [{ variantId: sugar.variant.id, delta: qty(3n, sugar) }],
      });
      await post({
        type: "PURCHASE_RECEIPT",
        source: receiptSource(other.id),
        lines: [{ variantId: beans.variant.id, delta: qty(9n, beans) }],
      });
      const pack = await inventoryPack(harness, beans.variant, "Carton", 24n);
      const second = await post({
        type: "PURCHASE_RECEIPT",
        source: receiptSource(doc.id),
        lines: [
          { variantId: rice.variant.id, delta: qty(2000n, rice) },
          {
            variantId: beans.variant.id,
            delta: qty(48n, beans),
            pack: parsePackSnapshot({ packId: pack.id, name: pack.name, count: 2n, factorMinor: 24n }),
          },
        ],
      });
      const originals = [...first, ...second].sort((x, y) => (x.variantId < y.variantId ? -1 : 1));
      const listed = await run((scope) =>
        repos.inventoryMovements.listOriginals(scope, a.businessId, receiptSource(doc.id)),
      );
      expect(listed).toEqual(originals);
      expect(listed.map((movement) => movement.variantId)).toEqual(
        [sugar.variant.id, rice.variant.id, beans.variant.id].sort(),
      );

      await run(async (scope) => {
        const reversed = reverseGoodsReceipt({
          receipt: doc,
          reversedByMembershipId: a.membershipId,
          reason: parseInventoryReasonNote("Wrong supplier"),
          now: harness.world().clock.now(),
        });
        const current = await repos.goodsReceipts.findByIdForUpdate(scope, a.businessId, doc.id);
        if (current === undefined) throw new Error("receipt exists");
        const variantIds = new Set(listed.map((movement) => movement.variantId));
        await repos.products.lockVariantsForShare(scope, a.businessId, variantIds);
        const locked = await repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, variantIds);
        const plan = reverseDocumentMovements({
          originals: listed,
          balances: locked.balances,
          reversalMovementIds: new Map(listed.map((movement) => [movement.id, ids().newId("InventoryMovement")])),
          reason: parseInventoryReasonNote("Wrong supplier"),
          recording: recording(a),
        });
        await repos.inventoryMovements.insertMany(scope, plan.movements);
        await repos.inventoryBalances.apply(scope, locked, plan.balances);
        await repos.goodsReceipts.markReversed(scope, current, reversed);
      });
      expect(
        await run((scope) => repos.inventoryMovements.listOriginals(scope, a.businessId, receiptSource(doc.id))),
      ).toEqual(originals);
      expect(
        await run((scope) => repos.inventoryMovements.listOriginals(scope, b.businessId, receiptSource(doc.id))),
      ).toEqual([]);
      const { rows } = await harness.owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM inventory_movements WHERE goods_receipt_id = $1 AND reverses_movement_id IS NOT NULL`,
        [doc.id],
      );
      expect(rows[0]?.n).toBe("3");
    });

    it("round-trips adjustment and write-off reasons and the business DATE in the business time zone", async () => {
      const lateEvening = new Date("2026-09-30T23:30:00.000Z");
      const rec = recording(a, lateEvening);
      expect(rec.businessDate.toString()).toBe("2026-10-01");
      const adjustment = createInventoryAdjustment({
        id: ids().newId("InventoryAdjustment"),
        businessId: a.businessId,
        locationId: a.locationId,
        kind: "ADJUSTMENT",
        reason: { reasonCode: "OTHER", reasonNote: parseInventoryReasonNote("Supplier bonus") },
        recording: rec,
      });
      await run((scope) => repos.inventoryAdjustments.insert(scope, adjustment));
      const source = { kind: "ADJUSTMENT", id: adjustment.id } as InventoryMovementSource;
      const posted = await post({
        type: "ADJUSTMENT",
        source,
        lines: [{ variantId: sugar.variant.id, delta: qty(4n, sugar) }],
        reason: { reasonCode: "OTHER", reasonNote: parseInventoryReasonNote("Supplier bonus") },
        recording: rec,
      });
      const listed = await run((scope) => repos.inventoryMovements.listOriginals(scope, a.businessId, source));
      expect(listed).toEqual(posted);
      expect(listed[0]?.businessDate).toEqual(BusinessDate.parse("2026-10-01"));
      expect(await run((scope) => repos.inventoryAdjustments.findById(scope, a.businessId, adjustment.id))).toEqual(
        adjustment,
      );
      const { rows } = await harness.owner.query<{ movement: string; header: string }>(
        `SELECT m.business_date::text AS movement, h.business_date::text AS header
         FROM inventory_movements m JOIN inventory_adjustments h ON h.id = m.adjustment_id WHERE h.id = $1`,
        [adjustment.id],
      );
      expect(rows).toEqual([{ movement: "2026-10-01", header: "2026-10-01" }]);
    });
  });

  describe("document headers", () => {
    it("opening batches round-trip and are tenant-scoped", async () => {
      const batch = createOpeningBatch({
        id: ids().newId("OpeningBatch"),
        businessId: a.businessId,
        locationId: a.locationId,
        note: parseInventoryNote("First count"),
        recording: recording(a),
      });
      await run((scope) => repos.inventoryOpeningBatches.insert(scope, batch));
      await post({
        type: "OPENING",
        source: { kind: "OPENING_BATCH", id: batch.id },
        lines: [{ variantId: rice.variant.id, delta: qty(10_000n, rice) }],
      });
      await run(async (scope) => {
        expect(await repos.inventoryOpeningBatches.findById(scope, a.businessId, batch.id)).toEqual(batch);
        expect(await repos.inventoryOpeningBatches.findById(scope, b.businessId, batch.id)).toBe(undefined);
      });
      expect(Object.keys(repos.inventoryOpeningBatches).sort()).toEqual(["findById", "insert"]);
    });

    it("a goods receipt round-trips, locks FOR UPDATE, and is reversed exactly once", async () => {
      const doc = await receipt();
      await post({
        type: "PURCHASE_RECEIPT",
        source: receiptSource(doc.id),
        lines: [{ variantId: beans.variant.id, delta: qty(5n, beans) }],
      });
      await run(async (scope) => {
        expect(await repos.goodsReceipts.findById(scope, a.businessId, doc.id)).toEqual(doc);
        expect(await repos.goodsReceipts.findById(scope, b.businessId, doc.id)).toBe(undefined);
        expect(await repos.goodsReceipts.findByIdForUpdate(scope, b.businessId, doc.id)).toBe(undefined);
      });
      const locked = gate();
      const release = gate();
      const holder = run(async (scope) => {
        await repos.goodsReceipts.findByIdForUpdate(scope, a.businessId, doc.id);
        locked.open();
        await release.opened;
      });
      await locked.opened;
      expect(
        await sqlState(harness.owner.query(`SELECT 1 FROM goods_receipts WHERE id = $1 FOR UPDATE NOWAIT`, [doc.id])),
      ).toBe(LOCK_NOT_AVAILABLE);
      release.open();
      await holder;

      const reversed = reverseGoodsReceipt({
        receipt: doc,
        reversedByMembershipId: a.membershipId,
        reason: parseInventoryReasonNote("Wrong supplier"),
        now: harness.world().clock.now(),
      });
      await run((scope) => repos.goodsReceipts.markReversed(scope, doc, reversed));
      expect(await run((scope) => repos.goodsReceipts.findById(scope, a.businessId, doc.id))).toEqual(reversed);
      expect(await rejection(run((scope) => repos.goodsReceipts.markReversed(scope, doc, reversed)))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      await expect(run((scope) => repos.goodsReceipts.markReversed(scope, reversed, reversed))).rejects.toThrow(
        "from POSTED to REVERSED",
      );
      const { rows } = await harness.owner.query<{ reference: string; note: string; status: string }>(
        `SELECT reference, note, status FROM goods_receipts WHERE id = $1`,
        [doc.id],
      );
      expect(rows).toEqual([{ reference: "INV-1", note: "Morning delivery", status: "REVERSED" }]);
    });

    it("an adjustment is reversed exactly once and keeps its kind and reason", async () => {
      const writeOff = createInventoryAdjustment({
        id: ids().newId("InventoryAdjustment"),
        businessId: a.businessId,
        locationId: a.locationId,
        kind: "WRITE_OFF",
        reason: { reasonCode: "EXPIRED" },
        recording: recording(a),
      });
      await run((scope) => repos.inventoryAdjustments.insert(scope, writeOff));
      const reversed = reverseInventoryAdjustment({
        adjustment: writeOff,
        reversedByMembershipId: a.membershipId,
        reason: parseInventoryReasonNote("Not expired"),
        now: harness.world().clock.now(),
      });
      await run(async (scope) => {
        expect(await repos.inventoryAdjustments.findByIdForUpdate(scope, a.businessId, writeOff.id)).toEqual(writeOff);
        expect(await repos.inventoryAdjustments.findByIdForUpdate(scope, b.businessId, writeOff.id)).toBe(undefined);
        await repos.inventoryAdjustments.markReversed(scope, writeOff, reversed);
      });
      expect(await run((scope) => repos.inventoryAdjustments.findById(scope, a.businessId, writeOff.id))).toEqual(
        reversed,
      );
      expect(
        await rejection(run((scope) => repos.inventoryAdjustments.markReversed(scope, writeOff, reversed))),
      ).toBeInstanceOf(ConcurrentModificationError);
    });
  });

  describe("thresholds", () => {
    const threshold = (minor: bigint | undefined, version: number, id = ids().newId("StockThreshold")) =>
      restoreStockThreshold({
        id,
        businessId: a.businessId,
        locationId: a.locationId,
        variantId: rice.variant.id,
        ...(minor === undefined ? {} : { threshold: qty(minor, rice) }),
        version,
      });

    it("insertIfAbsent inserts once; update is version-guarded; clearing keeps the row; all tenant-scoped", async () => {
      const first = threshold(500n, 1);
      expect(await run((scope) => repos.inventoryThresholds.insertIfAbsent(scope, first))).toBe("inserted");
      expect(await run((scope) => repos.inventoryThresholds.insertIfAbsent(scope, threshold(700n, 1)))).toBe("exists");
      await run(async (scope) => {
        expect(await repos.inventoryThresholds.find(scope, a.businessId, a.locationId, rice.variant.id)).toEqual(first);
        expect(
          await repos.inventoryThresholds.findForUpdate(scope, a.businessId, a.locationId, rice.variant.id),
        ).toEqual(first);
        expect(await repos.inventoryThresholds.find(scope, b.businessId, a.locationId, rice.variant.id)).toBe(
          undefined,
        );
        expect(await repos.inventoryThresholds.find(scope, a.businessId, a.locationId, beans.variant.id)).toBe(
          undefined,
        );
      });
      const changed = threshold(800n, 2, first.id);
      await run((scope) => repos.inventoryThresholds.update(scope, first, changed));
      expect(await rejection(run((scope) => repos.inventoryThresholds.update(scope, first, changed)))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      await expect(
        run((scope) => repos.inventoryThresholds.update(scope, changed, threshold(1n, 4, first.id))),
      ).rejects.toThrow("advance its version by one");
      const cleared = threshold(undefined, 3, first.id);
      await run((scope) => repos.inventoryThresholds.update(scope, changed, cleared));
      const stored = await run((scope) =>
        repos.inventoryThresholds.find(scope, a.businessId, a.locationId, rice.variant.id),
      );
      expect(stored).toEqual(cleared);
      expect(stored?.threshold).toBe(undefined);
      const { rows } = await harness.owner.query<{ value: string | null; version: number; ordered: boolean }>(
        `SELECT low_stock_threshold_minor::text AS value, version, updated_at >= created_at AS ordered
         FROM inventory_stock_thresholds WHERE business_id = $1`,
        [a.businessId],
      );
      expect(rows).toEqual([{ value: null, version: 3, ordered: true }]);
    });

    it("findForUpdate holds the row until the transaction ends", async () => {
      await run((scope) => repos.inventoryThresholds.insertIfAbsent(scope, threshold(5n, 1)));
      const locked = gate();
      const release = gate();
      const holder = run(async (scope) => {
        await repos.inventoryThresholds.findForUpdate(scope, a.businessId, a.locationId, rice.variant.id);
        locked.open();
        await release.opened;
      });
      await locked.opened;
      expect(
        await sqlState(
          harness.owner.query(`SELECT 1 FROM inventory_stock_thresholds WHERE variant_id = $1 FOR UPDATE NOWAIT`, [
            rice.variant.id,
          ]),
        ),
      ).toBe(LOCK_NOT_AVAILABLE);
      release.open();
      await holder;
    });
  });

  describe("the catalog's inventory state reader", () => {
    const stateOf = (businessId: InventoryTenant["businessId"], variantId: ProductVariantId) =>
      run((scope) => repos.variantInventoryState.stateOf(scope, businessId, variantId));
    const none = { hasMovements: false, hasNonZeroBalance: false, hasConfiguredThreshold: false };

    it("reports all three facts across every location, ignores version-0 rows and cleared thresholds, and is tenant-scoped", async () => {
      expect(await stateOf(a.businessId, rice.variant.id)).toEqual(none);
      await run((scope) =>
        repos.inventoryBalances.lockForUpdate(scope, a.businessId, a.locationId, new Set([rice.variant.id])),
      );
      expect(await stateOf(a.businessId, rice.variant.id)).toEqual(none);

      const backStore = await secondLocation(harness, a.businessId);
      const doc = await receipt(a, backStore);
      await post({
        locationId: backStore,
        type: "PURCHASE_RECEIPT",
        source: receiptSource(doc.id),
        lines: [{ variantId: rice.variant.id, delta: qty(250n, rice) }],
      });
      expect(await stateOf(a.businessId, rice.variant.id)).toEqual({
        ...none,
        hasMovements: true,
        hasNonZeroBalance: true,
      });

      const writeOff = createInventoryAdjustment({
        id: ids().newId("InventoryAdjustment"),
        businessId: a.businessId,
        locationId: backStore,
        kind: "WRITE_OFF",
        reason: { reasonCode: "SPOILED" },
        recording: recording(a),
      });
      await run((scope) => repos.inventoryAdjustments.insert(scope, writeOff));
      await post({
        locationId: backStore,
        type: "WRITE_OFF",
        source: { kind: "ADJUSTMENT", id: writeOff.id },
        lines: [{ variantId: rice.variant.id, delta: qty(-250n, rice) }],
        reason: { reasonCode: "SPOILED" },
      });
      expect(await stateOf(a.businessId, rice.variant.id)).toEqual({ ...none, hasMovements: true });

      const configured = restoreStockThreshold({
        id: ids().newId("StockThreshold"),
        businessId: a.businessId,
        locationId: backStore,
        variantId: beans.variant.id,
        threshold: qty(3n, beans),
        version: 1,
      });
      await run((scope) => repos.inventoryThresholds.insertIfAbsent(scope, configured));
      expect(await stateOf(a.businessId, beans.variant.id)).toEqual({ ...none, hasConfiguredThreshold: true });
      const cleared = restoreStockThreshold({
        id: configured.id,
        businessId: a.businessId,
        locationId: backStore,
        variantId: beans.variant.id,
        version: 2,
      });
      await run((scope) => repos.inventoryThresholds.update(scope, configured, cleared));
      expect(await stateOf(a.businessId, beans.variant.id)).toEqual(none);

      expect(await stateOf(b.businessId, rice.variant.id)).toEqual(none);
      const theirs = await inventoryProduct(harness, b, { name: "Rice" });
      expect(await stateOf(b.businessId, theirs.variant.id)).toEqual(none);
      expect(await stateOf(a.businessId, theirs.variant.id)).toEqual(none);
    });
  });
});
