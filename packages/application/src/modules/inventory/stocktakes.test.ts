import type { CatalogProduct } from "@tali/domain";
import { defineCurrency, MAX_STOCKTAKE_LINES, restoreLocation } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { parseCorrelationId } from "../../context/business-context.js";
import {
  ConflictError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  VersionConflictError,
} from "../../errors/application-error.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";
import type { StocktakeCountInput } from "./inventory-common.js";
import { STOCKTAKE_IN_PROGRESS } from "./ports.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  const rice = await h.product(mine.OWNER, { name: "Rice", stockUnit: "KG" });
  await h.recordOpeningStock.execute(mine.OWNER, {
    lines: [
      { variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" },
      { variantId: rice.variant.id, decimal: "2", unit: "KG" },
    ],
    idempotencyKey: key(),
  });
  const start = async (context: LocationBoundContext = mine.OWNER, note?: string) =>
    (
      await h.createStocktake.execute(context, {
        ...(note === undefined ? {} : { note }),
        idempotencyKey: key(),
      })
    ).stocktake;
  const count = (
    context: LocationBoundContext,
    stocktakeId: string,
    variantId: string,
    value: StocktakeCountInput,
    expectedVersion?: number,
  ) =>
    h.recordStocktakeCount.execute(context, {
      stocktakeId,
      variantId,
      count: value,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  const backStore = () => {
    const now = h.catalog.tenancy.clock.now();
    const location = restoreLocation({
      id: h.catalog.tenancy.ids.newId("Location"),
      businessId: mine.OWNER.businessId,
      name: "Back store",
      isDefault: false,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    h.catalog.tenancy.store.putLocation(location);
    return { ...mine.OWNER, locationId: location.id };
  };
  return { h, mine, theirs, key, soap, rice, start, count, backStore };
}

const pieces = (quantityMinor: string): StocktakeCountInput => ({ quantityMinor, unit: "PIECE" });

describe("CreateStocktake", () => {
  it("starts a DRAFT version-1 stocktake at the context's location and audits it without a payload", async () => {
    const { h, mine, key } = await setup();
    const idempotencyKey = key();
    const outcome = await h.createStocktake.execute(mine.STOCK_KEEPER, { note: "  Month end ", idempotencyKey });
    expect(outcome.replayed).toBe(false);
    expect(outcome.stocktake).toEqual({
      stocktakeId: outcome.stocktake.stocktakeId,
      locationId: mine.STOCK_KEEPER.locationId,
      status: "DRAFT",
      version: 1,
      note: "Month end",
      createdAt: h.catalog.tenancy.clock.now(),
    });
    expect(h.inventory.stocktakes).toHaveLength(1);
    const audit = h.inventoryAudit().at(-1);
    expect(audit).toMatchObject({
      action: "inventory.stocktake_started",
      entityType: "stocktake",
      entityId: outcome.stocktake.stocktakeId,
      locationId: mine.STOCK_KEEPER.locationId,
      idempotencyKey,
      payload: {},
    });
    h.inventory.assertConsistent();
  });

  it("replays the creation snapshot for the same key, ignoring correlation and time", async () => {
    const { h, mine, key } = await setup();
    const idempotencyKey = key();
    const first = await h.createStocktake.execute(mine.OWNER, { note: "Shelf A", idempotencyKey });
    const before = h.state();
    h.catalog.tenancy.clock.advanceBySeconds(600);
    const retried = await h.createStocktake.execute(
      { ...mine.OWNER, correlationId: parseCorrelationId("retry") },
      { note: "Shelf A", idempotencyKey },
    );
    expect(retried).toEqual({ stocktake: first.stocktake, replayed: true });
    expect(h.state()).toBe(before);
  });

  it("rejects the same key with a different note or location as IDEMPOTENCY_KEY_REUSED", async () => {
    const { h, mine, key, backStore } = await setup();
    const idempotencyKey = key();
    await h.createStocktake.execute(mine.OWNER, { note: "Shelf A", idempotencyKey });
    const before = h.state();
    await expect(h.createStocktake.execute(mine.OWNER, { note: "Shelf B", idempotencyKey })).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
    await expect(h.createStocktake.execute(mine.OWNER, { idempotencyKey })).rejects.toThrow(IdempotencyKeyReusedError);
    await expect(h.createStocktake.execute(backStore(), { note: "Shelf A", idempotencyKey })).rejects.toThrow(
      IdempotencyKeyReusedError,
    );
    expect(h.state()).toBe(before);
  });

  it("is a CONFLICT with a new key while a DRAFT exists at the location, and keeps nothing (decision D1)", async () => {
    const { h, mine, key, start } = await setup();
    await start();
    const before = h.state();
    const attempt = h.createStocktake.execute(mine.MANAGER, { idempotencyKey: key() });
    await expect(attempt).rejects.toThrow(ConflictError);
    await expect(h.createStocktake.execute(mine.MANAGER, { idempotencyKey: key() })).rejects.toThrow(
      STOCKTAKE_IN_PROGRESS,
    );
    expect(h.state()).toBe(before);
  });

  it("allows one DRAFT per location, and a new one once the previous is posted or cancelled", async () => {
    const { h, mine, soap, start, count, backStore } = await setup();
    const first = await start();
    await start(backStore());
    await count(mine.OWNER, first.stocktakeId, soap.variant.id, pieces("10"));
    await h.postStocktake.execute(mine.OWNER, { stocktakeId: first.stocktakeId, expectedVersion: 2 });
    const second = await start();
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId: second.stocktakeId, expectedVersion: 1 });
    const third = await start();
    expect(new Set([first.stocktakeId, second.stocktakeId, third.stocktakeId]).size).toBe(3);
  });

  it("checks the permission before anything else and requires a key", async () => {
    const { h, mine, key } = await setup();
    h.calls.length = 0;
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(h.createStocktake.execute(mine[role], { idempotencyKey: key() })).rejects.toThrow(
        PermissionDeniedError,
      );
    }
    await expect(h.createStocktake.execute(mine.OWNER, { idempotencyKey: undefined })).rejects.toThrow(
      IdempotencyKeyRequiredError,
    );
    await expect(
      h.createStocktake.execute(mine.OWNER, { note: "x".repeat(501), idempotencyKey: key() }),
    ).rejects.toThrow(ValidationError);
    expect(h.calls).toEqual([]);
  });

  it("plans without touching state: no repository call between the key lookup and the claim", async () => {
    const { h, mine, key } = await setup();
    h.calls.length = 0;
    await h.createStocktake.execute(mine.OWNER, { idempotencyKey: key() });
    expect(h.calls).toEqual([
      "memberships.findByBusinessAndUser",
      "idempotency.find",
      "idempotency.insert",
      "stocktakes.insert",
      "audit.recordBusinessEvent",
    ]);
  });
});

describe("RecordStocktakeCount", () => {
  it("captures the count with the on-hand, balance version and unit seen, and writes no movement or audit", async () => {
    const { h, mine, soap, start, count } = await setup();
    const stocktake = await start();
    const before = { movements: h.inventory.movements.length, audit: h.inventoryAudit().length };
    const result = await count(mine.STOCK_KEEPER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
    expect(result.changed).toBe(true);
    expect(result.stocktake).toMatchObject({ status: "DRAFT", version: 2, countedLineCount: 1, visibility: "BLIND" });
    expect(result.line).toEqual({
      visibility: "BLIND",
      variantId: soap.variant.id,
      status: "COUNTED",
      countedQuantity: result.line.countedQuantity,
      stockUnit: "PIECE",
      version: 1,
      countedAt: h.catalog.tenancy.clock.now(),
    });
    expect(result.line.countedQuantity.toMinorUnitsString()).toBe("7");
    const stored = h.inventory.stocktakeLines[0];
    expect(stored?.expectedAtCount.toMinorUnitsString()).toBe("10");
    expect(stored?.balanceVersionAtCount).toBe(1);
    expect(stored?.stockUnitAtCount).toBe("PIECE");
    expect(h.inventory.movements).toHaveLength(before.movements);
    expect(h.inventoryAudit()).toHaveLength(before.audit);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("10");
  });

  it("counts a never-stocked item as expected zero at balance version 0, and accepts a zero count", async () => {
    const { h, mine, start, count } = await setup();
    const fresh = await h.product(mine.OWNER, { name: "Fresh" });
    const stocktake = await start();
    const result = await count(mine.MANAGER, stocktake.stocktakeId, fresh.variant.id, pieces("0"));
    expect(result.line.visibility).toBe("FULL");
    if (result.line.visibility !== "FULL") throw new Error("expected a FULL line");
    expect(result.line.expectedAtCount.toMinorUnitsString()).toBe("0");
    expect(h.inventory.stocktakeLines[0]?.balanceVersionAtCount).toBe(0);
  });

  it("normalizes decimals with the unit's scale and rejects extra precision, negatives and JSON numbers", async () => {
    const { h, mine, rice, soap, start, count } = await setup();
    const stocktake = await start();
    const result = await count(mine.OWNER, stocktake.stocktakeId, rice.variant.id, { decimal: "1.5", unit: "KG" });
    expect(result.line.countedQuantity.toMinorUnitsString()).toBe("1500");
    const before = h.state();
    for (const bad of [
      { decimal: "1.0001", unit: "KG" },
      { decimal: "-1", unit: "KG" },
      { quantityMinor: "-1", unit: "KG" },
      { quantityMinor: 5, unit: "KG" },
      { quantityMinor: "1", decimal: "1", unit: "KG" },
      { unit: "KG" },
      { quantityMinor: "1" },
      { quantityMinor: "1", unit: "PIECE" },
    ]) {
      await expect(
        count(mine.OWNER, stocktake.stocktakeId, rice.variant.id, bad as unknown as StocktakeCountInput, 1),
      ).rejects.toThrow(ValidationError);
    }
    await expect(
      count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, { quantityMinor: "1", unit: "KG" }),
    ).rejects.toThrow("stock unit PIECE");
    expect(h.state()).toBe(before);
  });

  it("counts packs times their factor plus a loose quantity", async () => {
    const { h, mine, key, soap, start, count } = await setup();
    const { pack } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: soap.product.id,
      name: "Carton",
      factorMinor: "12",
      idempotencyKey: key(),
    });
    const stocktake = await start();
    const packed = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, {
      packId: pack.id,
      packCount: "2",
      loose: { quantityMinor: "5", unit: "PIECE" },
    });
    expect(packed.line.countedQuantity.toMinorUnitsString()).toBe("29");
    const only = await count(
      mine.OWNER,
      stocktake.stocktakeId,
      soap.variant.id,
      { packId: pack.id, packCount: "1" },
      1,
    );
    expect(only.line.countedQuantity.toMinorUnitsString()).toBe("12");
    const before = h.state();
    for (const bad of [
      { packId: pack.id, packCount: "0" },
      { packId: pack.id },
      { packCount: "1" },
      { packId: pack.id, packCount: "1", unit: "PIECE" },
      { packId: pack.id, packCount: "1", loose: { quantityMinor: "-1", unit: "PIECE" } },
      { packId: pack.id, packCount: "1", loose: { quantityMinor: "1", unit: "KG" } },
    ]) {
      await expect(
        count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, bad as unknown as StocktakeCountInput, 2),
      ).rejects.toThrow(ValidationError);
    }
    expect(h.state()).toBe(before);
  });

  it("is NOT_FOUND for a foreign, other-variant or malformed pack and CONFLICT for a retired one", async () => {
    const { h, mine, theirs, key, soap, rice, start, count } = await setup();
    const foreign = await h.product(theirs.OWNER, { name: "Their soap" });
    const { pack: foreignPack } = await h.catalog.addPack.execute(theirs.OWNER, {
      productId: foreign.product.id,
      name: "Box",
      factorMinor: "10",
      idempotencyKey: key(),
    });
    const { pack: ricePack } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: rice.product.id,
      name: "Sack",
      factorMinor: "5000",
      idempotencyKey: key(),
    });
    const { pack: retired } = await h.catalog.addPack.execute(mine.OWNER, {
      productId: soap.product.id,
      name: "Old carton",
      factorMinor: "6",
      idempotencyKey: key(),
    });
    await h.catalog.retirePack.execute(mine.OWNER, { packId: retired.id });
    const stocktake = await start();
    const before = h.state();
    for (const packId of [foreignPack.id, ricePack.id, "not-a-pack"]) {
      await expect(
        count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, { packId, packCount: "1" }),
      ).rejects.toThrow(NotFoundError);
    }
    await expect(
      count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, { packId: retired.id, packCount: "1" }),
    ).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
  });

  it("is a no-op for an identical recount and recaptures a changed one with both versions bumped", async () => {
    const { h, mine, key, soap, start, count } = await setup();
    const stocktake = await start();
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
    const before = h.state();
    const same = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"), 1);
    expect(same.changed).toBe(false);
    expect(same.stocktake.version).toBe(2);
    expect(h.state()).toBe(before);

    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "5", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const reconfirmed = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"), 1);
    expect(reconfirmed.changed).toBe(true);
    expect(reconfirmed.line.version).toBe(2);
    expect(reconfirmed.stocktake.version).toBe(3);
    expect(h.inventory.stocktakeLines[0]?.expectedAtCount.toMinorUnitsString()).toBe("15");
    expect(h.inventory.stocktakeLines[0]?.balanceVersionAtCount).toBe(2);

    const changed = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("9"), 2);
    expect(changed.line.version).toBe(3);
    expect(changed.stocktake.version).toBe(4);
  });

  describe("expectedVersion against the stored line version (0 for no line)", () => {
    it("A and B: no stored line with expectedVersion omitted or 0 creates version 1", async () => {
      const { mine, soap, rice, start, count } = await setup();
      const stocktake = await start();
      expect((await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"))).line.version).toBe(1);
      const explicit = await count(
        mine.OWNER,
        stocktake.stocktakeId,
        rice.variant.id,
        { quantityMinor: "1", unit: "KG" },
        0,
      );
      expect(explicit.line.version).toBe(1);
      expect(explicit.stocktake.version).toBe(3);
    });

    it("C: no stored line with a positive expectedVersion is VERSION_CONFLICT and writes nothing", async () => {
      const { h, mine, rice, start, count } = await setup();
      const stocktake = await start();
      const before = h.state();
      await expect(
        count(mine.OWNER, stocktake.stocktakeId, rice.variant.id, { quantityMinor: "1", unit: "KG" }, 1),
      ).rejects.toThrow(VersionConflictError);
      expect(h.state()).toBe(before);
    });

    it("D, E and F: an existing COUNTED line with expectedVersion omitted, 0 or stale is VERSION_CONFLICT", async () => {
      const { h, mine, soap, start, count } = await setup();
      const stocktake = await start();
      await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
      const before = h.state();
      for (const expectedVersion of [undefined, 0, 2]) {
        await expect(
          count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("8"), expectedVersion),
        ).rejects.toThrow(VersionConflictError);
      }
      expect(h.state()).toBe(before);
    });

    it("G: an existing COUNTED line with its exact version proceeds to the no-op or change decision", async () => {
      const { h, mine, soap, start, count } = await setup();
      const stocktake = await start();
      await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
      const before = h.state();
      const same = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"), 1);
      expect(same).toMatchObject({ changed: false, line: { version: 1 }, stocktake: { version: 2 } });
      expect(h.state()).toBe(before);
      const changed = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("8"), 1);
      expect(changed).toMatchObject({ changed: true, line: { version: 2 }, stocktake: { version: 3 } });
    });

    it("H and I: a REMOVED line conflicts for omitted or 0 and is recounted at its exact version", async () => {
      const { h, mine, soap, start, count } = await setup();
      const stocktake = await start();
      await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
      await h.removeStocktakeLine.execute(mine.OWNER, {
        stocktakeId: stocktake.stocktakeId,
        variantId: soap.variant.id,
        expectedVersion: 1,
      });
      const before = h.state();
      for (const expectedVersion of [undefined, 0]) {
        await expect(
          count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("8"), expectedVersion),
        ).rejects.toThrow(VersionConflictError);
      }
      expect(h.state()).toBe(before);
      const recounted = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("8"), 2);
      expect(recounted.line).toMatchObject({ status: "COUNTED", version: 3 });
      expect(h.inventory.stocktakeLines).toHaveLength(1);
    });

    it("a malformed expectedVersion stays VALIDATION_FAILED, with or without a stored line", async () => {
      const { h, mine, soap, rice, start, count } = await setup();
      const stocktake = await start();
      await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
      const before = h.state();
      for (const expectedVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1" as unknown as number]) {
        await expect(
          count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("8"), expectedVersion),
        ).rejects.toThrow(ValidationError);
        await expect(
          count(
            mine.OWNER,
            stocktake.stocktakeId,
            rice.variant.id,
            { quantityMinor: "1", unit: "KG" },
            expectedVersion,
          ),
        ).rejects.toThrow(ValidationError);
      }
      expect(h.state()).toBe(before);
    });
  });

  it("is NOT_FOUND for a malformed, foreign or other-location stocktake and a foreign or malformed variant", async () => {
    const { h, mine, theirs, soap, start, count, backStore } = await setup();
    const stocktake = await start();
    const theirStocktake = await start(theirs.OWNER);
    const foreign = await h.product(theirs.OWNER, { name: "Their soap" });
    const elsewhere = await start(backStore());
    const before = h.state();
    for (const id of ["nope", theirStocktake.stocktakeId, elsewhere.stocktakeId]) {
      await expect(count(mine.OWNER, id, soap.variant.id, pieces("1"))).rejects.toThrow(NotFoundError);
    }
    for (const variantId of ["nope", foreign.variant.id]) {
      await expect(count(mine.OWNER, stocktake.stocktakeId, variantId, pieces("1"))).rejects.toThrow(NotFoundError);
    }
    expect(h.state()).toBe(before);
  });

  it("is a CONFLICT for an untracked product, an archived product with no stock, or a closed stocktake", async () => {
    const { h, mine, soap, start, count } = await setup();
    const untracked = await h.product(mine.OWNER, { name: "Service", trackInventory: false });
    const empty = await h.product(mine.OWNER, { name: "Empty" });
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: empty.product.id, expectedVersion: 1 });
    const stocktake = await start();
    const before = h.state();
    for (const variantId of [untracked.variant.id, empty.variant.id]) {
      await expect(count(mine.OWNER, stocktake.stocktakeId, variantId, pieces("1"))).rejects.toThrow(ConflictError);
    }
    expect(h.state()).toBe(before);
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId: stocktake.stocktakeId, expectedVersion: 1 });
    await expect(count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("1"))).rejects.toThrow(ConflictError);
  });

  it("counts an archived product that still has stock on hand", async () => {
    const { h, mine, soap, start, count } = await setup();
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: soap.product.id, expectedVersion: 1 });
    const stocktake = await start();
    const result = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("10"));
    expect(result.changed).toBe(true);
  });

  it("is denied to CASHIER and ACCOUNTANT before any read", async () => {
    const { h, mine, soap, start, count } = await setup();
    const stocktake = await start();
    h.calls.length = 0;
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(count(mine[role], stocktake.stocktakeId, soap.variant.id, pieces("1"))).rejects.toThrow(
        PermissionDeniedError,
      );
    }
    expect(h.calls).toEqual([]);
  });

  it("follows the lock order: header, variant FOR SHARE, balance read, then the line", async () => {
    const { h, mine, soap, start, count } = await setup();
    const stocktake = await start();
    h.calls.length = 0;
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("3"));
    expect(h.calls).toEqual([
      "memberships.findByBusinessAndUser",
      "stocktakes.findByIdForUpdate",
      "products.lockVariantsForShare",
      "balances.find",
      "stocktakeLines.find",
      "stocktakeLines.countForStocktake",
      "stocktakeLines.insert",
      "stocktakes.update",
      "stocktakeLines.countByStatus",
    ]);
    h.calls.length = 0;
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("4"), 1);
    expect(h.calls).not.toContain("stocktakeLines.countForStocktake");
    expect(h.calls).not.toContain("balances.lockForUpdate");
  });

  it("allows 1,000 distinct lines, counting REMOVED rows, and rejects the 1,001st (decision D9)", async () => {
    const { h, mine, soap, start, count } = await setup();
    const stocktake = await start();
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("1"));
    await h.removeStocktakeLine.execute(mine.OWNER, {
      stocktakeId: stocktake.stocktakeId,
      variantId: soap.variant.id,
      expectedVersion: 1,
    });
    const products: CatalogProduct[] = [];
    for (let index = 1; index < MAX_STOCKTAKE_LINES; index += 1) {
      products.push(await h.product(mine.OWNER, { name: `Item ${index}` }));
    }
    for (const product of products) {
      await count(mine.OWNER, stocktake.stocktakeId, product.variant.id, pieces("1"));
    }
    expect(h.inventory.stocktakeLines).toHaveLength(MAX_STOCKTAKE_LINES);
    const extra = await h.product(mine.OWNER, { name: "One too many" });
    const before = h.state();
    await expect(count(mine.OWNER, stocktake.stocktakeId, extra.variant.id, pieces("1"))).rejects.toThrow(
      ValidationError,
    );
    expect(h.state()).toBe(before);
    const recount = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("2"), 2);
    expect(recount.line).toMatchObject({ status: "COUNTED", version: 3 });
  }, 60_000);
});

describe("RemoveStocktakeLine", () => {
  it("marks a COUNTED line REMOVED, keeps its count fields, bumps both versions and writes no audit", async () => {
    const { h, mine, soap, start, count } = await setup();
    const stocktake = await start();
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
    const audit = h.inventoryAudit().length;
    const removed = await h.removeStocktakeLine.execute(mine.STOCK_KEEPER, {
      stocktakeId: stocktake.stocktakeId,
      variantId: soap.variant.id,
      expectedVersion: 1,
    });
    expect(removed.changed).toBe(true);
    expect(removed.line).toMatchObject({ status: "REMOVED", version: 2 });
    expect(removed.line.countedQuantity.toMinorUnitsString()).toBe("7");
    expect(removed.stocktake).toMatchObject({ version: 3, countedLineCount: 0 });
    expect(h.inventoryAudit()).toHaveLength(audit);
  });

  it("is a no-op on a REMOVED line before any version check, and recounting reuses the row", async () => {
    const { h, mine, soap, start, count } = await setup();
    const stocktake = await start();
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
    const target = { stocktakeId: stocktake.stocktakeId, variantId: soap.variant.id };
    await h.removeStocktakeLine.execute(mine.OWNER, { ...target, expectedVersion: 1 });
    const before = h.state();
    const again = await h.removeStocktakeLine.execute(mine.OWNER, { ...target, expectedVersion: 99 });
    expect(again.changed).toBe(false);
    expect(h.state()).toBe(before);
    const recount = await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("8"), 2);
    expect(recount.line).toMatchObject({ status: "COUNTED", version: 3 });
    expect(h.inventory.stocktakeLines).toHaveLength(1);
  });

  it("checks the line version and is NOT_FOUND for a missing line or another location's stocktake", async () => {
    const { h, mine, soap, rice, start, count, backStore } = await setup();
    const stocktake = await start();
    const elsewhere = await start(backStore());
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("7"));
    const before = h.state();
    await expect(
      h.removeStocktakeLine.execute(mine.OWNER, {
        stocktakeId: stocktake.stocktakeId,
        variantId: soap.variant.id,
        expectedVersion: 2,
      }),
    ).rejects.toThrow(VersionConflictError);
    for (const target of [
      { stocktakeId: stocktake.stocktakeId, variantId: rice.variant.id },
      { stocktakeId: elsewhere.stocktakeId, variantId: soap.variant.id },
      { stocktakeId: "nope", variantId: soap.variant.id },
    ]) {
      await expect(h.removeStocktakeLine.execute(mine.OWNER, { ...target, expectedVersion: 1 })).rejects.toThrow(
        NotFoundError,
      );
    }
    expect(h.state()).toBe(before);
  });

  it("is a CONFLICT once the stocktake is no longer a DRAFT", async () => {
    const { h, mine, soap, rice, start, count } = await setup();
    const stocktake = await start();
    await count(mine.OWNER, stocktake.stocktakeId, soap.variant.id, pieces("10"));
    await count(mine.OWNER, stocktake.stocktakeId, rice.variant.id, { decimal: "2", unit: "KG" });
    await h.postStocktake.execute(mine.OWNER, { stocktakeId: stocktake.stocktakeId, expectedVersion: 3 });
    await expect(
      h.removeStocktakeLine.execute(mine.OWNER, {
        stocktakeId: stocktake.stocktakeId,
        variantId: soap.variant.id,
        expectedVersion: 1,
      }),
    ).rejects.toThrow(ConflictError);
  });
});
