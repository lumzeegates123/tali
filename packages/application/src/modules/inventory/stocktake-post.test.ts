import type { CatalogProduct } from "@tali/domain";
import { defineCurrency, parseUnitCode } from "@tali/domain";
import { describe, expect, it } from "vitest";
import type { LocationBoundContext } from "../../context/business-context.js";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  StocktakeStaleError,
  ValidationError,
  VersionConflictError,
} from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";
import type { PostStocktakeInput } from "./stocktakes.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  const oil = await h.product(mine.OWNER, { name: "Oil" });
  const salt = await h.product(mine.OWNER, { name: "Salt" });
  await h.recordOpeningStock.execute(mine.OWNER, {
    lines: [
      { variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" },
      { variantId: oil.variant.id, quantityMinor: "4", unit: "PIECE" },
      { variantId: salt.variant.id, quantityMinor: "6", unit: "PIECE" },
    ],
    idempotencyKey: key(),
  });
  const createKey = key();
  const created = await h.createStocktake.execute(mine.OWNER, { note: "Month end", idempotencyKey: createKey });
  const stocktakeId = created.stocktake.stocktakeId;
  const count = (variantId: string, quantityMinor: string, expectedVersion?: number, context = mine.OWNER) =>
    h.recordStocktakeCount.execute(context, {
      stocktakeId,
      variantId,
      count: { quantityMinor, unit: "PIECE" },
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  const version = () => h.inventory.stocktakes.find((s) => s.id === stocktakeId)?.version ?? 0;
  const post = (context: LocationBoundContext = mine.OWNER, expectedVersion = version()) =>
    h.postStocktake.execute(context, { stocktakeId, expectedVersion });
  return { h, mine, theirs, key, soap, oil, salt, created, createKey, stocktakeId, count, version, post };
}

describe("PostStocktake", () => {
  it("posts one COUNT_CORRECTION per non-zero variance, stores every variance and audits the totals", async () => {
    const { h, mine, soap, oil, salt, stocktakeId, count, post } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "4");
    await count(salt.variant.id, "9");
    const lineVersions = h.inventory.stocktakeLines.map((line) => [line.variantId, line.version]);
    const result = await post(mine.MANAGER);
    expect(result.changed).toBe(true);
    expect(result.stocktake).toMatchObject({
      visibility: "FULL",
      status: "POSTED",
      version: 5,
      countedLineCount: 3,
      posting: { correctionMovementCount: 2, zeroVarianceCount: 1 },
    });
    const expected = [
      { variantId: soap.variant.id, delta: "-2" },
      { variantId: salt.variant.id, delta: "3" },
    ].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
    expect(result.movements.map((m) => ({ variantId: m.variantId, delta: m.delta.toMinorUnitsString() }))).toEqual(
      expected,
    );
    expect(result.movements.every((m) => m.type === "COUNT_CORRECTION")).toBe(true);
    for (const movement of result.movements) {
      expect(movement.source).toEqual({ kind: "STOCKTAKE", id: stocktakeId });
      expect(movement.locationId).toBe(mine.MANAGER.locationId);
    }
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("8");
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("4");
    expect(h.stock(mine.OWNER, salt.variant.id)).toBe("9");
    const variances = Object.fromEntries(
      h.inventory.stocktakeLines.map((line) => [line.variantId, line.variance?.toMinorUnitsString()]),
    );
    expect(variances).toEqual({ [soap.variant.id]: "-2", [oil.variant.id]: "0", [salt.variant.id]: "3" });
    expect(h.inventory.stocktakeLines.map((line) => [line.variantId, line.version])).toEqual(lineVersions);
    const audit = h.inventoryAudit().at(-1);
    expect(audit).toMatchObject({
      action: "inventory.stocktake_posted",
      entityType: "stocktake",
      entityId: stocktakeId,
      payload: { countedLineCount: 3, correctionMovementCount: 2, zeroVarianceCount: 1 },
    });
    const payload = audit?.payload as {
      countedLineCount: number;
      correctionMovementCount: number;
      zeroVarianceCount: number;
    };
    expect(payload.correctionMovementCount + payload.zeroVarianceCount).toBe(payload.countedLineCount);
    h.inventory.assertConsistent();
  });

  it("posts only COUNTED lines: REMOVED lines produce nothing", async () => {
    const { h, soap, oil, count, post, stocktakeId, mine } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "1");
    await h.removeStocktakeLine.execute(mine.OWNER, { stocktakeId, variantId: oil.variant.id, expectedVersion: 1 });
    const result = await post();
    expect(result.movements.map((m) => m.variantId)).toEqual([soap.variant.id]);
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("4");
    expect(h.inventory.stocktakeLines.find((l) => l.variantId === oil.variant.id)?.variance).toBeUndefined();
  });

  it("posts an all-zero-variance stocktake with no movement and no balance change", async () => {
    const { h, soap, count, post } = await setup();
    await count(soap.variant.id, "10");
    const movements = h.inventory.movements.length;
    const result = await post();
    expect(result.movements).toEqual([]);
    expect(result.stocktake.posting).toEqual({ correctionMovementCount: 0, zeroVarianceCount: 1 });
    expect(h.inventory.movements).toHaveLength(movements);
    h.inventory.assertConsistent();
  });

  it("is a no-op for a POSTED stocktake, ignoring expectedVersion", async () => {
    const { h, soap, count, post } = await setup();
    await count(soap.variant.id, "8");
    const first = await post();
    const before = h.state();
    const again = await post(undefined, 1);
    expect(again.changed).toBe(false);
    expect(again.movements).toEqual([]);
    expect(again.stocktake).toEqual(first.stocktake);
    expect(h.state()).toBe(before);
  });

  it("checks the version, rejects an empty stocktake and a cancelled one, and writes nothing", async () => {
    const { h, mine, soap, stocktakeId, count, post } = await setup();
    let before = h.state();
    await expect(post(mine.OWNER, 1)).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
    await count(soap.variant.id, "8");
    before = h.state();
    await expect(post(mine.OWNER, 1)).rejects.toThrow(VersionConflictError);
    const withoutVersion = { stocktakeId } as unknown as PostStocktakeInput;
    await expect(h.postStocktake.execute(mine.OWNER, withoutVersion)).rejects.toThrow(ValidationError);
    expect(h.state()).toBe(before);
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 2 });
    await expect(post(mine.OWNER, 3)).rejects.toThrow(ConflictError);
  });

  it("rejects a stocktake with only REMOVED lines (decision D10)", async () => {
    const { h, mine, soap, stocktakeId, count, post } = await setup();
    await count(soap.variant.id, "8");
    await h.removeStocktakeLine.execute(mine.OWNER, { stocktakeId, variantId: soap.variant.id, expectedVersion: 1 });
    const before = h.state();
    await expect(post()).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
  });

  it("is OWNER and MANAGER only, and NOT_FOUND across tenants and locations", async () => {
    const { h, mine, theirs, soap, stocktakeId, count } = await setup();
    await count(soap.variant.id, "8");
    const before = h.state();
    h.calls.length = 0;
    for (const role of ["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(h.postStocktake.execute(mine[role], { stocktakeId, expectedVersion: 2 })).rejects.toThrow(
        PermissionDeniedError,
      );
    }
    expect(h.calls).toEqual([]);
    await expect(h.postStocktake.execute(theirs.OWNER, { stocktakeId, expectedVersion: 2 })).rejects.toThrow(
      NotFoundError,
    );
    await expect(h.postStocktake.execute(mine.OWNER, { stocktakeId: "nope", expectedVersion: 2 })).rejects.toThrow(
      NotFoundError,
    );
    expect(h.state()).toBe(before);
  });

  it("is a CONFLICT for a line whose product stopped tracking inventory, and allows an archived one", async () => {
    const { h, mine, soap, oil, count, post } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "3");
    await h.catalog.archiveProduct.execute(mine.OWNER, { productId: oil.product.id, expectedVersion: 1 });
    const stored = h.catalog.catalog.products.find((item) => item.variant.id === soap.variant.id);
    if (stored === undefined) throw new Error("missing product");
    const untracked: CatalogProduct = { ...stored, variant: { ...stored.variant, trackInventory: false } };
    h.catalog.catalog.putProduct(untracked);
    const before = h.state();
    await expect(post()).rejects.toThrow(ConflictError);
    expect(h.state()).toBe(before);
    h.catalog.catalog.putProduct(stored);
    const result = await post();
    expect(result.stocktake.posting).toEqual({ correctionMovementCount: 2, zeroVarianceCount: 0 });
  });

  it("follows the lock order: header, counted lines, variants FOR SHARE, balances FOR UPDATE, then writes", async () => {
    const { h, soap, oil, count, post } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "4");
    h.calls.length = 0;
    await post();
    expect(h.calls).toEqual([
      "memberships.findByBusinessAndUser",
      "stocktakes.findByIdForUpdate",
      "stocktakeLines.listCounted",
      "products.lockVariantsForShare",
      "balances.lockForUpdate",
      "movements.insertMany",
      "balances.apply",
      "stocktakeLines.applyPostingVariances",
      "stocktakes.update",
      "audit.recordBusinessEvent",
      "stocktakeLines.countByStatus",
    ]);
  });
});

describe("PostStocktake staleness (decisions D4 and D8)", () => {
  it("is STOCKTAKE_STALE when a counted item moved since it was counted, and writes nothing", async () => {
    const { h, mine, key, soap, oil, count, post } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "4");
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: oil.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    const before = h.state();
    const error = await post().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StocktakeStaleError);
    if (!(error instanceof StocktakeStaleError)) throw new Error("expected a stale stocktake");
    expect(error.retryable).toBe(false);
    expect(error.staleVariantIds).toEqual([oil.variant.id]);
    expect(error.staleLineCount).toBe(1);
    expect(h.state()).toBe(before);
    h.inventory.assertConsistent();
  });

  it("is STOCKTAKE_STALE when the stock unit changed since the count, even at the same balance version", async () => {
    const { h, mine, count, post } = await setup();
    const fresh = await h.product(mine.OWNER, { name: "Fresh" });
    await count(fresh.variant.id, "0");
    const stored = h.catalog.catalog.products.find((item) => item.variant.id === fresh.variant.id);
    if (stored === undefined) throw new Error("missing product");
    h.catalog.catalog.putProduct({ ...stored, variant: { ...stored.variant, stockUnit: parseUnitCode("KG") } });
    const before = h.state();
    const error = await post().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StocktakeStaleError);
    expect((error as StocktakeStaleError).staleVariantIds).toEqual([fresh.variant.id]);
    expect(h.state()).toBe(before);
  });

  it("reports every stale line: the total, and the first 50 IDs in ascending order", async () => {
    const { h, mine, key, count, post } = await setup();
    const products: CatalogProduct[] = [];
    for (let index = 0; index < 51; index += 1) products.push(await h.product(mine.OWNER, { name: `Item ${index}` }));
    for (const product of products) await count(product.variant.id, "1");
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: products.map((product) => ({ variantId: product.variant.id, quantityMinor: "1", unit: "PIECE" })),
      idempotencyKey: key(),
    });
    const error = await post().catch((caught: unknown) => caught);
    if (!(error instanceof StocktakeStaleError)) throw new Error("expected a stale stocktake");
    const sorted = products.map((product) => product.variant.id).sort();
    expect(error.staleLineCount).toBe(51);
    expect(error.staleVariantIds).toEqual(sorted.slice(0, 50));
    expect(error.message).not.toMatch(/[0-9a-f]{8}-/);
  });

  it("succeeds once the stale lines are recounted", async () => {
    const { h, mine, key, soap, oil, count, post } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "4");
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [{ variantId: oil.variant.id, quantityMinor: "1", unit: "PIECE" }],
      idempotencyKey: key(),
    });
    await expect(post()).rejects.toThrow(StocktakeStaleError);
    await count(oil.variant.id, "4", 1);
    const result = await post();
    expect(h.stock(mine.OWNER, oil.variant.id)).toBe("4");
    expect(result.stocktake.posting).toEqual({ correctionMovementCount: 2, zeroVarianceCount: 0 });
    h.inventory.assertConsistent();
  });
});

describe("CancelStocktake", () => {
  it("cancels a DRAFT, keeps its lines and audits the counted line count with the reason", async () => {
    const { h, mine, soap, oil, stocktakeId, count } = await setup();
    await count(soap.variant.id, "8");
    await count(oil.variant.id, "2");
    await h.removeStocktakeLine.execute(mine.OWNER, { stocktakeId, variantId: oil.variant.id, expectedVersion: 1 });
    const movements = h.inventory.movements.length;
    const result = await h.cancelStocktake.execute(mine.MANAGER, {
      stocktakeId,
      expectedVersion: 4,
      reason: "  Wrong shelf  ",
    });
    expect(result.changed).toBe(true);
    expect(result.stocktake).toMatchObject({ status: "CANCELLED", version: 5, countedLineCount: 1 });
    expect(result.stocktake.posting).toBeUndefined();
    expect(h.inventory.stocktakeLines).toHaveLength(2);
    expect(h.inventory.movements).toHaveLength(movements);
    expect(h.inventoryAudit().at(-1)).toMatchObject({
      action: "inventory.stocktake_cancelled",
      entityId: stocktakeId,
      reason: "Wrong shelf",
      payload: { countedLineCount: 1 },
    });
  });

  it("cancels without a reason, and an empty DRAFT", async () => {
    const { h, mine, stocktakeId } = await setup();
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 1 });
    const audit = h.inventoryAudit().at(-1);
    expect(audit).toMatchObject({ action: "inventory.stocktake_cancelled", payload: { countedLineCount: 0 } });
    expect(audit?.reason).toBeUndefined();
  });

  it("is a no-op when CANCELLED (before the version check) and a CONFLICT when POSTED", async () => {
    const { h, mine, key, soap, stocktakeId } = await setup();
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 1 });
    const before = h.state();
    const again = await h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 99 });
    expect(again.changed).toBe(false);
    expect(h.state()).toBe(before);

    const next = await h.createStocktake.execute(mine.OWNER, { idempotencyKey: key() });
    await h.recordStocktakeCount.execute(mine.OWNER, {
      stocktakeId: next.stocktake.stocktakeId,
      variantId: soap.variant.id,
      count: { quantityMinor: "10", unit: "PIECE" },
    });
    await h.postStocktake.execute(mine.OWNER, { stocktakeId: next.stocktake.stocktakeId, expectedVersion: 2 });
    await expect(
      h.cancelStocktake.execute(mine.OWNER, { stocktakeId: next.stocktake.stocktakeId, expectedVersion: 3 }),
    ).rejects.toThrow(ConflictError);
  });

  it("checks the version, the reason, the permission and the tenant", async () => {
    const { h, mine, theirs, stocktakeId } = await setup();
    const before = h.state();
    await expect(h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 2 })).rejects.toThrow(
      VersionConflictError,
    );
    for (const reason of ["   ", "x".repeat(501)]) {
      await expect(h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 1, reason })).rejects.toThrow(
        ValidationError,
      );
    }
    for (const role of ["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(h.cancelStocktake.execute(mine[role], { stocktakeId, expectedVersion: 1 })).rejects.toThrow(
        PermissionDeniedError,
      );
    }
    await expect(h.cancelStocktake.execute(theirs.OWNER, { stocktakeId, expectedVersion: 1 })).rejects.toThrow(
      NotFoundError,
    );
    expect(h.state()).toBe(before);
  });
});

describe("stocktake creation replay is immutable", () => {
  it("returns the original DRAFT version-1 snapshot after counts, posting and cancellation", async () => {
    const { h, mine, soap, created, createKey, count, post } = await setup();
    const replay = () => h.createStocktake.execute(mine.OWNER, { note: "Month end", idempotencyKey: createKey });
    await count(soap.variant.id, "8");
    expect(await replay()).toEqual({ stocktake: created.stocktake, replayed: true });
    await post();
    expect(await replay()).toEqual({ stocktake: created.stocktake, replayed: true });

    const otherKey = h.catalog.tenancy.ids.newId("IdempotencyKey");
    const second = await h.createStocktake.execute(mine.OWNER, { idempotencyKey: otherKey });
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId: second.stocktake.stocktakeId, expectedVersion: 1 });
    expect(await h.createStocktake.execute(mine.OWNER, { idempotencyKey: otherKey })).toEqual({
      stocktake: second.stocktake,
      replayed: true,
    });
    expect(second.stocktake).toMatchObject({ status: "DRAFT", version: 1 });
  });
});

describe("stocktake rollback", () => {
  it.each([
    ["idempotency", "businessIdempotency.insert"],
    ["inventory", "stocktakes.insert"],
    ["audit", "audit.inventory.stocktake_started"],
  ] as const)("rolls back a create failing after %s (%s), then retries fresh", async (store, op) => {
    const { h, mine, key } = await setup();
    await h.cancelStocktake.execute(mine.OWNER, {
      stocktakeId: h.inventory.stocktakes[0]?.id ?? "",
      expectedVersion: 1,
    });
    const failures = {
      idempotency: h.catalog.tenancy.businessIdempotencyStore.failures,
      inventory: h.inventory.failures,
      audit: h.catalog.tenancy.auditWriter.failures,
    }[store];
    failures.failAfter(op);
    const input = { idempotencyKey: key() };
    const before = h.state();
    await expect(h.createStocktake.execute(mine.OWNER, input)).rejects.toThrow(/injected failure/);
    expect(h.state()).toBe(before);
    const retried = await h.createStocktake.execute(mine.OWNER, input);
    expect(retried.replayed).toBe(false);
  });

  it.each([
    ["inventory", "movements.insertMany"],
    ["inventory", "balances.apply"],
    ["inventory", "stocktakeLines.applyPostingVariances"],
    ["inventory", "stocktakes.update"],
    ["audit", "audit.inventory.stocktake_posted"],
  ] as const)("rolls back a post failing after %s (%s) and leaves the DRAFT postable", async (store, op) => {
    const { h, mine, soap, salt, count, post } = await setup();
    await count(soap.variant.id, "8");
    await count(salt.variant.id, "9");
    const failures = { inventory: h.inventory.failures, audit: h.catalog.tenancy.auditWriter.failures }[store];
    failures.failAfter(op);
    const before = h.state();
    await expect(post()).rejects.toThrow(/injected failure/);
    expect(h.state()).toBe(before);
    h.inventory.assertConsistent();
    const result = await post();
    expect(result.changed).toBe(true);
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("8");
    h.inventory.assertConsistent();
  });

  it.each([
    ["inventory", "stocktakes.update"],
    ["audit", "audit.inventory.stocktake_cancelled"],
  ] as const)("rolls back a cancel failing after %s (%s)", async (store, op) => {
    const { h, mine, stocktakeId } = await setup();
    const failures = { inventory: h.inventory.failures, audit: h.catalog.tenancy.auditWriter.failures }[store];
    failures.failAfter(op);
    const before = h.state();
    await expect(h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 1 })).rejects.toThrow(
      /injected failure/,
    );
    expect(h.state()).toBe(before);
    expect((await h.cancelStocktake.execute(mine.OWNER, { stocktakeId, expectedVersion: 1 })).changed).toBe(true);
  });
});
