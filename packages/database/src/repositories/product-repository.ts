import type { ProductRepository, ProductSearch } from "@tali/application";
import { assertCatalogProductTransition, ConcurrentModificationError } from "@tali/application";
import type { CatalogProduct, ProductVariant } from "@tali/domain";
import {
  Money,
  parseBusinessId,
  parseCurrencyCode,
  parseMembershipId,
  parseProductCategoryId,
  parseProductId,
  parseProductVariantId,
  restoreCatalogProduct,
} from "@tali/domain";
import type { Product as ProductRow, ProductVariant as ProductVariantRow } from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { keysetArgs, toPage } from "./pagination.js";

/**
 * Unique constraints a concurrent request can win (ADR-008 section 5); the
 * messages match the use cases' own pre-checks.
 */
export const PRODUCT_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  product_variants_business_id_sku_normalized_key: "This SKU is already used by another product",
  product_variants_active_barcode_unique: "This barcode is already used by another active product",
});

function pair(value: string | null, normalized: string | null, field: string) {
  if ((value === null) !== (normalized === null)) {
    throw new Error(`stored ${field} and its normalized form must be present together`);
  }
  return value === null || normalized === null ? undefined : { value, normalized };
}

function toVariantProps(row: ProductVariantRow) {
  if ((row.currentPriceMinor === null) !== (row.currentPriceCurrency === null)) {
    throw new Error("stored selling price and its currency must be present together");
  }
  const sku = pair(row.sku, row.skuNormalized, "sku");
  const barcode = pair(row.barcode, row.barcodeNormalized, "barcode");
  return {
    id: parseProductVariantId(row.id),
    businessId: parseBusinessId(row.businessId),
    productId: parseProductId(row.productId),
    isDefault: row.isDefault,
    status: row.status,
    ...(sku === undefined ? {} : { sku }),
    ...(barcode === undefined ? {} : { barcode }),
    stockUnit: row.stockUnitCode,
    trackInventory: row.trackInventory,
    ...(row.currentPriceMinor === null || row.currentPriceCurrency === null
      ? {}
      : { sellingPrice: Money.ofMinor(row.currentPriceMinor, parseCurrencyCode(row.currentPriceCurrency)) }),
    priceVersion: row.priceVersion,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A product row with all of its variant rows. Build 2 has exactly one,
 * default, variant per product (ADR-008 section 3.2); anything else is a
 * broken invariant and fails loudly rather than picking a variant.
 */
export function toCatalogProduct(row: ProductRow, variants: readonly ProductVariantRow[]): CatalogProduct {
  const [variant, ...others] = variants;
  if (variant === undefined || others.length > 0 || !variant.isDefault) {
    throw new Error(`product must have exactly one default variant (found ${variants.length} variant rows)`);
  }
  return restoreCatalogProduct({
    product: {
      id: parseProductId(row.id),
      businessId: parseBusinessId(row.businessId),
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.categoryId === null ? {} : { categoryId: parseProductCategoryId(row.categoryId) }),
      status: row.status,
      version: row.version,
      createdByMembershipId: parseMembershipId(row.createdByMembershipId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    variant: toVariantProps(variant),
  });
}

function productData(item: CatalogProduct) {
  const { product } = item;
  return {
    name: product.name,
    description: product.description ?? null,
    categoryId: product.categoryId ?? null,
    status: product.status,
    version: product.version,
    updatedAt: product.updatedAt,
  };
}

function variantData(variant: ProductVariant) {
  return {
    status: variant.status,
    sku: variant.sku?.value ?? null,
    skuNormalized: variant.sku?.normalized ?? null,
    barcode: variant.barcode?.value ?? null,
    barcodeNormalized: variant.barcode?.normalized ?? null,
    stockUnitCode: variant.stockUnit,
    trackInventory: variant.trackInventory,
    currentPriceMinor: variant.sellingPrice?.amountMinor ?? null,
    currentPriceCurrency: variant.sellingPrice?.currency ?? null,
    priceVersion: variant.priceVersion,
    version: variant.version,
    updatedAt: variant.updatedAt,
  };
}

/** Variant state is written only with a version bump; an unversioned change is a programming error. */
function sameVariantState(a: ProductVariant, b: ProductVariant): boolean {
  const left = variantData(a);
  const right = variantData(b);
  return (Object.keys(left) as (keyof typeof left)[]).every((key) => {
    const l = left[key];
    const r = right[key];
    return l instanceof Date && r instanceof Date ? l.getTime() === r.getTime() : l === r;
  });
}

/** LIKE treats `%`, `_` and the escape character as syntax; a search term is matched literally. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function searchFilter(businessId: string, search: ProductSearch) {
  return {
    OR: [
      { name: { contains: escapeLikePattern(search.nameContains), mode: "insensitive" as const } },
      ...(search.skuKey === undefined ? [] : [{ variants: { some: { businessId, skuNormalized: search.skuKey } } }]),
      ...(search.barcodeKey === undefined
        ? []
        : [{ variants: { some: { businessId, barcodeNormalized: search.barcodeKey } } }]),
    ],
  };
}

/**
 * Products with their default variant (tenant-owned; ADR-008 sections 3.1,
 * 3.2 and 5). Every lookup is by (business_id, ...): a record of another
 * business is not found. SKU and active-barcode uniqueness are database
 * constraints; a lost race surfaces as ConflictError.
 */
export function createProductRepository(): ProductRepository {
  return {
    async insert(scope, item) {
      const client = transactionClient(scope);
      const { product, variant } = item;
      await translatingUniqueViolations(PRODUCT_CONFLICTS, async () => {
        await client.product.create({
          data: {
            businessId: product.businessId,
            id: product.id,
            ...productData(item),
            createdByMembershipId: product.createdByMembershipId,
            createdAt: product.createdAt,
          },
        });
        await client.productVariant.create({
          data: {
            businessId: variant.businessId,
            id: variant.id,
            productId: variant.productId,
            isDefault: variant.isDefault,
            ...variantData(variant),
            createdAt: variant.createdAt,
          },
        });
      });
    },

    async findByIdForUpdate(scope, businessId, productId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM products WHERE business_id = ${businessId}::uuid AND id = ${productId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM product_variants
        WHERE business_id = ${businessId}::uuid AND product_id = ${productId}::uuid
        ORDER BY id FOR UPDATE`;
      const row = await client.product.findUnique({
        where: { businessId_id: { businessId, id: productId } },
        include: { variants: { orderBy: { id: "asc" } } },
      });
      return row === null ? undefined : toCatalogProduct(row, row.variants);
    },

    async findById(scope, businessId, productId) {
      const row = await transactionClient(scope).product.findUnique({
        where: { businessId_id: { businessId, id: productId } },
        include: { variants: { orderBy: { id: "asc" } } },
      });
      return row === null ? undefined : toCatalogProduct(row, row.variants);
    },

    async list(scope, businessId, query, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).product.findMany({
        where: {
          businessId,
          status: query.status,
          ...page.where,
          ...(query.search === undefined ? {} : searchFilter(businessId, query.search)),
        },
        include: { variants: { orderBy: { id: "asc" } } },
        orderBy: page.orderBy,
        take: page.take,
      });
      return toPage(
        rows,
        request,
        (row) => row.id,
        (row) => toCatalogProduct(row, row.variants),
      );
    },

    async update(scope, previous, next) {
      assertCatalogProductTransition(previous, next);
      const variantChanged = next.variant.version !== previous.variant.version;
      if (!variantChanged && !sameVariantState(previous.variant, next.variant)) {
        throw new Error("a variant change must advance the variant version");
      }
      const client = transactionClient(scope);
      await translatingUniqueViolations(PRODUCT_CONFLICTS, async () => {
        const { count } = await client.product.updateMany({
          where: {
            businessId: previous.product.businessId,
            id: previous.product.id,
            version: previous.product.version,
          },
          data: productData(next),
        });
        if (count !== 1) throw new ConcurrentModificationError();
        if (!variantChanged) return;
        const variant = await client.productVariant.updateMany({
          where: {
            businessId: previous.variant.businessId,
            id: previous.variant.id,
            version: previous.variant.version,
          },
          data: variantData(next.variant),
        });
        if (variant.count !== 1) throw new ConcurrentModificationError();
      });
    },

    async findVariantIdBySku(scope, businessId, sku) {
      const row = await transactionClient(scope).productVariant.findUnique({
        where: { businessId_skuNormalized: { businessId, skuNormalized: sku } },
        select: { id: true },
      });
      return row === null ? undefined : parseProductVariantId(row.id);
    },

    async findActiveVariantIdByBarcode(scope, businessId, barcode) {
      const row = await transactionClient(scope).productVariant.findFirst({
        where: { businessId, status: "ACTIVE", barcodeNormalized: barcode },
        select: { id: true },
      });
      return row === null ? undefined : parseProductVariantId(row.id);
    },
  };
}
