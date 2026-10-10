import type { CatalogProduct } from "@tali/domain";
import { defineCurrency, restoreLocation, restoreStocktakeLine } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { permissionSet } from "../../authorization/permissions.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../../errors/application-error.js";
import { createInventoryHarness } from "../../testing/inventory-harness.js";
import { inventoryPermissions } from "../identity/index.js";
import { stocktakeLineView, stocktakeView } from "./stocktake-views.js";

async function setup() {
  const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2), defineCurrency("KES", 2)] });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
  const soap = await h.product(mine.OWNER, { name: "Soap" });
  const oil = await h.product(mine.OWNER, { name: "Oil" });
  await h.recordOpeningStock.execute(mine.OWNER, {
    lines: [
      { variantId: soap.variant.id, quantityMinor: "10", unit: "PIECE" },
      { variantId: oil.variant.id, quantityMinor: "4", unit: "PIECE" },
    ],
    idempotencyKey: key(),
  });
  const draft = (await h.createStocktake.execute(mine.OWNER, { idempotencyKey: key() })).stocktake;
  const count = (variantId: string, quantityMinor: string, expectedVersion?: number) =>
    h.recordStocktakeCount.execute(mine.OWNER, {
      stocktakeId: draft.stocktakeId,
      variantId,
      count: { quantityMinor, unit: "PIECE" },
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
  return { h, mine, theirs, key, soap, oil, draft, count };
}

describe("stocktake views: FULL and BLIND (ADR-008 section 12.3)", () => {
  it("gives OWNER and MANAGER FULL lines, STOCK_KEEPER BLIND lines whose hidden keys do not exist", async () => {
    const { h, mine, soap, draft, count } = await setup();
    await count(soap.variant.id, "7");
    for (const role of ["OWNER", "MANAGER"] as const) {
      const page = await h.listStocktakeLines.execute(mine[role], { stocktakeId: draft.stocktakeId });
      const line = page.items[0];
      expect(line?.visibility).toBe("FULL");
      if (line?.visibility !== "FULL") throw new Error("expected FULL");
      expect(line.expectedAtCount.toMinorUnitsString()).toBe("10");
      expect("variance" in line).toBe(false);
    }
    const blind = (await h.listStocktakeLines.execute(mine.STOCK_KEEPER, { stocktakeId: draft.stocktakeId })).items[0];
    expect(blind === undefined ? [] : Object.keys(blind).sort()).toEqual(
      ["countedAt", "countedQuantity", "status", "stockUnit", "variantId", "version", "visibility"].sort(),
    );
    expect(blind !== undefined && "expectedAtCount" in blind).toBe(false);
    expect(blind !== undefined && "variance" in blind).toBe(false);
    expect((await h.getStocktake.execute(mine.STOCK_KEEPER, { stocktakeId: draft.stocktakeId })).visibility).toBe(
      "BLIND",
    );
  });

  it("returns a BLIND line to a STOCK_KEEPER from count and remove too", async () => {
    const { h, mine, soap, draft } = await setup();
    const counted = await h.recordStocktakeCount.execute(mine.STOCK_KEEPER, {
      stocktakeId: draft.stocktakeId,
      variantId: soap.variant.id,
      count: { quantityMinor: "3", unit: "PIECE" },
    });
    expect("expectedAtCount" in counted.line).toBe(false);
    const removed = await h.removeStocktakeLine.execute(mine.STOCK_KEEPER, {
      stocktakeId: draft.stocktakeId,
      variantId: soap.variant.id,
      expectedVersion: 1,
    });
    expect("expectedAtCount" in removed.line).toBe(false);
  });

  it("follows the context's permissions, never the membership role, on mutations and queries alike", async () => {
    const { h, mine, soap, oil, draft } = await setup();
    const countPost = inventoryPermissions.permissions["inventory:count-post"];
    // A MANAGER membership whose context lacks count-post, and a STOCK_KEEPER whose context holds it:
    // a role-based rule would answer FULL and BLIND respectively.
    const managerWithoutPost = {
      ...mine.MANAGER,
      permissions: permissionSet([...mine.MANAGER.permissions].filter((permission) => permission !== countPost)),
    };
    const keeperWithPost = {
      ...mine.STOCK_KEEPER,
      permissions: permissionSet([...mine.STOCK_KEEPER.permissions, countPost]),
    };
    const cases = [
      { context: managerWithoutPost, variantId: soap.variant.id, expected: "BLIND" },
      { context: keeperWithPost, variantId: oil.variant.id, expected: "FULL" },
    ] as const;
    for (const { context, variantId, expected } of cases) {
      const counted = await h.recordStocktakeCount.execute(context, {
        stocktakeId: draft.stocktakeId,
        variantId,
        count: { quantityMinor: "1", unit: "PIECE" },
      });
      expect([counted.stocktake.visibility, counted.line.visibility]).toEqual([expected, expected]);
      const removed = await h.removeStocktakeLine.execute(context, {
        stocktakeId: draft.stocktakeId,
        variantId,
        expectedVersion: 1,
      });
      expect([removed.stocktake.visibility, removed.line.visibility]).toEqual([expected, expected]);
      expect((await h.getStocktake.execute(context, { stocktakeId: draft.stocktakeId })).visibility).toBe(expected);
      expect((await h.listStocktakes.execute(context)).items.map((item) => item.visibility)).toEqual([expected]);
      const lines = await h.listStocktakeLines.execute(context, { stocktakeId: draft.stocktakeId });
      const own = lines.items.find((line) => line.variantId === variantId);
      expect(own?.visibility).toBe(expected);
      expect(own !== undefined && "expectedAtCount" in own).toBe(expected === "FULL");
    }
  });

  it("shows variances on a POSTED stocktake to FULL viewers, and line and posting counts to everyone", async () => {
    const { h, mine, soap, oil, draft, count } = await setup();
    await count(soap.variant.id, "7");
    await count(oil.variant.id, "4");
    await h.postStocktake.execute(mine.OWNER, { stocktakeId: draft.stocktakeId, expectedVersion: 3 });
    const full = await h.listStocktakeLines.execute(mine.MANAGER, { stocktakeId: draft.stocktakeId });
    const variances = full.items.map((line) =>
      line.visibility === "FULL" ? line.variance?.toMinorUnitsString() : "hidden",
    );
    expect(new Set(variances)).toEqual(new Set(["-3", "0"]));
    const blind = await h.listStocktakeLines.execute(mine.STOCK_KEEPER, { stocktakeId: draft.stocktakeId });
    expect(blind.items.every((line) => !("variance" in line))).toBe(true);
    const summary = await h.getStocktake.execute(mine.STOCK_KEEPER, { stocktakeId: draft.stocktakeId });
    expect(summary).toMatchObject({
      visibility: "BLIND",
      status: "POSTED",
      countedLineCount: 2,
      posting: { correctionMovementCount: 1, zeroVarianceCount: 1 },
    });
  });

  it("has no posting totals before posting", async () => {
    const { h, mine, soap, draft, count } = await setup();
    await count(soap.variant.id, "7");
    const view = await h.getStocktake.execute(mine.OWNER, { stocktakeId: draft.stocktakeId });
    expect(view).toMatchObject({ status: "DRAFT", countedLineCount: 1 });
    expect("posting" in view).toBe(false);
  });

  it("fails loudly on stored variances that contradict the stocktake status", async () => {
    const { h, soap, count } = await setup();
    await count(soap.variant.id, "7");
    const stocktake = h.inventory.stocktakes[0];
    const line = h.inventory.stocktakeLines[0];
    if (stocktake === undefined || line === undefined) throw new Error("missing stocktake");
    const posted = { ...stocktake, status: "POSTED" as const };
    expect(() => stocktakeLineView(posted, line, "FULL")).toThrow(/variance/);
    expect(() =>
      stocktakeView(posted, { counted: 1, removed: 0, nonZeroVariance: 0, zeroVariance: 0 }, "FULL"),
    ).toThrow(/variances/);
    const withVariance = restoreStocktakeLine({ ...line, variance: line.countedQuantity });
    expect(() => stocktakeLineView(stocktake, withVariance, "FULL")).toThrow(/variance/);
    expect(() =>
      stocktakeView(stocktake, { counted: 1, removed: 0, nonZeroVariance: 1, zeroVariance: 0 }, "BLIND"),
    ).toThrow(/variances/);
  });
});

describe("stocktake queries", () => {
  it("are denied to CASHIER and ACCOUNTANT", async () => {
    const { h, mine, draft } = await setup();
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(h.listStocktakes.execute(mine[role])).rejects.toThrow(PermissionDeniedError);
      await expect(h.getStocktake.execute(mine[role], { stocktakeId: draft.stocktakeId })).rejects.toThrow(
        PermissionDeniedError,
      );
      await expect(h.listStocktakeLines.execute(mine[role], { stocktakeId: draft.stocktakeId })).rejects.toThrow(
        PermissionDeniedError,
      );
    }
  });

  it("hide another business's and another location's stocktakes", async () => {
    const { h, mine, theirs, key, draft } = await setup();
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
    const back = { ...mine.OWNER, locationId: location.id };
    await h.createStocktake.execute(back, { idempotencyKey: key() });
    for (const context of [theirs.OWNER, back]) {
      await expect(h.getStocktake.execute(context, { stocktakeId: draft.stocktakeId })).rejects.toThrow(NotFoundError);
      await expect(h.listStocktakeLines.execute(context, { stocktakeId: draft.stocktakeId })).rejects.toThrow(
        NotFoundError,
      );
    }
    await expect(h.getStocktake.execute(mine.OWNER, { stocktakeId: "nope" })).rejects.toThrow(NotFoundError);
    expect((await h.listStocktakes.execute(theirs.OWNER)).items).toEqual([]);
    const mineList = await h.listStocktakes.execute(mine.OWNER);
    expect(mineList.items.map((item) => item.stocktakeId)).toEqual([draft.stocktakeId]);
  });

  it("list stocktakes by status in ID order with keyset pages, in one repository call", async () => {
    const { h, mine, key, soap, draft, count } = await setup();
    await count(soap.variant.id, "10");
    await h.postStocktake.execute(mine.OWNER, { stocktakeId: draft.stocktakeId, expectedVersion: 2 });
    const second = (await h.createStocktake.execute(mine.OWNER, { idempotencyKey: key() })).stocktake;
    await h.cancelStocktake.execute(mine.OWNER, { stocktakeId: second.stocktakeId, expectedVersion: 1 });
    const third = (await h.createStocktake.execute(mine.OWNER, { idempotencyKey: key() })).stocktake;
    h.calls.length = 0;
    const all = await h.listStocktakes.execute(mine.OWNER);
    expect(h.calls).toEqual(["stocktakes.list"]);
    expect(all.items.map((item) => [item.stocktakeId, item.status])).toEqual([
      [draft.stocktakeId, "POSTED"],
      [second.stocktakeId, "CANCELLED"],
      [third.stocktakeId, "DRAFT"],
    ]);
    expect(all.items[0]?.posting).toEqual({ correctionMovementCount: 0, zeroVarianceCount: 1 });
    const posted = await h.listStocktakes.execute(mine.OWNER, { status: "POSTED" });
    expect(posted.items.map((item) => item.stocktakeId)).toEqual([draft.stocktakeId]);
    const first = await h.listStocktakes.execute(mine.OWNER, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const rest = await h.listStocktakes.execute(mine.OWNER, { limit: 2, after: first.nextCursor ?? "" });
    expect(rest.items.map((item) => item.stocktakeId)).toEqual([third.stocktakeId]);
    expect(rest.nextCursor).toBeNull();
    await expect(h.listStocktakes.execute(mine.OWNER, { status: "OPEN" })).rejects.toThrow(ValidationError);
  });

  it("list lines by variant ID with keyset pages, REMOVED lines included", async () => {
    const { h, mine, draft, count } = await setup();
    const products: CatalogProduct[] = [];
    for (let index = 0; index < 5; index += 1) products.push(await h.product(mine.OWNER, { name: `Item ${index}` }));
    for (const product of products) await count(product.variant.id, "0");
    const removed = products[2];
    if (removed === undefined) throw new Error("missing product");
    await h.removeStocktakeLine.execute(mine.OWNER, {
      stocktakeId: draft.stocktakeId,
      variantId: removed.variant.id,
      expectedVersion: 1,
    });
    const sorted = products.map((product) => product.variant.id).sort();
    const first = await h.listStocktakeLines.execute(mine.OWNER, { stocktakeId: draft.stocktakeId, limit: 3 });
    const rest = await h.listStocktakeLines.execute(mine.OWNER, {
      stocktakeId: draft.stocktakeId,
      limit: 3,
      after: first.nextCursor ?? "",
    });
    expect([...first.items, ...rest.items].map((line) => line.variantId)).toEqual(sorted);
    expect(rest.nextCursor).toBeNull();
    expect([...first.items, ...rest.items].find((line) => line.variantId === removed.variant.id)?.status).toBe(
      "REMOVED",
    );
  });
});
