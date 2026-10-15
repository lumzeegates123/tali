import { catalogAuditActions, inventoryAuditActions, PermissionDeniedError } from "@tali/application";
import type { CatalogProduct, StocktakeId } from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseRepositories } from "../../src/database.js";
import {
  readCatalogSnapshot,
  readInventoryConsistency,
  readInventorySnapshot,
  readTenancySnapshot,
} from "../../src/testing/index.js";
import { type InventoryTenant, inventoryProduct, inventoryTenant, rejection } from "../support/inventory.js";
import { type Tenancy, useTenancyHarness } from "../support/tenancy.js";

/**
 * Build 2 Slice 8 audit coverage over PostgreSQL (ADR-008 section 16): every
 * catalog and inventory mutation writes exactly the designed action or action
 * set with its envelope and bounded payload, in the same transaction as the
 * change. A keyed replay, a successful no-op and a denial write nothing;
 * stocktake counting and line removal are draft work and are not audited.
 */
describe("Build 2 audit coverage (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  let tenancy: Tenancy;
  let a: InventoryTenant;
  let rice: CatalogProduct;
  let beans: CatalogProduct;

  const PAYLOAD_LIMIT_BYTES = 8 * 1024;
  const key = () => harness.world().ids.newId("IdempotencyKey");
  const piece = (product: CatalogProduct, quantityMinor: string) => ({
    variantId: product.variant.id,
    quantityMinor,
    unit: "PIECE",
  });

  interface AuditRow {
    action: string;
    entityType: string;
    entityId: string;
    actorType: string;
    actorMembershipId: string | null;
    locationId: string | null;
    sourceChannel: string;
    correlationId: string;
    idempotencyKey: string | null;
    reason: string | null;
    payload: Record<string, unknown>;
    payloadBytes: number;
  }

  async function auditRows(): Promise<AuditRow[]> {
    const { rows } = await harness.owner.query<Omit<AuditRow, "payload"> & { payloadText: string }>(
      `SELECT action, entity_type AS "entityType", entity_id AS "entityId", actor_type AS "actorType",
              actor_membership_id AS "actorMembershipId", location_id AS "locationId",
              source_channel AS "sourceChannel", correlation_id AS "correlationId",
              idempotency_key AS "idempotencyKey", reason, payload::text AS "payloadText",
              octet_length(payload::text) AS "payloadBytes"
       FROM public.business_audit_records WHERE business_id = $1 ORDER BY id`,
      [a.businessId],
    );
    return rows.map(({ payloadText, ...row }) => ({
      ...row,
      payload: JSON.parse(payloadText) as Record<string, unknown>,
    }));
  }

  /** The audit rows a single call writes, plus its result. */
  async function audited<T>(call: () => Promise<T>): Promise<{ result: T; rows: AuditRow[] }> {
    const before = (await auditRows()).length;
    const result = await call();
    return { result, rows: (await auditRows()).slice(before) };
  }

  const actions = (rows: readonly AuditRow[]) => rows.map((row) => row.action);

  function expectEnvelope(row: AuditRow | undefined, locationId: string | null) {
    expect(row).toMatchObject({
      actorType: "user",
      actorMembershipId: a.membershipId,
      locationId,
      sourceChannel: a.context.sourceChannel,
      correlationId: a.context.correlationId,
    });
  }

  async function versionOf(stocktakeId: StocktakeId): Promise<number> {
    return (await tenancy.getStocktake.execute(a.context, { stocktakeId })).version;
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "audit-coverage-a");
    rice = await inventoryProduct(harness, a, { name: "Rice" });
    beans = await inventoryProduct(harness, a, { name: "Beans" });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  describe("catalog", () => {
    it("categories: created on a fresh key, updated and archived on a real change; replays and no-ops write nothing", async () => {
      const idempotencyKey = key();
      const created = await audited(() =>
        tenancy.createCategory.execute(a.context, { name: "Grains", idempotencyKey }),
      );
      const category = created.result.category;
      expect(actions(created.rows)).toEqual(["product_category.created"]);
      expect(created.rows[0]).toMatchObject({
        entityType: "product_category",
        entityId: category.id,
        idempotencyKey,
        payload: { name: "Grains" },
      });
      expectEnvelope(created.rows[0], null);

      const replay = await audited(() => tenancy.createCategory.execute(a.context, { name: "Grains", idempotencyKey }));
      expect(replay.result.replayed).toBe(true);
      expect(replay.rows).toEqual([]);

      const same = await audited(() =>
        tenancy.updateCategory.execute(a.context, { categoryId: category.id, expectedVersion: 1, name: "Grains" }),
      );
      expect(same.result.changed).toBe(false);
      expect(same.rows).toEqual([]);

      const renamed = await audited(() =>
        tenancy.updateCategory.execute(a.context, { categoryId: category.id, expectedVersion: 1, name: "Cereals" }),
      );
      expect(actions(renamed.rows)).toEqual(["product_category.updated"]);
      expect(renamed.rows[0]).toMatchObject({
        entityId: category.id,
        payload: { fromName: "Grains", toName: "Cereals" },
      });

      const archived = await audited(() =>
        tenancy.archiveCategory.execute(a.context, { categoryId: category.id, expectedVersion: 2 }),
      );
      expect(actions(archived.rows)).toEqual(["product_category.archived"]);
      expect(archived.rows[0]).toMatchObject({ entityId: category.id, payload: {} });

      const again = await audited(() =>
        tenancy.archiveCategory.execute(a.context, { categoryId: category.id, expectedVersion: 3 }),
      );
      expect(again.result.changed).toBe(false);
      expect(again.rows).toEqual([]);
    });

    it("a priced create writes product.created and product.price_set together; an unpriced create writes only product.created", async () => {
      const { category } = await tenancy.createCategory.execute(a.context, { name: "Dairy", idempotencyKey: key() });
      const unpricedKey = key();
      const unpriced = await audited(() =>
        tenancy.createProduct.execute(a.context, {
          name: "Peak Milk 400g",
          sku: "PEAK-400",
          barcode: "5000112637922",
          categoryId: category.id,
          stockUnit: "PIECE",
          trackInventory: true,
          idempotencyKey: unpricedKey,
        }),
      );
      const milk = unpriced.result.item;
      expect(actions(unpriced.rows)).toEqual(["product.created"]);
      expect(unpriced.rows[0]).toMatchObject({
        entityType: "product",
        entityId: milk.product.id,
        idempotencyKey: unpricedKey,
        payload: {
          variantId: milk.variant.id,
          name: "Peak Milk 400g",
          sku: "PEAK-400",
          barcode: "5000112637922",
          stockUnit: "PIECE",
          trackInventory: true,
          categoryId: category.id,
        },
      });
      expectEnvelope(unpriced.rows[0], null);

      const pricedKey = key();
      const command = {
        name: "Golden Penny Semovita 1kg",
        stockUnit: "PIECE",
        trackInventory: true,
        initialPrice: { amountMinor: "150000", currency: a.currency },
        idempotencyKey: pricedKey,
      };
      const priced = await audited(() => tenancy.createProduct.execute(a.context, command));
      const semovita = priced.result.item;
      expect(actions(priced.rows)).toEqual(["product.created", "product.price_set"]);
      expect(priced.rows.every((row) => row.entityId === semovita.product.id)).toBe(true);
      expect(priced.rows[1]?.payload).toEqual({
        variantId: semovita.variant.id,
        toAmountMinor: "150000",
        currency: a.currency,
        priceVersion: 1,
      });

      const replay = await audited(() => tenancy.createProduct.execute(a.context, command));
      expect(replay.result.replayed).toBe(true);
      expect(replay.rows).toEqual([]);
      const catalog = await readCatalogSnapshot();
      expect(catalog.prices.filter((row) => row.variantId === semovita.variant.id)).toHaveLength(1);
    });

    it("product edits, prices, archive and reactivation audit only real changes, with reasons where the design carries them", async () => {
      const { item } = await tenancy.createProduct.execute(a.context, {
        name: "Indomie Chicken",
        description: "Single pack",
        stockUnit: "PIECE",
        trackInventory: true,
        initialPrice: { amountMinor: "25000", currency: a.currency },
        idempotencyKey: key(),
      });
      const productId = item.product.id;
      let version = item.product.version;
      const current = async () => (await readCatalogSnapshot()).products.find((row) => row.id === productId);

      const unchanged = await audited(() =>
        tenancy.updateProduct.execute(a.context, { productId, expectedVersion: version, name: "Indomie Chicken" }),
      );
      expect(unchanged.result.changed).toBe(false);
      expect(unchanged.rows).toEqual([]);

      const edited = await audited(() =>
        tenancy.updateProduct.execute(a.context, {
          productId,
          expectedVersion: version,
          name: "Indomie Chicken 70g",
          description: "Private supplier note",
        }),
      );
      expect(actions(edited.rows)).toEqual(["product.updated"]);
      expect(edited.rows[0]?.payload).toMatchObject({
        variantId: item.variant.id,
        nameChanged: true,
        descriptionChanged: true,
        skuChanged: false,
        fromName: "Indomie Chicken",
        toName: "Indomie Chicken 70g",
      });
      expect(JSON.stringify(edited.rows[0]?.payload)).not.toContain("Private supplier note");
      version = edited.result.item.product.version;

      const samePrice = await audited(() =>
        tenancy.setSellingPrice.execute(a.context, {
          productId,
          expectedVersion: version,
          price: { amountMinor: "25000", currency: a.currency },
        }),
      );
      expect(samePrice.result.changed).toBe(false);
      expect(samePrice.rows).toEqual([]);

      const repriced = await audited(() =>
        tenancy.setSellingPrice.execute(a.context, {
          productId,
          expectedVersion: version,
          price: { amountMinor: "27500", currency: a.currency },
          reason: "Supplier increase",
        }),
      );
      expect(actions(repriced.rows)).toEqual(["product.price_set"]);
      expect(repriced.rows[0]).toMatchObject({
        reason: "Supplier increase",
        payload: {
          variantId: item.variant.id,
          fromAmountMinor: "25000",
          toAmountMinor: "27500",
          currency: a.currency,
          priceVersion: 2,
        },
      });
      version = repriced.result.item.product.version;

      const archived = await audited(() =>
        tenancy.archiveProduct.execute(a.context, { productId, expectedVersion: version, reason: "Discontinued" }),
      );
      expect(actions(archived.rows)).toEqual(["product.archived"]);
      expect(archived.rows[0]).toMatchObject({ reason: "Discontinued", payload: { variantId: item.variant.id } });
      version = archived.result.item.product.version;

      const archivedAgain = await audited(() =>
        tenancy.archiveProduct.execute(a.context, { productId, expectedVersion: version }),
      );
      expect(archivedAgain.result.changed).toBe(false);
      expect(archivedAgain.rows).toEqual([]);

      const reactivated = await audited(() =>
        tenancy.reactivateProduct.execute(a.context, { productId, expectedVersion: version }),
      );
      expect(actions(reactivated.rows)).toEqual(["product.reactivated"]);
      expect(reactivated.rows[0]?.payload).toEqual({ variantId: item.variant.id });
      version = reactivated.result.item.product.version;

      const reactivatedAgain = await audited(() =>
        tenancy.reactivateProduct.execute(a.context, { productId, expectedVersion: version }),
      );
      expect(reactivatedAgain.result.changed).toBe(false);
      expect(reactivatedAgain.rows).toEqual([]);
      expect((await current())?.version).toBe(version);
    });

    it("packs: added on a fresh key, retired once; replay and repeated retire write nothing", async () => {
      const idempotencyKey = key();
      const command = { productId: rice.product.id, name: "Bag", factorMinor: "50", idempotencyKey };
      const added = await audited(() => tenancy.addPack.execute(a.context, command));
      const pack = added.result.pack;
      expect(actions(added.rows)).toEqual(["product_pack.added"]);
      expect(added.rows[0]).toMatchObject({
        entityType: "product_pack",
        entityId: pack.id,
        idempotencyKey,
        payload: { variantId: rice.variant.id, name: "Bag", factorMinor: "50" },
      });

      const replay = await audited(() => tenancy.addPack.execute(a.context, command));
      expect(replay.result.replayed).toBe(true);
      expect(replay.rows).toEqual([]);

      const retired = await audited(() => tenancy.retirePack.execute(a.context, { packId: pack.id }));
      expect(actions(retired.rows)).toEqual(["product_pack.retired"]);
      expect(retired.rows[0]?.payload).toEqual({ variantId: rice.variant.id });
      const again = await audited(() => tenancy.retirePack.execute(a.context, { packId: pack.id }));
      expect(again.result.changed).toBe(false);
      expect(again.rows).toEqual([]);
    });

    it("a denied catalog or inventory command writes no audit record", async () => {
      const cashierUser = await tenancy.registeredUser(`cashier-${a.businessId}`);
      await harness.addMember(a.businessId, cashierUser, "CASHIER");
      const cashier = await tenancy.boundContextFor(cashierUser, a.businessId);
      const before = await auditRows();
      const attempts: (() => Promise<unknown>)[] = [
        () =>
          tenancy.createProduct.execute(cashier, {
            name: "Denied",
            stockUnit: "PIECE",
            trackInventory: true,
            idempotencyKey: key(),
          }),
        () => tenancy.createCategory.execute(cashier, { name: "Denied", idempotencyKey: key() }),
        () =>
          tenancy.setSellingPrice.execute(cashier, {
            productId: rice.product.id,
            expectedVersion: rice.product.version,
            price: { amountMinor: "100", currency: a.currency },
          }),
        () => tenancy.postGoodsReceipt.execute(cashier, { lines: [piece(rice, "1")], idempotencyKey: key() }),
        () => tenancy.createStocktake.execute(cashier, { idempotencyKey: key() }),
      ];
      for (const attempt of attempts) expect(await rejection(attempt())).toBeInstanceOf(PermissionDeniedError);
      expect(await auditRows()).toEqual(before);
    });
  });

  describe("inventory", () => {
    it("opening stock and goods receipts: one record per document, bounded payloads, receipt reversal audited once", async () => {
      const openingKey = key();
      const openingCommand = { lines: [piece(rice, "10"), piece(beans, "4")], idempotencyKey: openingKey };
      const opening = await audited(() => tenancy.recordOpeningStock.execute(a.context, openingCommand));
      expect(actions(opening.rows)).toEqual(["inventory.opening_recorded"]);
      expect(opening.rows[0]).toMatchObject({
        entityType: "inventory_opening_batch",
        entityId: opening.result.document.id,
        idempotencyKey: openingKey,
        payload: { lineCount: 2 },
      });
      expectEnvelope(opening.rows[0], a.locationId);
      const openingReplay = await audited(() => tenancy.recordOpeningStock.execute(a.context, openingCommand));
      expect(openingReplay.result.replayed).toBe(true);
      expect(openingReplay.rows).toEqual([]);

      const withReference = await audited(() =>
        tenancy.postGoodsReceipt.execute(a.context, {
          lines: [piece(rice, "5")],
          reference: "INV-2026-0042",
          idempotencyKey: key(),
        }),
      );
      expect(actions(withReference.rows)).toEqual(["inventory.received"]);
      expect(withReference.rows[0]).toMatchObject({
        entityType: "goods_receipt",
        entityId: withReference.result.document.id,
        payload: { lineCount: 1, referencePresent: true },
      });
      expect(JSON.stringify(withReference.rows[0]?.payload)).not.toContain("INV-2026-0042");
      const withoutReference = await audited(() =>
        tenancy.postGoodsReceipt.execute(a.context, { lines: [piece(beans, "2")], idempotencyKey: key() }),
      );
      expect(withoutReference.rows[0]?.payload).toEqual({ lineCount: 1, referencePresent: false });

      const documentId = withReference.result.document.id;
      const reversed = await audited(() =>
        tenancy.reverseGoodsReceipt.execute(a.context, { documentId, reason: "Wrong supplier" }),
      );
      expect(actions(reversed.rows)).toEqual(["inventory.receipt_reversed"]);
      expect(reversed.rows[0]).toMatchObject({
        entityId: documentId,
        reason: "Wrong supplier",
        payload: { lineCount: 1 },
      });
      expectEnvelope(reversed.rows[0], a.locationId);
      const again = await audited(() =>
        tenancy.reverseGoodsReceipt.execute(a.context, { documentId, reason: "Again" }),
      );
      expect(again.result.changed).toBe(false);
      expect(again.rows).toEqual([]);
    });

    it("adjustments and write-offs: reason is the note when present, otherwise the code; each reversal is audited once with its kind", async () => {
      await tenancy.postGoodsReceipt.execute(a.context, { lines: [piece(rice, "10")], idempotencyKey: key() });
      const adjustmentKey = key();
      const adjustment = await audited(() =>
        tenancy.recordAdjustment.execute(a.context, {
          lines: [
            { ...piece(rice, "2"), direction: "INCREASE" },
            { ...piece(beans, "1"), direction: "INCREASE" },
          ],
          reasonCode: "FOUND_STOCK",
          reasonNote: "Found behind the counter",
          idempotencyKey: adjustmentKey,
        }),
      );
      expect(actions(adjustment.rows)).toEqual(["inventory.adjusted"]);
      expect(adjustment.rows[0]).toMatchObject({
        entityType: "inventory_adjustment",
        entityId: adjustment.result.document.id,
        idempotencyKey: adjustmentKey,
        reason: "Found behind the counter",
        payload: { reasonCode: "FOUND_STOCK", lineCount: 2 },
      });
      expectEnvelope(adjustment.rows[0], a.locationId);

      const writeOff = await audited(() =>
        tenancy.recordWriteOff.execute(a.context, {
          lines: [piece(rice, "3")],
          reasonCode: "DAMAGED",
          idempotencyKey: key(),
        }),
      );
      expect(actions(writeOff.rows)).toEqual(["inventory.written_off"]);
      expect(writeOff.rows[0]).toMatchObject({ reason: "DAMAGED", payload: { reasonCode: "DAMAGED", lineCount: 1 } });

      for (const [document, kind, lineCount] of [
        [adjustment.result.document, "ADJUSTMENT", 2],
        [writeOff.result.document, "WRITE_OFF", 1],
      ] as const) {
        const reversed = await audited(() =>
          tenancy.reverseAdjustment.execute(a.context, { documentId: document.id, reason: "Entered in error" }),
        );
        expect(actions(reversed.rows)).toEqual(["inventory.adjustment_reversed"]);
        expect(reversed.rows[0]).toMatchObject({
          entityId: document.id,
          reason: "Entered in error",
          payload: { kind, lineCount },
        });
        const again = await audited(() =>
          tenancy.reverseAdjustment.execute(a.context, { documentId: document.id, reason: "Again" }),
        );
        expect(again.result.changed).toBe(false);
        expect(again.rows).toEqual([]);
      }
    });

    it("thresholds: set and cleared carry the variant, stock unit and from and to values; no-ops write nothing", async () => {
      const set = (expectedVersion: number, quantityMinor: string) =>
        audited(() =>
          tenancy.setLowStockThreshold.execute(a.context, {
            variantId: rice.variant.id,
            expectedVersion,
            threshold: { quantityMinor, unit: "PIECE" },
          }),
        );
      const first = await set(0, "5");
      expect(actions(first.rows)).toEqual(["inventory.low_stock_threshold_set"]);
      expect(first.rows[0]).toMatchObject({
        entityType: "inventory_stock_threshold",
        payload: { variantId: rice.variant.id, stockUnit: "PIECE", toThresholdMinor: "5" },
      });
      expect(first.rows[0]?.payload).not.toHaveProperty("fromThresholdMinor");
      expectEnvelope(first.rows[0], a.locationId);
      expect((await set(1, "5")).rows).toEqual([]);
      const raised = await set(1, "8");
      expect(raised.rows[0]?.payload).toEqual({
        variantId: rice.variant.id,
        stockUnit: "PIECE",
        fromThresholdMinor: "5",
        toThresholdMinor: "8",
      });
      const cleared = await audited(() =>
        tenancy.clearLowStockThreshold.execute(a.context, { variantId: rice.variant.id, expectedVersion: 2 }),
      );
      expect(actions(cleared.rows)).toEqual(["inventory.low_stock_threshold_cleared"]);
      expect(cleared.rows[0]?.payload).toEqual({
        variantId: rice.variant.id,
        stockUnit: "PIECE",
        fromThresholdMinor: "8",
      });
      const clearedAgain = await audited(() =>
        tenancy.clearLowStockThreshold.execute(a.context, { variantId: rice.variant.id, expectedVersion: 3 }),
      );
      expect(clearedAgain.rows).toEqual([]);
    });

    it("stocktakes: started, posted and cancelled are audited once each; counting and removing lines are not", async () => {
      await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [piece(rice, "10"), piece(beans, "4")],
        idempotencyKey: key(),
      });
      const startKey = key();
      const started = await audited(() => tenancy.createStocktake.execute(a.context, { idempotencyKey: startKey }));
      const stocktakeId = started.result.stocktake.stocktakeId;
      expect(actions(started.rows)).toEqual(["inventory.stocktake_started"]);
      expect(started.rows[0]).toMatchObject({
        entityType: "stocktake",
        entityId: stocktakeId,
        idempotencyKey: startKey,
        payload: {},
      });
      expectEnvelope(started.rows[0], a.locationId);
      expect(
        (await audited(() => tenancy.createStocktake.execute(a.context, { idempotencyKey: startKey }))).rows,
      ).toEqual([]);

      const draftWork = await audited(async () => {
        await tenancy.recordStocktakeCount.execute(a.context, {
          stocktakeId,
          variantId: rice.variant.id,
          count: { quantityMinor: "8", unit: "PIECE" },
        });
        const counted = await tenancy.recordStocktakeCount.execute(a.context, {
          stocktakeId,
          variantId: beans.variant.id,
          count: { quantityMinor: "4", unit: "PIECE" },
        });
        const recounted = await tenancy.recordStocktakeCount.execute(a.context, {
          stocktakeId,
          variantId: beans.variant.id,
          count: { quantityMinor: "3", unit: "PIECE" },
          expectedVersion: counted.line.version,
        });
        const removed = await tenancy.removeStocktakeLine.execute(a.context, {
          stocktakeId,
          variantId: beans.variant.id,
          expectedVersion: recounted.line.version,
        });
        await tenancy.recordStocktakeCount.execute(a.context, {
          stocktakeId,
          variantId: beans.variant.id,
          count: { quantityMinor: "4", unit: "PIECE" },
          expectedVersion: removed.line.version,
        });
      });
      expect(draftWork.rows).toEqual([]);

      const posted = await audited(async () =>
        tenancy.postStocktake.execute(a.context, { stocktakeId, expectedVersion: await versionOf(stocktakeId) }),
      );
      expect(actions(posted.rows)).toEqual(["inventory.stocktake_posted"]);
      expect(posted.rows[0]).toMatchObject({
        entityId: stocktakeId,
        payload: { countedLineCount: 2, correctionMovementCount: 1, zeroVarianceCount: 1 },
      });
      expect(posted.result.movements).toHaveLength(1);
      const postedAgain = await audited(async () =>
        tenancy.postStocktake.execute(a.context, { stocktakeId, expectedVersion: await versionOf(stocktakeId) }),
      );
      expect(postedAgain.result.changed).toBe(false);
      expect(postedAgain.rows).toEqual([]);

      const { stocktake: second } = await tenancy.createStocktake.execute(a.context, { idempotencyKey: key() });
      await tenancy.recordStocktakeCount.execute(a.context, {
        stocktakeId: second.stocktakeId,
        variantId: rice.variant.id,
        count: { quantityMinor: "1", unit: "PIECE" },
      });
      const cancelled = await audited(async () =>
        tenancy.cancelStocktake.execute(a.context, {
          stocktakeId: second.stocktakeId,
          expectedVersion: await versionOf(second.stocktakeId),
          reason: "Started by mistake",
        }),
      );
      expect(actions(cancelled.rows)).toEqual(["inventory.stocktake_cancelled"]);
      expect(cancelled.rows[0]).toMatchObject({
        entityId: second.stocktakeId,
        reason: "Started by mistake",
        payload: { countedLineCount: 1 },
      });
      const cancelledAgain = await audited(async () =>
        tenancy.cancelStocktake.execute(a.context, {
          stocktakeId: second.stocktakeId,
          expectedVersion: await versionOf(second.stocktakeId),
        }),
      );
      expect(cancelledAgain.result.changed).toBe(false);
      expect(cancelledAgain.rows).toEqual([]);
    });
  });

  describe("atomicity and bounds", () => {
    const failOnCall = <T extends object>(repository: T, method: keyof T & string, call: number): T => {
      let calls = 0;
      return {
        ...repository,
        async [method](...args: unknown[]) {
          calls += 1;
          const result = await (repository[method] as (...inner: unknown[]) => Promise<unknown>).apply(
            repository,
            args,
          );
          if (calls === call) throw new Error(`injected failure after ${method} call ${call}`);
          return result;
        },
      };
    };
    const decorated = (decorate: Partial<DatabaseRepositories>) => harness.compose({ decorate });

    async function everything() {
      const tenancySnapshot = await readTenancySnapshot();
      return {
        catalog: await readCatalogSnapshot(),
        inventory: await readInventorySnapshot(),
        audit: tenancySnapshot.businessAudit,
        idempotency: tenancySnapshot.businessIdempotency,
      };
    }

    it("a failure writing the second audit record of a priced create rolls back the product, price, first record and key", async () => {
      const command = {
        name: "Milo 500g",
        stockUnit: "PIECE",
        trackInventory: true,
        initialPrice: { amountMinor: "320000", currency: a.currency },
        idempotencyKey: key(),
      };
      const before = await everything();
      const failing = decorated({
        auditWriter: failOnCall(harness.repositories.auditWriter, "recordBusinessEvent", 2),
      });
      await expect(failing.createProduct.execute(a.context, command)).rejects.toThrow("injected failure");
      expect(await everything()).toEqual(before);
      const retried = await audited(() => tenancy.createProduct.execute(a.context, command));
      expect(retried.result.replayed).toBe(false);
      expect(actions(retried.rows)).toEqual(["product.created", "product.price_set"]);
    });

    it("a failure writing a stocktake post's audit record leaves the stocktake DRAFT with no movement or balance change", async () => {
      await tenancy.postGoodsReceipt.execute(a.context, { lines: [piece(rice, "6")], idempotencyKey: key() });
      const { stocktake } = await tenancy.createStocktake.execute(a.context, { idempotencyKey: key() });
      await tenancy.recordStocktakeCount.execute(a.context, {
        stocktakeId: stocktake.stocktakeId,
        variantId: rice.variant.id,
        count: { quantityMinor: "2", unit: "PIECE" },
      });
      const expectedVersion = await versionOf(stocktake.stocktakeId);
      const before = await everything();
      const failing = decorated({
        auditWriter: failOnCall(harness.repositories.auditWriter, "recordBusinessEvent", 1),
      });
      await expect(
        failing.postStocktake.execute(a.context, { stocktakeId: stocktake.stocktakeId, expectedVersion }),
      ).rejects.toThrow("injected failure");
      expect(await everything()).toEqual(before);
      expect((await tenancy.getStocktake.execute(a.context, { stocktakeId: stocktake.stocktakeId })).status).toBe(
        "DRAFT",
      );
    });

    it("every Build 2 record uses a registered action, declared fields only, no secret-like content and stays under 8 KiB", async () => {
      const { item } = await tenancy.createProduct.execute(a.context, {
        name: "Bournvita 900g",
        stockUnit: "PIECE",
        trackInventory: true,
        initialPrice: { amountMinor: "450000", currency: a.currency },
        idempotencyKey: key(),
      });
      for (const [name, factorMinor] of [
        ["Carton", "12"],
        ["Bale", "24"],
      ] as const) {
        await tenancy.addPack.execute(a.context, {
          productId: item.product.id,
          name,
          factorMinor,
          idempotencyKey: key(),
        });
      }
      await tenancy.recordOpeningStock.execute(a.context, {
        lines: [piece(rice, "3"), piece(beans, "3"), piece(item, "3")],
        idempotencyKey: key(),
      });
      await tenancy.recordWriteOff.execute(a.context, {
        lines: [piece(rice, "1")],
        reasonCode: "OTHER",
        reasonNote: "x".repeat(500),
        idempotencyKey: key(),
      });
      const { stocktake } = await tenancy.createStocktake.execute(a.context, { idempotencyKey: key() });
      await tenancy.recordStocktakeCount.execute(a.context, {
        stocktakeId: stocktake.stocktakeId,
        variantId: beans.variant.id,
        count: { quantityMinor: "2", unit: "PIECE" },
      });
      await tenancy.postStocktake.execute(a.context, {
        stocktakeId: stocktake.stocktakeId,
        expectedVersion: await versionOf(stocktake.stocktakeId),
      });

      const declared = new Map<string, readonly string[]>(
        [...catalogAuditActions, ...inventoryAuditActions].map((action) => [action.name, Object.keys(action.fields)]),
      );
      const rows = (await auditRows()).filter((row) =>
        /^(product|product_category|product_pack|inventory)\./.test(row.action),
      );
      expect(new Set(actions(rows))).toEqual(
        new Set([
          "product.created",
          "product.price_set",
          "product_pack.added",
          "inventory.opening_recorded",
          "inventory.written_off",
          "inventory.stocktake_started",
          "inventory.stocktake_posted",
        ]),
      );
      for (const row of rows) {
        const fields = declared.get(row.action);
        expect(fields, row.action).toBeDefined();
        for (const name of Object.keys(row.payload)) expect(fields, `${row.action}.${name}`).toContain(name);
        expect(row.payloadBytes).toBeLessThanOrEqual(PAYLOAD_LIMIT_BYTES);
        expect(JSON.stringify(row.payload)).not.toMatch(/secret|token|password|credential|otp/i);
        expect(Object.keys(row.payload).some((name) => /quantity|balance|delta/i.test(name))).toBe(false);
      }
    });
  });
});
