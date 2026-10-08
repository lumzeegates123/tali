import {
  ConflictError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  type LocationBoundContext,
  NotFoundError,
  PermissionDeniedError,
  VersionConflictError,
} from "@tali/application";
import type { CatalogProduct, LocationId, MembershipRole } from "@tali/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
 * The Build 2 Slice 5 inventory use cases end to end over PostgreSQL, composed
 * as the API composes them (ADR-008; plan section X): the cross-tenant matrix,
 * permissions, stockability and negative-stock rules, keyed replay and key
 * reuse (including the resolved location in the fingerprint), whole-document
 * reversal, thresholds, atomic rollback of a claimed key, and the catalog's
 * stock-unit guard reading the real inventory tables. Every scenario leaves
 * the ledger consistent.
 */
describe("inventory use cases (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  let tenancy: Tenancy;
  let a: InventoryTenant;
  let b: InventoryTenant;
  let rice: CatalogProduct;
  let beans: CatalogProduct;
  let sugar: CatalogProduct;

  const key = () => harness.world().ids.newId("IdempotencyKey");
  const piece = (product: CatalogProduct, quantityMinor: string) => ({
    variantId: product.variant.id,
    quantityMinor,
    unit: "PIECE",
  });

  /** Everything a rejected command must leave untouched: the inventory tables, audit and idempotency. */
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

  const at = (t: InventoryTenant, locationId: LocationId): LocationBoundContext => ({ ...t.context, locationId });

  async function receive(context: LocationBoundContext, lines: readonly ReturnType<typeof piece>[]) {
    return tenancy.postGoodsReceipt.execute(context, { lines, idempotencyKey: key() });
  }

  beforeEach(async () => {
    tenancy = harness.compose();
    a = await inventoryTenant(harness, "inventory-cases-a");
    b = await inventoryTenant(harness, "inventory-cases-b");
    rice = await inventoryProduct(harness, a, { name: "Rice", stockUnit: "KG" });
    beans = await inventoryProduct(harness, a, { name: "Beans" });
    sugar = await inventoryProduct(harness, a, { name: "Sugar" });
  });

  afterEach(async () => {
    expect(await readInventoryConsistency()).toEqual([]);
  });

  describe("tenancy", () => {
    it("another business's member cannot touch this business's products, packs, documents or thresholds", async () => {
      const pack = await inventoryPack(harness, beans.variant, "Carton", 24n);
      const received = await receive(a.context, [piece(beans, "10")]);
      const adjusted = await tenancy.recordWriteOff.execute(a.context, {
        lines: [piece(beans, "1")],
        reasonCode: "DAMAGED",
        idempotencyKey: key(),
      });
      await tenancy.setLowStockThreshold.execute(a.context, {
        variantId: beans.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "2", unit: "PIECE" },
      });
      const theirs = await inventoryProduct(harness, b, { name: "Beans" });
      const before = await persisted();

      const attempts: (() => Promise<unknown>)[] = [
        () => tenancy.recordOpeningStock.execute(b.context, { lines: [piece(sugar, "1")], idempotencyKey: key() }),
        () => tenancy.postGoodsReceipt.execute(b.context, { lines: [piece(beans, "1")], idempotencyKey: key() }),
        () =>
          tenancy.postGoodsReceipt.execute(b.context, {
            lines: [{ variantId: theirs.variant.id, packId: pack.id, packCount: "1" }],
            idempotencyKey: key(),
          }),
        () =>
          tenancy.recordAdjustment.execute(b.context, {
            lines: [{ ...piece(beans, "1"), direction: "INCREASE" }],
            reasonCode: "FOUND_STOCK",
            idempotencyKey: key(),
          }),
        () =>
          tenancy.recordWriteOff.execute(b.context, {
            lines: [piece(beans, "1")],
            reasonCode: "THEFT_OR_LOSS",
            idempotencyKey: key(),
          }),
        () => tenancy.reverseGoodsReceipt.execute(b.context, { documentId: received.document.id, reason: "Not ours" }),
        () => tenancy.reverseAdjustment.execute(b.context, { documentId: adjusted.document.id, reason: "Not ours" }),
        () =>
          tenancy.setLowStockThreshold.execute(b.context, {
            variantId: beans.variant.id,
            expectedVersion: 1,
            threshold: { quantityMinor: "5", unit: "PIECE" },
          }),
        () => tenancy.clearLowStockThreshold.execute(b.context, { variantId: beans.variant.id, expectedVersion: 1 }),
      ];
      for (const attempt of attempts) expect(await rejection(attempt())).toBeInstanceOf(NotFoundError);
      expect(await persisted()).toEqual(before);

      await harness.unitOfWork.run(async (scope) => {
        const thresholds = harness.repositories.inventoryThresholds;
        expect(await thresholds.find(scope, a.businessId, a.locationId, beans.variant.id)).toMatchObject({
          version: 1,
        });
        expect(await thresholds.find(scope, b.businessId, a.locationId, beans.variant.id)).toBe(undefined);
        expect(await thresholds.findForUpdate(scope, b.businessId, a.locationId, beans.variant.id)).toBe(undefined);
        expect(await harness.repositories.goodsReceipts.findById(scope, b.businessId, received.document.id)).toBe(
          undefined,
        );
      });
    });

    it("a document is reversed only from the location it was recorded at", async () => {
      const backStore = await secondLocation(harness, a.businessId);
      const received = await receive(at(a, backStore), [piece(sugar, "4")]);
      const before = await persisted();
      expect(
        await rejection(
          tenancy.reverseGoodsReceipt.execute(a.context, { documentId: received.document.id, reason: "x" }),
        ),
      ).toBeInstanceOf(NotFoundError);
      expect(await persisted()).toEqual(before);
      const reversed = await tenancy.reverseGoodsReceipt.execute(at(a, backStore), {
        documentId: received.document.id,
        reason: "Wrong store",
      });
      expect(reversed.changed).toBe(true);
    });
  });

  describe("permissions and stock rules", () => {
    it("enforces inventory:receive, inventory:adjust and inventory:threshold by role", async () => {
      const cashier = await memberContext(a, "CASHIER");
      const keeper = await memberContext(a, "STOCK_KEEPER");
      const accountant = await memberContext(a, "ACCOUNTANT");
      await receive(keeper, [piece(sugar, "5")]);
      await tenancy.setLowStockThreshold.execute(keeper, {
        variantId: sugar.variant.id,
        expectedVersion: 0,
        threshold: { quantityMinor: "1", unit: "PIECE" },
      });
      const before = await persisted();
      const denied: (() => Promise<unknown>)[] = [
        () => receive(cashier, [piece(sugar, "1")]),
        () => tenancy.recordOpeningStock.execute(keeper, { lines: [piece(beans, "1")], idempotencyKey: key() }),
        () =>
          tenancy.recordWriteOff.execute(keeper, {
            lines: [piece(sugar, "1")],
            reasonCode: "THEFT_OR_LOSS",
            idempotencyKey: key(),
          }),
        () =>
          tenancy.setLowStockThreshold.execute(accountant, {
            variantId: sugar.variant.id,
            expectedVersion: 1,
            threshold: { quantityMinor: "2", unit: "PIECE" },
          }),
        () => tenancy.clearLowStockThreshold.execute(cashier, { variantId: sugar.variant.id, expectedVersion: 1 }),
      ];
      for (const attempt of denied) expect(await rejection(attempt())).toBeInstanceOf(PermissionDeniedError);
      expect(await persisted()).toEqual(before);
    });

    it("rejects archived and untracked products, a second opening, and a decrease below zero, writing nothing", async () => {
      const untracked = await inventoryProduct(harness, a, { name: "Service", trackInventory: false });
      await tenancy.recordOpeningStock.execute(a.context, { lines: [piece(sugar, "3")], idempotencyKey: key() });
      await tenancy.archiveProduct.execute(a.context, { productId: sugar.product.id, expectedVersion: 1 });
      const before = await persisted();
      const conflicts: (() => Promise<unknown>)[] = [
        () => receive(a.context, [piece(sugar, "1")]),
        () => receive(a.context, [piece(untracked, "1")]),
        () =>
          tenancy.recordOpeningStock.execute(a.context, {
            lines: [piece(beans, "1"), piece(sugar, "1")],
            idempotencyKey: key(),
          }),
        () =>
          tenancy.setLowStockThreshold.execute(a.context, {
            variantId: sugar.variant.id,
            expectedVersion: 0,
            threshold: { quantityMinor: "1", unit: "PIECE" },
          }),
      ];
      for (const attempt of conflicts) expect(await rejection(attempt())).toBeInstanceOf(ConflictError);
      expect(
        await rejection(
          tenancy.recordWriteOff.execute(a.context, {
            lines: [piece(sugar, "4")],
            reasonCode: "EXPIRED",
            idempotencyKey: key(),
          }),
        ),
      ).toBeInstanceOf(InsufficientStockError);
      expect(await persisted()).toEqual(before);

      const cleared = await tenancy.recordWriteOff.execute(a.context, {
        lines: [piece(sugar, "3")],
        reasonCode: "EXPIRED",
        idempotencyKey: key(),
      });
      expect(cleared.movements[0]?.balanceAfter.toMinorUnitsString()).toBe("0");
    });

    it("enters packs as exact stock-unit deltas with their snapshot, and decimal quantities in the stock unit", async () => {
      const carton = await inventoryPack(harness, beans.variant, "Carton", 24n);
      const outcome = await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [
          { variantId: beans.variant.id, packId: carton.id, packCount: "3" },
          { variantId: rice.variant.id, decimal: "2.25", unit: "KG" },
        ],
        idempotencyKey: key(),
      });
      const byVariant = new Map(outcome.movements.map((movement) => [movement.variantId, movement]));
      expect(byVariant.get(beans.variant.id)?.delta.toMinorUnitsString()).toBe("72");
      expect(byVariant.get(beans.variant.id)?.pack).toMatchObject({ packId: carton.id, count: 3n, factorMinor: 24n });
      expect(byVariant.get(rice.variant.id)?.delta.toMinorUnitsString()).toBe("2250");
      expect(byVariant.get(rice.variant.id)?.pack).toBe(undefined);
      const { movements } = await readInventorySnapshot();
      expect(movements.find((row) => row.variantId === beans.variant.id)).toMatchObject({
        deltaText: "72",
        packId: carton.id,
        packCountText: "3",
      });
    });
  });

  describe("keyed replay", () => {
    it("replays a multi-line document identically, before and after its reversal", async () => {
      const carton = await inventoryPack(harness, beans.variant, "Carton", 12n);
      const idempotencyKey = key();
      const sugarLine = { variantId: sugar.variant.id, quantityMinor: "7", unit: "PIECE" };
      const beansLine = { variantId: beans.variant.id, packId: carton.id, packCount: "2" };
      const command = {
        lines: [sugarLine, { variantId: rice.variant.id, decimal: "1.5", unit: "KG" }, beansLine],
        reference: "DN-77",
        idempotencyKey,
      };
      const original = await tenancy.postGoodsReceipt.execute(a.context, command);
      expect(original.replayed).toBe(false);
      expect(original.movements.map((movement) => movement.variantId)).toEqual(
        [sugar.variant.id, rice.variant.id, beans.variant.id].sort(),
      );
      const permuted = {
        ...command,
        lines: [{ variantId: rice.variant.id, quantityMinor: "1500", unit: "KG" }, beansLine, sugarLine],
      };
      const replay = await tenancy.postGoodsReceipt.execute(a.context, permuted);
      expect(replay).toEqual({ ...original, replayed: true });

      await tenancy.reverseGoodsReceipt.execute(a.context, { documentId: original.document.id, reason: "Returned" });
      const afterReversal = await tenancy.postGoodsReceipt.execute(a.context, command);
      expect(afterReversal).toEqual({ ...original, replayed: true });

      const snapshot = await persisted();
      expect(snapshot.inventory.goodsReceipts).toHaveLength(1);
      expect(snapshot.inventory.movements).toHaveLength(6);
      expect(snapshot.idempotency).toHaveLength(1);
      expect(snapshot.audit.filter((row) => row.action === "inventory.received")).toHaveLength(1);
    });

    it("the same key with a different command, or at a different location, is IDEMPOTENCY_KEY_REUSED", async () => {
      const backStore = await secondLocation(harness, a.businessId);
      const idempotencyKey = key();
      const command = { lines: [piece(sugar, "5")], idempotencyKey };
      const original = await tenancy.recordOpeningStock.execute(a.context, command);
      const before = await persisted();
      expect(
        await rejection(tenancy.recordOpeningStock.execute(a.context, { ...command, lines: [piece(sugar, "6")] })),
      ).toBeInstanceOf(IdempotencyKeyReusedError);
      expect(await rejection(tenancy.recordOpeningStock.execute(at(a, backStore), command))).toBeInstanceOf(
        IdempotencyKeyReusedError,
      );
      expect(await persisted()).toEqual(before);
      const elsewhere = {
        ...a.context,
        correlationId: "another-request",
        sourceChannel: "mobile",
      } as LocationBoundContext;
      expect(await tenancy.recordOpeningStock.execute(elsewhere, command)).toEqual({ ...original, replayed: true });
      const fresh = await tenancy.recordOpeningStock.execute(at(a, backStore), { ...command, idempotencyKey: key() });
      expect(fresh.movements[0]).toMatchObject({ locationId: backStore, balanceVersion: 1 });
    });

    it("a rejection inside apply() rolls back the claimed key, so the same key later runs fresh", async () => {
      await receive(a.context, [piece(sugar, "10")]);
      const idempotencyKey = key();
      const command = { lines: [piece(sugar, "11")], reasonCode: "THEFT_OR_LOSS" as const, idempotencyKey };
      const before = await persisted();
      expect(await rejection(tenancy.recordWriteOff.execute(a.context, command))).toBeInstanceOf(
        InsufficientStockError,
      );
      expect(await persisted()).toEqual(before);
      await receive(a.context, [piece(sugar, "5")]);
      const retried = await tenancy.recordWriteOff.execute(a.context, command);
      expect(retried.replayed).toBe(false);
      expect(retried.movements[0]?.balanceAfter.toMinorUnitsString()).toBe("4");
    });

    it("a failure after any apply() write leaves no document, movement, balance, audit or idempotency record", async () => {
      await receive(a.context, [piece(sugar, "10")]);
      const failAfter = <T extends object>(repository: T, method: keyof T & string): T => ({
        ...repository,
        async [method](...args: unknown[]) {
          await (repository[method] as (...inner: unknown[]) => Promise<unknown>).apply(repository, args);
          throw new Error(`injected failure after ${method}`);
        },
      });
      const repos = harness.repositories;
      const decorations = [
        { goodsReceipts: failAfter(repos.goodsReceipts, "insert") },
        { inventoryMovements: failAfter(repos.inventoryMovements, "insertMany") },
        { inventoryBalances: failAfter(repos.inventoryBalances, "apply") },
        { auditWriter: failAfter(repos.auditWriter, "recordBusinessEvent") },
      ];
      const idempotencyKey = key();
      const before = await persisted();
      for (const decorate of decorations) {
        const failing = harness.compose({ decorate });
        await expect(
          failing.postGoodsReceipt.execute(a.context, { lines: [piece(sugar, "2")], idempotencyKey }),
        ).rejects.toThrow("injected failure after");
        expect(await persisted()).toEqual(before);
      }
      const succeeded = await tenancy.postGoodsReceipt.execute(a.context, {
        lines: [piece(sugar, "2")],
        idempotencyKey,
      });
      expect(succeeded.replayed).toBe(false);
    });
  });

  describe("reversals and thresholds", () => {
    it("reverses an adjustment exactly once; the second call is a no-op with no audit record", async () => {
      await receive(a.context, [piece(sugar, "3"), piece(beans, "3")]);
      const adjusted = await tenancy.recordAdjustment.execute(a.context, {
        lines: [
          { ...piece(sugar, "2"), direction: "INCREASE" },
          { ...piece(beans, "1"), direction: "DECREASE" },
        ],
        reasonCode: "OTHER",
        reasonNote: "Recount after delivery",
        idempotencyKey: key(),
      });
      const first = await tenancy.reverseAdjustment.execute(a.context, {
        documentId: adjusted.document.id,
        reason: "Counted twice",
      });
      expect(first.changed).toBe(true);
      expect(first.reversalMovements.map((movement) => movement.delta.toMinorUnitsString()).sort()).toEqual([
        "-2",
        "1",
      ]);
      expect(first.reversalMovements.every((movement) => movement.reversesMovementId !== undefined)).toBe(true);
      const before = await persisted();
      const second = await tenancy.reverseAdjustment.execute(a.context, {
        documentId: adjusted.document.id,
        reason: "Again",
      });
      expect(second).toEqual({ document: first.document, reversalMovements: [], changed: false });
      expect(await persisted()).toEqual(before);
      expect(before.audit.filter((row) => row.action === "inventory.adjustment_reversed")).toHaveLength(1);
      expect(before.inventory.balances.map((row) => row.quantityText).sort()).toEqual(["3", "3"]);
    });

    it("a reversal that would take stock below zero is INSUFFICIENT_STOCK and writes nothing", async () => {
      const received = await receive(a.context, [piece(sugar, "5")]);
      await tenancy.recordWriteOff.execute(a.context, {
        lines: [piece(sugar, "4")],
        reasonCode: "THEFT_OR_LOSS",
        idempotencyKey: key(),
      });
      const before = await persisted();
      expect(
        await rejection(
          tenancy.reverseGoodsReceipt.execute(a.context, { documentId: received.document.id, reason: "Return" }),
        ),
      ).toBeInstanceOf(InsufficientStockError);
      expect(await persisted()).toEqual(before);
    });

    it("thresholds follow the version-0 matrix, write no movement, and audit only real changes", async () => {
      const set = (expectedVersion: number, quantityMinor: string) =>
        tenancy.setLowStockThreshold.execute(a.context, {
          variantId: rice.variant.id,
          expectedVersion,
          threshold: { quantityMinor, unit: "KG" },
        });
      expect(await rejection(set(1, "500"))).toBeInstanceOf(VersionConflictError);
      expect(await set(0, "500")).toMatchObject({ changed: true, version: 1, locationId: a.locationId });
      expect(await rejection(set(0, "500"))).toBeInstanceOf(VersionConflictError);
      expect(await set(1, "500")).toMatchObject({ changed: false, version: 1 });
      expect(await set(1, "750")).toMatchObject({ changed: true, version: 2 });
      const cleared = await tenancy.clearLowStockThreshold.execute(a.context, {
        variantId: rice.variant.id,
        expectedVersion: 2,
      });
      expect(cleared).toMatchObject({ changed: true, version: 3 });
      expect(cleared.threshold).toBe(undefined);
      expect(
        await tenancy.clearLowStockThreshold.execute(a.context, { variantId: rice.variant.id, expectedVersion: 3 }),
      ).toMatchObject({ changed: false, version: 3 });
      const snapshot = await persisted();
      expect(snapshot.inventory.movements).toEqual([]);
      expect(snapshot.inventory.balances).toEqual([]);
      expect(snapshot.inventory.thresholds).toHaveLength(1);
      const audit = snapshot.audit.filter((row) => row.action.startsWith("inventory.low_stock_threshold"));
      expect(audit.map((row) => row.action)).toEqual([
        "inventory.low_stock_threshold_set",
        "inventory.low_stock_threshold_set",
        "inventory.low_stock_threshold_cleared",
      ]);
      expect(audit.every((row) => row.locationId === a.locationId)).toBe(true);
      expect(audit[1]?.payloadText).toContain('"750"');
    });
  });

  describe("the catalog stock-unit guard reads the inventory tables", () => {
    const changeUnit = (expectedVersion: number, stockUnit: string) =>
      tenancy.updateProduct.execute(a.context, { productId: rice.product.id, expectedVersion, stockUnit });

    it("a threshold at a non-default location blocks a unit change until it is cleared", async () => {
      const backStore = await secondLocation(harness, a.businessId);
      await tenancy.setLowStockThreshold.execute(at(a, backStore), {
        variantId: rice.variant.id,
        expectedVersion: 0,
        threshold: { decimal: "0.5", unit: "KG" },
      });
      expect(await rejection(changeUnit(1, "PIECE"))).toBeInstanceOf(ConflictError);
      await expect(changeUnit(1, "PIECE")).rejects.toThrow("low-stock threshold");
      await tenancy.clearLowStockThreshold.execute(at(a, backStore), {
        variantId: rice.variant.id,
        expectedVersion: 1,
      });
      const changed = await changeUnit(1, "PIECE");
      expect(changed.item.variant.stockUnit).toBe("PIECE");
      const { thresholds } = await readInventorySnapshot();
      expect(thresholds).toHaveLength(1);
    });

    it("movements at any location block a unit change; stock there blocks turning tracking off", async () => {
      const backStore = await secondLocation(harness, a.businessId);
      const received = await receive(at(a, backStore), [
        { variantId: rice.variant.id, quantityMinor: "100", unit: "KG" },
      ]);
      expect(await rejection(changeUnit(1, "G"))).toBeInstanceOf(ConflictError);
      expect(
        await rejection(
          tenancy.updateProduct.execute(a.context, {
            productId: rice.product.id,
            expectedVersion: 1,
            trackInventory: false,
          }),
        ),
      ).toBeInstanceOf(ConflictError);
      await tenancy.reverseGoodsReceipt.execute(at(a, backStore), {
        documentId: received.document.id,
        reason: "Return",
      });
      expect(await rejection(changeUnit(1, "G"))).toBeInstanceOf(ConflictError);
      const untracked = await tenancy.updateProduct.execute(a.context, {
        productId: rice.product.id,
        expectedVersion: 1,
        trackInventory: false,
      });
      expect(untracked.item.variant.trackInventory).toBe(false);
    });
  });
});
