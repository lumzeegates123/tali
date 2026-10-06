import type { MembershipRole } from "@tali/domain";
import { defineCurrency, INITIAL_UNITS_OF_MEASURE } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../../errors/application-error.js";
import { createCatalogHarness } from "../../testing/catalog-harness.js";
import { parseProductSearch } from "./queries.js";

const CURRENCIES = [defineCurrency("NGN", 2), defineCurrency("KES", 2)];
const ROLES: readonly MembershipRole[] = ["OWNER", "MANAGER", "CASHIER", "STOCK_KEEPER", "ACCOUNTANT"];
const MISSING = "0190a000-0000-7000-8000-00000000dead";

async function setup() {
  const h = createCatalogHarness({ currencies: CURRENCIES });
  const mine = await h.businessWithRoles("Mine", "NGN");
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const key = () => h.tenancy.ids.newId("IdempotencyKey");
  const product = async (
    owner = mine.OWNER,
    overrides: { name?: string; sku?: string; barcode?: string; stockUnit?: string } = {},
  ) =>
    (
      await h.createProduct.execute(owner, {
        name: overrides.name ?? "Peak Milk 400g",
        stockUnit: overrides.stockUnit ?? "PIECE",
        trackInventory: true,
        idempotencyKey: key(),
        ...(overrides.sku === undefined ? {} : { sku: overrides.sku }),
        ...(overrides.barcode === undefined ? {} : { barcode: overrides.barcode }),
      })
    ).item;
  return { h, mine, theirs, key, product };
}

function audit(h: ReturnType<typeof createCatalogHarness>) {
  return h.tenancy.auditWriter.businessRecords.length;
}

describe("catalog reads", () => {
  it("every role reads products, categories, packs, prices and units without auditing", async () => {
    const { h, mine, product } = await setup();
    const item = await product();
    const before = audit(h);
    for (const role of ROLES) {
      const context = mine[role];
      expect((await h.getProduct.execute(context, { productId: item.product.id })).product.id).toBe(item.product.id);
      expect((await h.listProducts.execute(context)).items).toHaveLength(1);
      expect((await h.listCategories.execute(context)).items).toHaveLength(0);
      expect((await h.listProductPacks.execute(context, { productId: item.product.id })).items).toHaveLength(0);
      expect((await h.listProductPriceHistory.execute(context, { productId: item.product.id })).items).toHaveLength(0);
      expect(await h.listUnitsOfMeasure.execute(context)).toHaveLength(INITIAL_UNITS_OF_MEASURE.length);
    }
    expect(audit(h)).toBe(before);
  });

  it("hides other businesses' records and maps malformed IDs to not found", async () => {
    const { h, mine, theirs, product } = await setup();
    const item = await product();
    const { category } = await h.createCategory.execute(mine.OWNER, {
      name: "Dairy",
      idempotencyKey: h.tenancy.ids.newId("IdempotencyKey"),
    });
    for (const productId of [item.product.id, MISSING, "not-a-uuid"]) {
      await expect(h.getProduct.execute(theirs.OWNER, { productId })).rejects.toThrow(NotFoundError);
      await expect(h.listProductPacks.execute(theirs.OWNER, { productId })).rejects.toThrow(NotFoundError);
      await expect(h.listProductPriceHistory.execute(theirs.OWNER, { productId })).rejects.toThrow(NotFoundError);
    }
    for (const categoryId of [category.id, MISSING, "x"]) {
      await expect(h.getCategory.execute(theirs.OWNER, { categoryId })).rejects.toThrow(NotFoundError);
    }
    expect((await h.listProducts.execute(theirs.OWNER)).items).toHaveLength(0);
    expect((await h.listCategories.execute(theirs.OWNER)).items).toHaveLength(0);
  });

  it("lists ACTIVE by default, ARCHIVED on request, and finds archived products by ID", async () => {
    const { h, mine, product } = await setup();
    const kept = await product(mine.OWNER, { name: "Kept" });
    const gone = await product(mine.OWNER, { name: "Gone" });
    await h.archiveProduct.execute(mine.OWNER, { productId: gone.product.id, expectedVersion: 1 });
    expect((await h.listProducts.execute(mine.OWNER)).items.map((i) => i.product.id)).toEqual([kept.product.id]);
    expect((await h.listProducts.execute(mine.OWNER, { status: "ARCHIVED" })).items.map((i) => i.product.id)).toEqual([
      gone.product.id,
    ]);
    expect((await h.getProduct.execute(mine.CASHIER, { productId: gone.product.id })).product.status).toBe("ARCHIVED");
    for (const status of ["ALL", "active", "RETIRED", ""]) {
      await expect(h.listProducts.execute(mine.OWNER, { status })).rejects.toThrow(ValidationError);
      await expect(h.listCategories.execute(mine.OWNER, { status })).rejects.toThrow(ValidationError);
    }
  });

  it("filters categories and packs by status", async () => {
    const { h, mine, key, product } = await setup();
    const a = await h.createCategory.execute(mine.OWNER, { name: "A", idempotencyKey: key() });
    const b = await h.createCategory.execute(mine.OWNER, { name: "B", idempotencyKey: key() });
    await h.archiveCategory.execute(mine.OWNER, { categoryId: b.category.id, expectedVersion: 1 });
    expect((await h.listCategories.execute(mine.OWNER)).items.map((c) => c.id)).toEqual([a.category.id]);
    expect((await h.listCategories.execute(mine.OWNER, { status: "ARCHIVED" })).items.map((c) => c.id)).toEqual([
      b.category.id,
    ]);
    expect((await h.getCategory.execute(mine.CASHIER, { categoryId: b.category.id })).status).toBe("ARCHIVED");

    const item = await product();
    const crate = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Crate",
      factorMinor: "24",
      idempotencyKey: key(),
    });
    const box = await h.addPack.execute(mine.OWNER, {
      productId: item.product.id,
      name: "Box",
      factorMinor: "12",
      idempotencyKey: key(),
    });
    await h.retirePack.execute(mine.OWNER, { packId: box.pack.id });
    const productId = item.product.id;
    expect((await h.listProductPacks.execute(mine.OWNER, { productId })).items.map((p) => p.id)).toEqual([
      crate.pack.id,
    ]);
    expect(
      (await h.listProductPacks.execute(mine.OWNER, { productId, status: "RETIRED" })).items.map((p) => p.id),
    ).toEqual([box.pack.id]);
    for (const status of ["ARCHIVED", "ALL", "retired"]) {
      await expect(h.listProductPacks.execute(mine.OWNER, { productId, status })).rejects.toThrow(ValidationError);
    }
  });

  it("lists the price history oldest first", async () => {
    const { h, mine, product } = await setup();
    const item = await product();
    for (const [version, amountMinor] of [
      [1, "100"],
      [2, "120"],
    ] as const) {
      await h.setSellingPrice.execute(mine.OWNER, {
        productId: item.product.id,
        expectedVersion: version,
        price: { amountMinor, currency: "NGN" },
      });
    }
    const history = await h.listProductPriceHistory.execute(mine.ACCOUNTANT, { productId: item.product.id });
    expect(history.items.map((row) => [row.priceVersion, row.price.toMinorUnitsString()])).toEqual([
      [1, "100"],
      [2, "120"],
    ]);
    expect(history.nextCursor).toBeNull();
  });

  it("pages in ascending ID order with a cursor and rejects bad page input", async () => {
    const { h, mine, product } = await setup();
    const ids: string[] = [];
    for (const name of ["A", "B", "C"]) ids.push((await product(mine.OWNER, { name })).product.id);
    const first = await h.listProducts.execute(mine.OWNER, { limit: 2 });
    expect(first.items.map((i) => i.product.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toBe(ids[1]);
    const second = await h.listProducts.execute(mine.OWNER, { limit: 2, after: first.nextCursor ?? "" });
    expect(second.items.map((i) => i.product.id)).toEqual(ids.slice(2));
    expect(second.nextCursor).toBeNull();
    for (const page of [{ limit: 0 }, { limit: 101 }, { after: "nope" }]) {
      await expect(h.listProducts.execute(mine.OWNER, page)).rejects.toThrow(ValidationError);
    }
  });

  it("searches by name containment, normalized SKU and GTIN-equivalent barcode", async () => {
    const { h, mine, theirs, product } = await setup();
    const milk = await product(mine.OWNER, { name: "Peak Milk 400g", sku: "pk-400" });
    const rice = await product(mine.OWNER, { name: "Rice 50kg", barcode: "036000291452" });
    await product(theirs.OWNER, { name: "Peak Milk 400g", sku: "PK-400" });
    const found = async (q: string) => (await h.listProducts.execute(mine.OWNER, { q })).items.map((i) => i.product.id);
    expect(await found("milk")).toEqual([milk.product.id]);
    expect(await found("  PEAK ")).toEqual([milk.product.id]);
    expect(await found("PK-400")).toEqual([milk.product.id]);
    expect(await found("pk-400")).toEqual([milk.product.id]);
    expect(await found("036000291452")).toEqual([rice.product.id]);
    expect(await found("00036000291452")).toEqual([rice.product.id]);
    expect(await found("ø%_*")).toEqual([]);
    for (const q of ["", "   ", "x".repeat(121)]) {
      await expect(h.listProducts.execute(mine.OWNER, { q })).rejects.toThrow(ValidationError);
    }
  });

  it("derives the search keys only from terms that parse as a SKU or barcode", () => {
    expect(parseProductSearch(" pk-400 ")).toEqual({ nameContains: "pk-400", skuKey: "PK-400", barcodeKey: "pk-400" });
    expect(parseProductSearch("036000291452")).toMatchObject({ barcodeKey: "00036000291452" });
    expect(parseProductSearch("Milk & honey")).toEqual({ nameContains: "Milk & honey" });
    expect(parseProductSearch("50%")).toEqual({ nameContains: "50%" });
  });

  it("lists exactly the approved units ordered by code", async () => {
    const { h, mine } = await setup();
    const units = await h.listUnitsOfMeasure.execute(mine.CASHIER);
    expect(units.map((u) => u.code)).toEqual([...INITIAL_UNITS_OF_MEASURE.map((u) => u.code)].sort());
  });
});
