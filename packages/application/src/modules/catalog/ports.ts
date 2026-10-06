import type {
  BarcodeKey,
  BusinessId,
  CatalogProduct,
  CatalogStatus,
  CategoryNameKey,
  PackName,
  PackStatus,
  ProductCategory,
  ProductCategoryId,
  ProductId,
  ProductPack,
  ProductPackId,
  ProductVariantId,
  ProductVariantPrice,
  SkuKey,
  UnitCode,
  UnitDefinition,
  VariantInventoryState,
} from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { Page, PageRequest } from "../../queries/pagination.js";

/**
 * A product search within one business. A product matches when its name
 * contains `nameContains` case-insensitively (taken literally: no wildcards),
 * or its default variant's normalized SKU or barcode equals the given key.
 */
export interface ProductSearch {
  readonly nameContains: string;
  readonly skuKey?: SkuKey;
  readonly barcodeKey?: BarcodeKey;
}

export interface ProductListQuery {
  readonly status: CatalogStatus;
  readonly search?: ProductSearch;
}

/**
 * Products with their default variant (tenant-owned; ADR-008 section 3).
 * Every method takes the business; a record of another business is simply
 * not found. Adapters enforce the uniqueness rules below as constraints and
 * report a violation as ConflictError, so a lost race never writes a duplicate.
 */
export interface ProductRepository {
  /** Inserts the product and its default variant together. */
  insert(scope: TransactionScope, item: CatalogProduct): Promise<void>;
  /** The product of this business and its default variant, both rows locked until the transaction ends. */
  findByIdForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    productId: ProductId,
  ): Promise<CatalogProduct | undefined>;
  /** The product of this business and its default variant, in any status, without locking. */
  findById(scope: TransactionScope, businessId: BusinessId, productId: ProductId): Promise<CatalogProduct | undefined>;
  /** This business's products in the given status, optionally searched, in ascending ID order. */
  list(
    scope: TransactionScope,
    businessId: BusinessId,
    query: ProductListQuery,
    page: PageRequest,
  ): Promise<Page<CatalogProduct>>;
  /**
   * Persists a change of `previous` to `next` (same IDs and business).
   * Throws ConcurrentModificationError when the stored product version is no
   * longer `previous.product.version`.
   */
  update(scope: TransactionScope, previous: CatalogProduct, next: CatalogProduct): Promise<void>;
  /** The variant of this business holding the normalized SKU, in any status (SKUs are never reused). */
  findVariantIdBySku(
    scope: TransactionScope,
    businessId: BusinessId,
    sku: SkuKey,
  ): Promise<ProductVariantId | undefined>;
  /** The ACTIVE variant of this business holding the normalized barcode. */
  findActiveVariantIdByBarcode(
    scope: TransactionScope,
    businessId: BusinessId,
    barcode: BarcodeKey,
  ): Promise<ProductVariantId | undefined>;
}

/**
 * The append-only selling-price history (ADR-008 sections 3.5 and 14). There
 * is no update or delete. Adapters enforce one row per
 * (business, variant, priceVersion).
 */
export interface ProductPriceHistoryRepository {
  append(scope: TransactionScope, entry: ProductVariantPrice): Promise<void>;
  /** The variant's price history in ascending ID order (UUIDv7 IDs follow creation order). */
  listForVariant(
    scope: TransactionScope,
    businessId: BusinessId,
    variantId: ProductVariantId,
    page: PageRequest,
  ): Promise<Page<ProductVariantPrice>>;
}

/** Flat product categories (tenant-owned; ADR-008 section 3.3). */
export interface ProductCategoryRepository {
  insert(scope: TransactionScope, category: ProductCategory): Promise<void>;
  /**
   * The category of this business, locked against concurrent change until the
   * transaction ends (a shared lock is enough when only assigning it).
   */
  findByIdForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    categoryId: ProductCategoryId,
  ): Promise<ProductCategory | undefined>;
  /** The category of this business, in any status, without locking. */
  findById(
    scope: TransactionScope,
    businessId: BusinessId,
    categoryId: ProductCategoryId,
  ): Promise<ProductCategory | undefined>;
  /** This business's categories in the given status, in ascending ID order. */
  list(
    scope: TransactionScope,
    businessId: BusinessId,
    status: CatalogStatus,
    page: PageRequest,
  ): Promise<Page<ProductCategory>>;
  /** Throws ConcurrentModificationError when the stored version is no longer `previous.version`. */
  update(scope: TransactionScope, previous: ProductCategory, next: ProductCategory): Promise<void>;
  /** The ACTIVE category of this business with this case-insensitive name key. */
  findActiveIdByName(
    scope: TransactionScope,
    businessId: BusinessId,
    name: CategoryNameKey,
  ): Promise<ProductCategoryId | undefined>;
}

/** Pack conversions (tenant-owned; ADR-008 section 3.4). Immutable except for retirement. */
export interface ProductPackRepository {
  insert(scope: TransactionScope, pack: ProductPack): Promise<void>;
  findByIdForUpdate(
    scope: TransactionScope,
    businessId: BusinessId,
    packId: ProductPackId,
  ): Promise<ProductPack | undefined>;
  /** Persists ACTIVE to RETIRED. Throws ConcurrentModificationError when the stored pack is no longer ACTIVE. */
  update(scope: TransactionScope, previous: ProductPack, next: ProductPack): Promise<void>;
  /** The variant's packs in the given status, in ascending ID order. */
  listForVariant(
    scope: TransactionScope,
    businessId: BusinessId,
    variantId: ProductVariantId,
    status: PackStatus,
    page: PageRequest,
  ): Promise<Page<ProductPack>>;
  /** True when the variant has at least one ACTIVE pack. */
  hasActivePacks(scope: TransactionScope, businessId: BusinessId, variantId: ProductVariantId): Promise<boolean>;
  /** The ACTIVE pack of this variant with exactly this normalized name. */
  findActiveIdByName(
    scope: TransactionScope,
    businessId: BusinessId,
    variantId: ProductVariantId,
    name: PackName,
  ): Promise<ProductPackId | undefined>;
}

/** The approved unit reference data (global, read-only; ADR-008 section 4.2). */
export interface UnitReferenceRepository {
  findByCode(scope: TransactionScope, code: UnitCode): Promise<UnitDefinition | undefined>;
  /** Every approved unit, ordered by code. The set is small and fixed, so it is not paginated. */
  listAll(scope: TransactionScope): Promise<readonly UnitDefinition[]>;
}

/**
 * The inventory facts catalog edits are guarded by (ADR-008 section 3.2). The
 * inventory module implements this once movements and balances exist; the
 * catalog never reads inventory tables itself.
 */
export interface VariantInventoryStateReader {
  stateOf(scope: TransactionScope, businessId: BusinessId, variantId: ProductVariantId): Promise<VariantInventoryState>;
}

function sameInstant(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/** Precondition of ProductRepository.update, shared by every adapter. */
export function assertCatalogProductTransition(previous: CatalogProduct, next: CatalogProduct): void {
  const p = previous.product;
  const n = next.product;
  const pv = previous.variant;
  const nv = next.variant;
  if (
    n.id !== p.id ||
    n.businessId !== p.businessId ||
    n.createdByMembershipId !== p.createdByMembershipId ||
    !sameInstant(n.createdAt, p.createdAt) ||
    n.version !== p.version + 1 ||
    nv.id !== pv.id ||
    nv.businessId !== pv.businessId ||
    nv.productId !== pv.productId ||
    nv.isDefault !== pv.isDefault ||
    !sameInstant(nv.createdAt, pv.createdAt) ||
    nv.status !== n.status ||
    (nv.version !== pv.version && nv.version !== pv.version + 1) ||
    nv.priceVersion < pv.priceVersion ||
    nv.priceVersion > pv.priceVersion + 1
  ) {
    throw new Error("a product update must keep its identity and advance its version by one");
  }
}

/** Precondition of ProductCategoryRepository.update, shared by every adapter. */
export function assertCategoryTransition(previous: ProductCategory, next: ProductCategory): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    !sameInstant(next.createdAt, previous.createdAt) ||
    next.version !== previous.version + 1 ||
    (previous.status === "ARCHIVED" && next.status === "ACTIVE")
  ) {
    throw new Error("a category update must keep its identity and advance its version by one");
  }
}

/** Precondition of ProductPackRepository.update, shared by every adapter. */
export function assertPackTransition(previous: ProductPack, next: ProductPack): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    next.variantId !== previous.variantId ||
    next.name !== previous.name ||
    next.factorMinor !== previous.factorMinor ||
    !sameInstant(next.createdAt, previous.createdAt) ||
    previous.status !== "ACTIVE" ||
    next.status !== "RETIRED"
  ) {
    throw new Error("a pack update must keep its identity and go from ACTIVE to RETIRED");
  }
}
