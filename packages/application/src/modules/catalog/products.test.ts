import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  VersionConflictError,
} from "../../errors/application-error.js";
import type { CatalogHarness } from "../../testing/catalog-harness.js";
import { createCatalogHarness } from "../../testing/catalog-harness.js";
import type { CreateProductInput } from "./index.js";

const CURRENCIES = [
  defineCurrency("NGN", 2),
  defineCurrency("KES", 2),
  defineCurrency("JPY", 0),
  defineCurrency("KWD", 3),
];

async function setup() {
  const h = createCatalogHarness({ currencies: CURRENCIES });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.tenancy.ids.newId("IdempotencyKey");
  const input = (overrides: Partial<CreateProductInput> = {}): CreateProductInput => ({
    name: "Peak Milk 400g",
    stockUnit: "PIECE",
    trackInventory: true,
    idempotencyKey: key(),
    ...overrides,
  });
  return { h, mine, theirs, key, input };
}

function snapshot(h: CatalogHarness) {
  return JSON.stringify({
    products: h.catalog.products.map((item) => ({ ...item, price: item.variant.sellingPrice?.toMinorUnitsString() })),
    categories: h.catalog.categories,
    packs: h.catalog.packs.map((pack) => ({ ...pack, factorMinor: pack.factorMinor.toString() })),
    prices: h.catalog.priceHistory.length,
    audit: h.tenancy.auditWriter.businessRecords.length,
    keys: h.tenancy.businessIdempotencyStore.records.length,
  });
}

function catalogAudit(h: CatalogHarness) {
  return h.tenancy.auditWriter.businessRecords.filter((record) => record.action.startsWith("product"));
}

describe("CreateProduct", () => {
  it("creates a product with its hidden default variant and audits it", async () => {
    const { h, mine, input } = await setup();
    const outcome = await h.createProduct.execute(
      mine.STOCK_KEEPER,
      input({ sku: " pk-400 ", barcode: "036000291452", stockUnit: "KG" }),
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.item.product).toMatchObject({ businessId: mine.OWNER.businessId, status: "ACTIVE", version: 1 });
    expect(outcome.item.variant).toMatchObject({
      isDefault: true,
      productId: outcome.item.product.id,
      stockUnit: "KG",
      priceVersion: 0,
    });
    expect(outcome.item.variant.sku).toEqual({ value: "pk-400", normalized: "PK-400" });
    expect(outcome.item.variant.barcode?.normalized).toBe("00036000291452");
    expect(h.catalog.products).toHaveLength(1);
    expect(h.catalog.priceHistory).toHaveLength(0);
    const audit = catalogAudit(h);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "product.created",
      entityType: "product",
      entityId: outcome.item.product.id,
      payloadSchemaVersion: 1,
      payload: {
        variantId: outcome.item.variant.id,
        name: "Peak Milk 400g",
        sku: "pk-400",
        barcode: "036000291452",
        stockUnit: "KG",
        trackInventory: true,
      },
    });
    expect(audit[0]?.idempotencyKey).toBeDefined();
  });

  it("creates the first price history row when created with a price (product:manage and product:price)", async () => {
    const { h, mine, input } = await setup();
    const outcome = await h.createProduct.execute(
      mine.MANAGER,
      input({ initialPrice: { amountMinor: "125050", currency: "NGN" } }),
    );
    expect(outcome.item.variant.sellingPrice?.toMinorUnitsString()).toBe("125050");
    expect(outcome.item.variant.priceVersion).toBe(1);
    expect(h.catalog.priceHistory).toMatchObject([{ priceVersion: 1, variantId: outcome.item.variant.id }]);
    expect(catalogAudit(h).map((r) => r.action)).toEqual(["product.created", "product.price_set"]);
    expect(catalogAudit(h)[1]?.payload).toEqual({
      variantId: outcome.item.variant.id,
      toAmountMinor: "125050",
      currency: "NGN",
      priceVersion: 1,
    });
  });

  it("denies an initial price to STOCK_KEEPER (no product:price) without writing", async () => {
    const { h, mine, input } = await setup();
    const before = snapshot(h);
    await expect(
      h.createProduct.execute(mine.STOCK_KEEPER, input({ initialPrice: { amountMinor: "100", currency: "NGN" } })),
    ).rejects.toThrow(PermissionDeniedError);
    expect(snapshot(h)).toBe(before);
  });

  it.each(["CASHIER", "ACCOUNTANT"] as const)("denies %s (no product:manage) without writing", async (role) => {
    const { h, mine, input } = await setup();
    const before = snapshot(h);
    await expect(h.createProduct.execute(mine[role], input())).rejects.toThrow(PermissionDeniedError);
    expect(snapshot(h)).toBe(before);
  });

  it.each([
    ["a blank name", { name: "   " }],
    ["a long name", { name: "x".repeat(121) }],
    ["a long description", { description: "x".repeat(501) }],
    ["a malformed SKU", { sku: "A#1" }],
    ["a malformed barcode", { barcode: "12 34" }],
    ["a malformed unit code", { stockUnit: "kg" }],
    ["an unknown unit", { stockUnit: "CARTON" }],
    ["a non-boolean tracking flag", { trackInventory: "yes" as unknown as boolean }],
    ["a zero price", { initialPrice: { amountMinor: "0", currency: "NGN" } }],
    ["a negative price", { initialPrice: { amountMinor: "-1", currency: "NGN" } }],
    ["a decimal price", { initialPrice: { amountMinor: "12.50", currency: "NGN" } }],
    ["a JSON-number price", { initialPrice: { amountMinor: 100 as unknown as string, currency: "NGN" } }],
    ["a mixed-currency price", { initialPrice: { amountMinor: "100", currency: "KES" } }],
    ["a malformed currency", { initialPrice: { amountMinor: "100", currency: "naira" } }],
  ])("rejects %s with VALIDATION_FAILED and writes nothing", async (_label, overrides) => {
    const { h, mine, input } = await setup();
    const before = snapshot(h);
    await expect(h.createProduct.execute(mine.OWNER, input(overrides))).rejects.toThrow(ValidationError);
    expect(snapshot(h)).toBe(before);
  });

  it("requires an idempotency key", async () => {
    const { h, mine, input } = await setup();
    await expect(h.createProduct.execute(mine.OWNER, input({ idempotencyKey: undefined }))).rejects.toThrow(
      IdempotencyKeyRequiredError,
    );
  });

  it("replays a retry with the same key and command; a different command with the key is rejected", async () => {
    const { h, mine, input, key } = await setup();
    const idempotencyKey = key();
    const first = await h.createProduct.execute(mine.OWNER, input({ idempotencyKey, sku: "A-1" }));
    const auditCount = h.tenancy.auditWriter.businessRecords.length;
    const replay = await h.createProduct.execute(mine.OWNER, input({ idempotencyKey, sku: "A-1" }));
    expect(replay).toEqual({ item: first.item, replayed: true });
    expect(h.catalog.products).toHaveLength(1);
    expect(h.tenancy.auditWriter.businessRecords).toHaveLength(auditCount);
    await expect(
      h.createProduct.execute(mine.OWNER, input({ idempotencyKey, sku: "A-1", name: "Other" })),
    ).rejects.toThrow(IdempotencyKeyReusedError);
    expect(h.catalog.products).toHaveLength(1);
  });

  it("replays a priced creation without a second history row", async () => {
    const { h, mine, input, key } = await setup();
    const idempotencyKey = key();
    const command = input({ idempotencyKey, initialPrice: { amountMinor: "500", currency: "NGN" } });
    const first = await h.createProduct.execute(mine.OWNER, command);
    const replay = await h.createProduct.execute(mine.OWNER, command);
    expect(replay.replayed).toBe(true);
    expect(replay.item.variant.sellingPrice?.toMinorUnitsString()).toBe("500");
    expect(replay.item).toEqual(first.item);
    expect(h.catalog.priceHistory).toHaveLength(1);
  });

  it("rejects a SKU used by another product of the business, in any status, case-insensitively", async () => {
    const { h, mine, input } = await setup();
    const first = await h.createProduct.execute(mine.OWNER, input({ sku: "rice-50" }));
    await h.archiveProduct.execute(mine.OWNER, { productId: first.item.product.id, expectedVersion: 1 });
    await expect(h.createProduct.execute(mine.OWNER, input({ sku: "RICE-50" }))).rejects.toThrow(ConflictError);
    expect(h.catalog.products).toHaveLength(1);
  });

  it("rejects an equivalent GTIN held by an active product; archived holders release it", async () => {
    const { h, mine, input } = await setup();
    const first = await h.createProduct.execute(mine.OWNER, input({ barcode: "036000291452" }));
    await expect(h.createProduct.execute(mine.OWNER, input({ barcode: "0036000291452" }))).rejects.toThrow(
      ConflictError,
    );
    await h.archiveProduct.execute(mine.OWNER, { productId: first.item.product.id, expectedVersion: 1 });
    const second = await h.createProduct.execute(mine.OWNER, input({ barcode: "0036000291452" }));
    expect(second.item.variant.barcode?.normalized).toBe("00036000291452");
  });

  it("does not see another business's SKUs, barcodes or categories", async () => {
    const { h, mine, theirs, input } = await setup();
    await h.createProduct.execute(theirs.OWNER, input({ sku: "SHARED", barcode: "4006381333931" }));
    const category = await h.createCategory.execute(theirs.OWNER, {
      name: "Drinks",
      idempotencyKey: input().idempotencyKey,
    });
    const mineCreated = await h.createProduct.execute(mine.OWNER, input({ sku: "SHARED", barcode: "4006381333931" }));
    expect(mineCreated.item.product.businessId).toBe(mine.OWNER.businessId);
    await expect(h.createProduct.execute(mine.OWNER, input({ categoryId: category.category.id }))).rejects.toThrow(
      NotFoundError,
    );
    await expect(h.createProduct.execute(mine.OWNER, input({ categoryId: "not-a-uuid" }))).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects assigning an archived category", async () => {
    const { h, mine, input, key } = await setup();
    const { category } = await h.createCategory.execute(mine.OWNER, { name: "Old", idempotencyKey: key() });
    await h.archiveCategory.execute(mine.OWNER, { categoryId: category.id, expectedVersion: 1 });
    await expect(h.createProduct.execute(mine.OWNER, input({ categoryId: category.id }))).rejects.toThrow(
      ConflictError,
    );
  });

  it("rolls back the product, audit and key when a later write in the transaction fails", async () => {
    const { h, mine, input } = await setup();
    const before = snapshot(h);
    h.catalog.failures.failNext("prices.append");
    await expect(
      h.createProduct.execute(mine.OWNER, input({ initialPrice: { amountMinor: "100", currency: "NGN" } })),
    ).rejects.toThrow(/injected/);
    expect(snapshot(h)).toBe(before);
  });
});

async function created(overrides: Partial<CreateProductInput> = {}) {
  const context = await setup();
  const { item } = await context.h.createProduct.execute(context.mine.OWNER, context.input(overrides));
  return { ...context, item };
}

describe("UpdateProduct", () => {
  it("applies a real change, increments the version once and audits from/to values", async () => {
    const { h, mine, item, key } = await created({ sku: "A-1", barcode: "SHOP-1" });
    const { category } = await h.createCategory.execute(mine.OWNER, { name: "Dairy", idempotencyKey: key() });
    const result = await h.updateProduct.execute(mine.STOCK_KEEPER, {
      productId: item.product.id,
      expectedVersion: 1,
      name: "Peak Milk 380g",
      description: "Evaporated",
      categoryId: category.id,
      sku: null,
      barcode: "96385074",
      stockUnit: "TIN",
      trackInventory: false,
    });
    expect(result.changed).toBe(true);
    expect(result.item.product).toMatchObject({ name: "Peak Milk 380g", version: 2, categoryId: category.id });
    expect(result.item.variant).toMatchObject({ stockUnit: "TIN", trackInventory: false, version: 2 });
    expect(result.item.variant.sku).toBeUndefined();
    const audit = catalogAudit(h).at(-1);
    expect(audit).toMatchObject({ action: "product.updated", entityId: item.product.id });
    expect(audit?.payload).toEqual({
      variantId: item.variant.id,
      nameChanged: true,
      descriptionChanged: true,
      categoryChanged: true,
      skuChanged: true,
      barcodeChanged: true,
      stockUnitChanged: true,
      trackInventoryChanged: true,
      fromName: "Peak Milk 400g",
      toName: "Peak Milk 380g",
      toCategoryId: category.id,
      fromSku: "A-1",
      fromBarcode: "SHOP-1",
      toBarcode: "96385074",
      fromStockUnit: "PIECE",
      toStockUnit: "TIN",
      fromTrackInventory: true,
      toTrackInventory: false,
    });
    expect(JSON.stringify(audit?.payload)).not.toContain("Evaporated");
  });

  it("A: current expectedVersion and the state already holds is a no-op: no write, no audit, no version", async () => {
    const { h, mine, item } = await created({ sku: "A-1" });
    const before = snapshot(h);
    const result = await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      name: "Peak Milk 400g",
      sku: "A-1",
      stockUnit: "PIECE",
      trackInventory: true,
    });
    expect(result).toEqual({ item, changed: false });
    expect(result.item.product.version).toBe(1);
    expect(snapshot(h)).toBe(before);
  });

  it("B: a stale expectedVersion is VERSION_CONFLICT even when the state already holds", async () => {
    const { h, mine, item } = await created({ sku: "A-1" });
    await h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, name: "B" });
    const before = snapshot(h);
    const attempt = h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      name: "B",
      sku: "A-1",
    });
    await expect(attempt).rejects.toThrow(VersionConflictError);
    await expect(attempt).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(snapshot(h)).toBe(before);
  });

  it("C: rejects a stale expectedVersion for a real change with VERSION_CONFLICT", async () => {
    const { h, mine, item } = await created();
    await h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, name: "B" });
    const before = snapshot(h);
    const attempt = h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, name: "C" });
    await expect(attempt).rejects.toThrow(VersionConflictError);
    await expect(attempt).rejects.toMatchObject({ code: "VERSION_CONFLICT", retryable: false });
    expect(snapshot(h)).toBe(before);
  });

  it.each(["CASHIER", "ACCOUNTANT"] as const)("denies %s", async (role) => {
    const { h, mine, item } = await created();
    await expect(
      h.updateProduct.execute(mine[role], { productId: item.product.id, expectedVersion: 1, name: "X" }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("returns NOT_FOUND for another business's product and for malformed IDs", async () => {
    const { h, theirs, item } = await created();
    const before = snapshot(h);
    await expect(
      h.updateProduct.execute(theirs.OWNER, { productId: item.product.id, expectedVersion: 1, name: "X" }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      h.updateProduct.execute(theirs.OWNER, { productId: "nope", expectedVersion: 1, name: "X" }),
    ).rejects.toThrow(NotFoundError);
    expect(snapshot(h)).toBe(before);
  });

  it.each([
    ["a bad expectedVersion", { expectedVersion: 0 }],
    ["a fractional expectedVersion", { expectedVersion: 1.5 }],
    ["a blank name", { name: " " }],
    ["a blank description", { description: "  " }],
    ["an unknown unit", { stockUnit: "CRATE" }],
  ])("rejects %s with VALIDATION_FAILED and writes nothing", async (_label, overrides) => {
    const { h, mine, item } = await created();
    const before = snapshot(h);
    await expect(
      h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, ...overrides }),
    ).rejects.toThrow(ValidationError);
    expect(snapshot(h)).toBe(before);
  });

  it("guards stock unit and tracking with the inventory facts", async () => {
    const { h, mine, item } = await created();
    h.catalog.setInventoryState(item.variant.id, { hasMovements: true, hasNonZeroBalance: true });
    await expect(
      h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, stockUnit: "KG" }),
    ).rejects.toThrow(ConflictError);
    await expect(
      h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, trackInventory: false }),
    ).rejects.toThrow(ConflictError);
    h.catalog.setInventoryState(item.variant.id, { hasMovements: true, hasNonZeroBalance: false });
    const untracked = await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      trackInventory: false,
    });
    expect(untracked.item.variant.trackInventory).toBe(false);
  });

  it("rejects a stock-unit change while a low-stock threshold is configured, and allows it once cleared", async () => {
    const { h, mine, item } = await created();
    h.catalog.setInventoryState(item.variant.id, { hasConfiguredThreshold: true });
    const before = snapshot(h);
    const blocked = h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      stockUnit: "KG",
    });
    await expect(blocked).rejects.toThrow(ConflictError);
    await expect(blocked).rejects.toThrow("the stock unit cannot change while a low-stock threshold is configured");
    expect(snapshot(h)).toBe(before);
    const untracked = await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      trackInventory: false,
    });
    expect(untracked.item.variant.trackInventory).toBe(false);
    h.catalog.setInventoryState(item.variant.id, { hasConfiguredThreshold: false });
    const changed = await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 2,
      stockUnit: "KG",
    });
    expect(changed.item.variant.stockUnit).toBe("KG");
  });

  it("rejects a stock-unit change while an active pack exists; once retired, only movements still block it", async () => {
    const { h, mine, item, key } = await created({ stockUnit: "BOTTLE" });
    const { pack } = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Crate of 24",
      factorMinor: "24",
      idempotencyKey: key(),
    });
    await expect(
      h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, stockUnit: "PIECE" }),
    ).rejects.toThrow(ConflictError);
    await h.retirePack.execute(mine.OWNER, { packId: pack.id });
    h.catalog.setInventoryState(item.variant.id, { hasMovements: true, hasNonZeroBalance: false });
    const before = snapshot(h);
    await expect(
      h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, stockUnit: "PIECE" }),
    ).rejects.toThrow(ConflictError);
    expect(snapshot(h)).toBe(before);
    h.catalog.setInventoryState(item.variant.id, { hasMovements: false, hasNonZeroBalance: false });
    const changed = await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      stockUnit: "PIECE",
    });
    expect(changed.item.variant.stockUnit).toBe("PIECE");
    const replacement = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Crate of 24",
      factorMinor: "24",
      idempotencyKey: key(),
    });
    expect(replacement.pack).toMatchObject({ status: "ACTIVE", factorMinor: 24n });
  });

  it("rejects a SKU or active barcode held by another product", async () => {
    const { h, mine, item, input } = await created();
    await h.createProduct.execute(mine.OWNER, input({ sku: "TAKEN", barcode: "4006381333931" }));
    await expect(
      h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, sku: "taken" }),
    ).rejects.toThrow(ConflictError);
    await expect(
      h.updateProduct.execute(mine.OWNER, {
        productId: item.product.id,
        expectedVersion: 1,
        barcode: "04006381333931",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("keeps an archived category already assigned but refuses to newly assign one", async () => {
    const { h, mine, item, key } = await created();
    const a = await h.createCategory.execute(mine.OWNER, { name: "A", idempotencyKey: key() });
    const b = await h.createCategory.execute(mine.OWNER, { name: "B", idempotencyKey: key() });
    await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      categoryId: a.category.id,
    });
    await h.archiveCategory.execute(mine.OWNER, { categoryId: a.category.id, expectedVersion: 1 });
    await h.archiveCategory.execute(mine.OWNER, { categoryId: b.category.id, expectedVersion: 1 });
    const kept = await h.updateProduct.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 2,
      categoryId: a.category.id,
      name: "Renamed",
    });
    expect(kept.item.product.categoryId).toBe(a.category.id);
    await expect(
      h.updateProduct.execute(mine.OWNER, {
        productId: item.product.id,
        expectedVersion: 3,
        categoryId: b.category.id,
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("ArchiveProduct and ReactivateProduct", () => {
  it("archives product and variant together with an optional reason; a repeat is a no-op", async () => {
    const { h, mine, item } = await created();
    const archived = await h.archiveProduct.execute(mine.STOCK_KEEPER, {
      productId: item.product.id,
      expectedVersion: 1,
      reason: "discontinued",
    });
    expect(archived.item.product.status).toBe("ARCHIVED");
    expect(archived.item.variant.status).toBe("ARCHIVED");
    expect(catalogAudit(h).at(-1)).toMatchObject({
      action: "product.archived",
      reason: "discontinued",
      payload: { variantId: item.variant.id },
    });
    const before = snapshot(h);
    const again = await h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 2 });
    expect(again.changed).toBe(false);
    expect(again.item.product.version).toBe(2);
    expect(snapshot(h)).toBe(before);
    expect(h.catalog.products).toHaveLength(1);
  });

  it("archive: a stale expectedVersion conflicts whether or not the product is already archived", async () => {
    const { h, mine, item } = await created();
    await h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, name: "B" });
    let before = snapshot(h);
    await expect(
      h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1 }),
    ).rejects.toThrow(VersionConflictError);
    expect(snapshot(h)).toBe(before);
    await h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 2 });
    before = snapshot(h);
    await expect(
      h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 2 }),
    ).rejects.toThrow(VersionConflictError);
    expect(snapshot(h)).toBe(before);
  });

  it("reactivates with version checking and audits it", async () => {
    const { h, mine, item } = await created();
    await h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1 });
    await expect(
      h.reactivateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1 }),
    ).rejects.toThrow(VersionConflictError);
    const active = await h.reactivateProduct.execute(mine.MANAGER, { productId: item.product.id, expectedVersion: 2 });
    expect(active.item.variant.status).toBe("ACTIVE");
    expect(catalogAudit(h).at(-1)).toMatchObject({ action: "product.reactivated" });
    const before = snapshot(h);
    const again = await h.reactivateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 3 });
    expect(again.changed).toBe(false);
    expect(again.item.product.version).toBe(3);
    expect(snapshot(h)).toBe(before);
    await expect(
      h.reactivateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 2 }),
    ).rejects.toThrow(VersionConflictError);
    expect(snapshot(h)).toBe(before);
  });

  it("refuses reactivation when its barcode is now held by another active product", async () => {
    const { h, mine, item, input } = await created({ barcode: "036000291452" });
    await h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1 });
    await h.createProduct.execute(mine.OWNER, input({ barcode: "00036000291452" }));
    await expect(
      h.reactivateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 2 }),
    ).rejects.toThrow(ConflictError);
  });

  it("denies roles without product:manage and hides other businesses' products", async () => {
    const { h, mine, theirs, item } = await created();
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(
        h.archiveProduct.execute(mine[role], { productId: item.product.id, expectedVersion: 1 }),
      ).rejects.toThrow(PermissionDeniedError);
      await expect(
        h.reactivateProduct.execute(mine[role], { productId: item.product.id, expectedVersion: 1 }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    await expect(
      h.archiveProduct.execute(theirs.OWNER, { productId: item.product.id, expectedVersion: 1 }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      h.reactivateProduct.execute(theirs.OWNER, { productId: item.product.id, expectedVersion: 1 }),
    ).rejects.toThrow(NotFoundError);
    expect(h.catalog.products[0]?.product.status).toBe("ACTIVE");
  });

  it("rejects a blank or over-long archive reason", async () => {
    const { h, mine, item } = await created();
    for (const reason of ["  ", "x".repeat(501)]) {
      await expect(
        h.archiveProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, reason }),
      ).rejects.toThrow(ValidationError);
    }
  });
});
