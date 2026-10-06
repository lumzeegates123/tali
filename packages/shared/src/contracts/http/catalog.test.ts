import { describe, expect, it } from "vitest";
import {
  AddPackRequestSchema,
  ArchiveCategoryRequestSchema,
  ArchiveProductRequestSchema,
  CatalogStatusWireSchema,
  CategoriesResponseSchema,
  CategoryListQuerySchema,
  CategoryPathSchema,
  CategoryResponseSchema,
  CreateCategoryRequestSchema,
  CreateProductRequestSchema,
  PackListQuerySchema,
  PackPathSchema,
  PackResponseSchema,
  PacksResponseSchema,
  PackStatusWireSchema,
  PriceHistoryResponseSchema,
  ProductListQuerySchema,
  ProductPathSchema,
  ProductResponseSchema,
  ProductsResponseSchema,
  ReactivateProductRequestSchema,
  SetSellingPriceRequestSchema,
  UnitKindWireSchema,
  UnitsResponseSchema,
  UpdateCategoryRequestSchema,
  UpdateProductRequestSchema,
} from "./catalog.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const AT = "2026-10-05T08:00:00.000Z";
const money = { amountMinor: "150000", currency: "NGN" };

const product = {
  id: ID,
  variantId: ID,
  name: "Peak Milk 400g",
  description: null,
  categoryId: null,
  status: "ACTIVE",
  version: 1,
  sku: "PK-400",
  barcode: null,
  stockUnit: "PIECE",
  trackInventory: true,
  sellingPrice: money,
  priceVersion: 1,
  createdAt: AT,
  updatedAt: AT,
};
const category = { id: ID, name: "Dairy", status: "ACTIVE", version: 1, createdAt: AT, updatedAt: AT };
const pack = {
  id: ID,
  variantId: ID,
  name: "Crate",
  factorMinor: "24",
  status: "ACTIVE",
  createdAt: AT,
  updatedAt: AT,
};
const price = {
  id: ID,
  variantId: ID,
  price: money,
  priceVersion: 1,
  effectiveAt: AT,
  setByMembershipId: ID,
  reason: null,
};

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(true);
};
const bad = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(false);
};

describe("catalog enums and paths", () => {
  it("enumerates exactly the approved statuses and unit kinds", () => {
    expect(CatalogStatusWireSchema.options).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(PackStatusWireSchema.options).toEqual(["ACTIVE", "RETIRED"]);
    expect(UnitKindWireSchema.options).toEqual(["COUNT", "MASS", "VOLUME"]);
    for (const status of ["ALL", "active", "RETIRED", "DELETED"]) bad(CatalogStatusWireSchema, status);
    for (const status of ["ALL", "ARCHIVED", "retired"]) bad(PackStatusWireSchema, status);
  });

  it("paths only extract ID claims (malformed IDs are NOT_FOUND server-side)", () => {
    expect(ProductPathSchema.parse({ businessId: "x", productId: "not-a-uuid" })).toEqual({
      businessId: "x",
      productId: "not-a-uuid",
    });
    ok(CategoryPathSchema, { businessId: ID, categoryId: ID });
    ok(PackPathSchema, { businessId: ID, packId: ID });
    bad(ProductPathSchema, { businessId: ID, productId: ID, extra: "1" });
    bad(PackPathSchema, { businessId: ID });
  });
});

describe("catalog list queries", () => {
  it("accept a page, a status and a search term, and nothing else", () => {
    expect(ProductListQuerySchema.parse({ limit: "10", after: "c", status: "ARCHIVED", q: "milk" })).toEqual({
      limit: 10,
      after: "c",
      status: "ARCHIVED",
      q: "milk",
    });
    expect(ProductListQuerySchema.parse({})).toEqual({});
    for (const query of [
      { status: "ALL" },
      { status: "RETIRED" },
      { q: "" },
      { q: "x".repeat(481) },
      { q: ["a", "b"] },
      { offset: "10" },
      { search: "milk" },
      { limit: "1.5" },
      { limit: 10 },
    ]) {
      bad(ProductListQuerySchema, query);
    }
    ok(CategoryListQuerySchema, { status: "ARCHIVED", limit: "5" });
    bad(CategoryListQuerySchema, { q: "x" });
    bad(CategoryListQuerySchema, { status: "RETIRED" });
    ok(PackListQuerySchema, { status: "RETIRED" });
    bad(PackListQuerySchema, { status: "ARCHIVED" });
    bad(PackListQuerySchema, { q: "x" });
  });
});

describe("catalog request contracts", () => {
  it("create product takes the editable fields, a unit code and an optional string-money price", () => {
    const minimal = { name: "Rice", stockUnit: "KG", trackInventory: true };
    expect(CreateProductRequestSchema.parse(minimal)).toEqual(minimal);
    ok(CreateProductRequestSchema, {
      ...minimal,
      description: "50 kg bag",
      categoryId: ID,
      sku: "rice-50",
      barcode: "036000291452",
      initialPrice: money,
    });
    for (const body of [
      { ...minimal, initialPrice: { amountMinor: 150000, currency: "NGN" } },
      { ...minimal, initialPrice: { amountMinor: "1500.00", currency: "NGN" } },
      { ...minimal, initialPrice: { ...money, extra: 1 } },
      { ...minimal, stockUnit: "kg" },
      { ...minimal, stockUnit: "K1" },
      { ...minimal, trackInventory: "true" },
      { ...minimal, businessId: ID },
      { ...minimal, variantId: ID },
      { ...minimal, packPrice: money },
      { ...minimal, packBarcode: "1" },
      { ...minimal, costPrice: money },
      { ...minimal, onHand: "10" },
      { ...minimal, description: null },
      { name: "Rice", stockUnit: "KG" },
    ]) {
      bad(CreateProductRequestSchema, body);
    }
  });

  it("update product needs a version and at least one field; null clears optional fields", () => {
    ok(UpdateProductRequestSchema, { expectedVersion: 1, name: "New" });
    ok(UpdateProductRequestSchema, {
      expectedVersion: 2,
      description: null,
      categoryId: null,
      sku: null,
      barcode: null,
    });
    ok(UpdateProductRequestSchema, { expectedVersion: 1, trackInventory: false });
    for (const body of [
      { expectedVersion: 1 },
      { name: "New" },
      { expectedVersion: "1", name: "New" },
      { expectedVersion: 0, name: "New" },
      { expectedVersion: 1.5, name: "New" },
      { expectedVersion: 1, name: null },
      { expectedVersion: 1, stockUnit: null },
      { expectedVersion: 1, status: "ARCHIVED" },
      { expectedVersion: 1, sellingPrice: money },
      { expectedVersion: 1, name: "New", version: 1 },
    ]) {
      bad(UpdateProductRequestSchema, body);
    }
  });

  it("archive, reactivate and price take a numeric version and nothing else", () => {
    ok(ArchiveProductRequestSchema, { expectedVersion: 1 });
    ok(ArchiveProductRequestSchema, { expectedVersion: 1, reason: "discontinued" });
    bad(ArchiveProductRequestSchema, { expectedVersion: 1, reason: "x".repeat(2001) });
    bad(ArchiveProductRequestSchema, {});
    ok(ReactivateProductRequestSchema, { expectedVersion: 2 });
    bad(ReactivateProductRequestSchema, { expectedVersion: 2, reason: "x" });
    ok(SetSellingPriceRequestSchema, { expectedVersion: 1, price: money });
    ok(SetSellingPriceRequestSchema, { expectedVersion: 1, price: money, reason: "supplier" });
    for (const body of [
      { expectedVersion: 1, price: { amountMinor: 150000, currency: "NGN" } },
      { expectedVersion: 1, price: { amountMinor: "-0", currency: "NGN" } },
      { expectedVersion: 1, price: { amountMinor: "1", currency: "ngn" } },
      { expectedVersion: 1, price: "150000" },
      { expectedVersion: 1, price: money, priceVersion: 2 },
      { price: money },
    ]) {
      bad(SetSellingPriceRequestSchema, body);
    }
  });

  it("categories and packs take only their own fields; factors are strings", () => {
    ok(CreateCategoryRequestSchema, { name: "Dairy" });
    bad(CreateCategoryRequestSchema, { name: "Dairy", status: "ACTIVE" });
    ok(UpdateCategoryRequestSchema, { expectedVersion: 1, name: "Milk" });
    bad(UpdateCategoryRequestSchema, { name: "Milk" });
    ok(ArchiveCategoryRequestSchema, { expectedVersion: 1 });
    bad(ArchiveCategoryRequestSchema, { expectedVersion: 1, reason: "x" });
    expect(AddPackRequestSchema.parse({ name: "Crate", factorMinor: "24" })).toEqual({
      name: "Crate",
      factorMinor: "24",
    });
    for (const body of [
      { name: "Crate", factorMinor: 24 },
      { name: "Crate", factorMinor: "024" },
      { name: "Crate", factorMinor: "0" },
      { name: "Crate", factorMinor: "-24" },
      { name: "Crate", factorMinor: "2.5" },
      { name: "Crate", factorMinor: "24", price: money },
      { name: "Crate", factorMinor: "24", barcode: "1" },
      { name: "Crate" },
    ]) {
      bad(AddPackRequestSchema, body);
    }
  });
});

describe("catalog response contracts", () => {
  it("a product is flat, nullable fields are explicit null, money is a string", () => {
    ok(ProductResponseSchema, product);
    ok(ProductResponseSchema, { ...product, description: "d", categoryId: ID, barcode: "x", sellingPrice: null });
    for (const extra of [
      { skuNormalized: "PK-400" },
      { barcodeNormalized: "1" },
      { businessId: ID },
      { createdByMembershipId: ID },
      { stockUnitCode: "PIECE" },
      { currentPriceMinor: "1" },
      { isDefault: true },
      { onHand: "1" },
      { variant: {} },
    ]) {
      bad(ProductResponseSchema, { ...product, ...extra });
    }
    for (const field of ["description", "categoryId", "sku", "barcode", "sellingPrice"] as const) {
      const missing = Object.fromEntries(Object.entries(product).filter(([key]) => key !== field));
      bad(ProductResponseSchema, missing);
    }
    bad(ProductResponseSchema, { ...product, sellingPrice: { amountMinor: 150000, currency: "NGN" } });
    bad(ProductResponseSchema, { ...product, createdAt: "yesterday" });
  });

  it("categories, packs, prices and units carry no storage keys", () => {
    ok(CategoryResponseSchema, category);
    bad(CategoryResponseSchema, { ...category, normalizedName: "dairy" });
    ok(PackResponseSchema, pack);
    bad(PackResponseSchema, { ...pack, factorMinor: 24 });
    bad(PackResponseSchema, { ...pack, version: 1 });
    ok(PriceHistoryResponseSchema, { items: [price, { ...price, reason: "supplier" }], nextCursor: null });
    bad(PriceHistoryResponseSchema, {
      items: [{ ...price, price: { amountMinor: 1, currency: "NGN" } }],
      nextCursor: null,
    });
    bad(PriceHistoryResponseSchema, { items: [{ ...price, amountMinor: "1" }], nextCursor: null });
    ok(UnitsResponseSchema, { items: [{ code: "KG", kind: "MASS", scale: 3 }] });
    bad(UnitsResponseSchema, { items: [{ code: "KG", kind: "MASS", scale: 4 }] });
    bad(UnitsResponseSchema, { items: [{ code: "KG", kind: "WEIGHT", scale: 3 }] });
    bad(UnitsResponseSchema, { items: [], nextCursor: null });
  });

  it("pages are { items, nextCursor } with a nullable string cursor", () => {
    ok(ProductsResponseSchema, { items: [product], nextCursor: "c" });
    ok(CategoriesResponseSchema, { items: [category], nextCursor: null });
    ok(PacksResponseSchema, { items: [pack], nextCursor: null });
    bad(ProductsResponseSchema, { items: [product] });
    bad(ProductsResponseSchema, { items: [product], nextCursor: "" });
    bad(ProductsResponseSchema, { items: [product], nextCursor: null, total: 1 });
  });
});
