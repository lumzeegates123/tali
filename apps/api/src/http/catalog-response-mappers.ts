import type {
  GetCategory,
  GetProduct,
  ListProductPacks,
  ListProductPriceHistory,
  ListUnitsOfMeasure,
  Page,
} from "@tali/application";
import {
  type CategoriesResponse,
  CategoriesResponseSchema,
  type CategoryResponse,
  CategoryResponseSchema,
  type MoneyWire,
  type PackResponse,
  PackResponseSchema,
  type PacksResponse,
  PacksResponseSchema,
  type PriceHistoryEntryResponse,
  type PriceHistoryResponse,
  PriceHistoryResponseSchema,
  type ProductResponse,
  ProductResponseSchema,
  type ProductsResponse,
  ProductsResponseSchema,
  type UnitsResponse,
  UnitsResponseSchema,
} from "@tali/shared";

/**
 * Catalog results to wire DTOs (ADR-008, plan 004 Slice 3). Each mapper names
 * the fields it exposes, writes every bigint as a canonical base-10 string and
 * every absent optional field as an explicit null, and parses the result with
 * the strict shared response schema. Normalized lookup keys, the business ID,
 * the creating membership, the default-variant flag and storage names never
 * reach the wire.
 */
type CatalogItem = Awaited<ReturnType<GetProduct["execute"]>>;
type Category = Awaited<ReturnType<GetCategory["execute"]>>;
type Pack = Awaited<ReturnType<ListProductPacks["execute"]>>["items"][number];
type PriceEntry = Awaited<ReturnType<ListProductPriceHistory["execute"]>>["items"][number];
type Unit = Awaited<ReturnType<ListUnitsOfMeasure["execute"]>>[number];
type Money = NonNullable<CatalogItem["variant"]["sellingPrice"]>;

function money(value: Money): MoneyWire {
  return { amountMinor: value.toMinorUnitsString(), currency: value.currency };
}

function product({ product: p, variant: v }: CatalogItem): ProductResponse {
  return {
    id: p.id,
    variantId: v.id,
    name: p.name,
    description: p.description ?? null,
    categoryId: p.categoryId ?? null,
    status: p.status,
    version: p.version,
    sku: v.sku?.value ?? null,
    barcode: v.barcode?.value ?? null,
    stockUnit: v.stockUnit,
    trackInventory: v.trackInventory,
    sellingPrice: v.sellingPrice === undefined ? null : money(v.sellingPrice),
    priceVersion: v.priceVersion,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function category(value: Category): CategoryResponse {
  return {
    id: value.id,
    name: value.name,
    status: value.status,
    version: value.version,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function pack(value: Pack): PackResponse {
  return {
    id: value.id,
    variantId: value.variantId,
    name: value.name,
    factorMinor: value.factorMinor.toString(10),
    status: value.status,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function priceEntry(value: PriceEntry): PriceHistoryEntryResponse {
  return {
    id: value.id,
    variantId: value.variantId,
    price: money(value.price),
    priceVersion: value.priceVersion,
    effectiveAt: value.effectiveAt.toISOString(),
    setByMembershipId: value.setByMembershipId,
    reason: value.reason ?? null,
  };
}

export function toProductResponse(item: CatalogItem): ProductResponse {
  return ProductResponseSchema.parse(product(item));
}

export function toProductsResponse(page: Page<CatalogItem>): ProductsResponse {
  return ProductsResponseSchema.parse({ items: page.items.map(product), nextCursor: page.nextCursor });
}

export function toCategoryResponse(value: Category): CategoryResponse {
  return CategoryResponseSchema.parse(category(value));
}

export function toCategoriesResponse(page: Page<Category>): CategoriesResponse {
  return CategoriesResponseSchema.parse({ items: page.items.map(category), nextCursor: page.nextCursor });
}

export function toPackResponse(value: Pack): PackResponse {
  return PackResponseSchema.parse(pack(value));
}

export function toPacksResponse(page: Page<Pack>): PacksResponse {
  return PacksResponseSchema.parse({ items: page.items.map(pack), nextCursor: page.nextCursor });
}

export function toPriceHistoryResponse(page: Page<PriceEntry>): PriceHistoryResponse {
  return PriceHistoryResponseSchema.parse({ items: page.items.map(priceEntry), nextCursor: page.nextCursor });
}

export function toUnitsResponse(units: readonly Unit[]): UnitsResponse {
  return UnitsResponseSchema.parse({
    items: units.map((unit) => ({ code: unit.code, kind: unit.kind, scale: unit.scale })),
  });
}
