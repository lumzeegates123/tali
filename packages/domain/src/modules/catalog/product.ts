import { DomainError } from "../../errors.js";
import type { CurrencyCode, UnitCode } from "../../kernel/index.js";
import { Money, parseUnitCode } from "../../kernel/index.js";
import { codePointLength, isWellFormedText, normalizeBoundedName } from "../../text.js";
import type { BusinessId, MembershipId } from "../business/index.js";
import type { CatalogStatus } from "./common.js";
import { requireExpectedVersion, validCatalogStatus, validInstant, validVersion } from "./common.js";
import type { ProductCategoryId, ProductId, ProductVariantId, ProductVariantPriceId } from "./ids.js";
import type { Barcode, Sku } from "./identifiers.js";
import { restoreBarcode, restoreSku } from "./identifiers.js";

declare const productNameBrand: unique symbol;
declare const productDescriptionBrand: unique symbol;
declare const catalogChangeReasonBrand: unique symbol;

/** 1 to 120 characters after trimming and NFC normalization. Names are not unique (ADR-008 section 3.1). */
export type ProductName = string & { readonly [productNameBrand]: true };

/** Plain text, 1 to 500 characters, stored as given; never interpreted as markup. */
export type ProductDescription = string & { readonly [productDescriptionBrand]: true };

/** Optional free-text reason for a price change or an archive, 1 to 500 characters, not blank. */
export type CatalogChangeReason = string & { readonly [catalogChangeReasonBrand]: true };

export const PRODUCT_NAME_MAX_LENGTH = 120;
export const PRODUCT_DESCRIPTION_MAX_LENGTH = 500;
export const CATALOG_CHANGE_REASON_MAX_LENGTH = 500;

/** The PostgreSQL BIGINT ceiling that `selling_price_minor` will be stored in. */
export const MAX_SELLING_PRICE_MINOR = 9_223_372_036_854_775_807n;

export function parseProductName(value: string): ProductName {
  return normalizeBoundedName(value, "name", PRODUCT_NAME_MAX_LENGTH) as ProductName;
}

function boundedText(value: string, field: string, max: number): string {
  if (typeof value !== "string" || !isWellFormedText(value)) {
    throw new DomainError("INVALID_VALUE", `${field} is not well-formed text`, field);
  }
  if (value.trim().length === 0 || codePointLength(value) > max) {
    throw new DomainError("INVALID_VALUE", `${field} must be 1 to ${max} characters and not blank`, field);
  }
  return value;
}

export function parseProductDescription(value: string): ProductDescription {
  return boundedText(value, "description", PRODUCT_DESCRIPTION_MAX_LENGTH) as ProductDescription;
}

export function parseCatalogChangeReason(value: string): CatalogChangeReason {
  return boundedText(value, "reason", CATALOG_CHANGE_REASON_MAX_LENGTH) as CatalogChangeReason;
}

/** What a merchant sees and names. Owns no stock; its default variant does (ADR-008 section 3.1). */
export interface Product {
  readonly id: ProductId;
  readonly businessId: BusinessId;
  readonly name: ProductName;
  readonly description?: ProductDescription;
  readonly categoryId?: ProductCategoryId;
  readonly status: CatalogStatus;
  /** The aggregate's optimistic-concurrency token: any change to the product, its variant or its price bumps it. */
  readonly version: number;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The stock-keeping record. In Build 2 every product has exactly one, hidden,
 * default variant (ADR-008 section 3.2) and its status always equals the
 * product's.
 */
export interface ProductVariant {
  readonly id: ProductVariantId;
  readonly businessId: BusinessId;
  readonly productId: ProductId;
  readonly isDefault: boolean;
  readonly status: CatalogStatus;
  readonly sku?: Sku;
  readonly barcode?: Barcode;
  readonly stockUnit: UnitCode;
  readonly trackInventory: boolean;
  /** Business-wide selling price per one stock unit; absent until first set. */
  readonly sellingPrice?: Money;
  /** 0 until the first price; then the priceVersion of the newest history row. */
  readonly priceVersion: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The unit of consistency and of expectedVersion: a product with its default variant. */
export interface CatalogProduct {
  readonly product: Product;
  readonly variant: ProductVariant;
}

/**
 * One append-only selling-price history row (ADR-008 section 3.5). The
 * priceVersion is a gap-free, per-variant sequence starting at 1, so storage
 * can enforce one row per (business, variant, priceVersion).
 */
export interface ProductVariantPrice {
  readonly id: ProductVariantPriceId;
  readonly businessId: BusinessId;
  readonly variantId: ProductVariantId;
  readonly price: Money;
  readonly priceVersion: number;
  readonly effectiveAt: Date;
  readonly setByMembershipId: MembershipId;
  readonly reason?: CatalogChangeReason;
}

/**
 * The inventory facts the catalog guards depend on (ADR-008 section 3.2),
 * supplied by the inventory module from its authoritative store, across all
 * locations of the business.
 */
export interface VariantInventoryState {
  /** True when any inventory movement exists for the variant at any location. */
  readonly hasMovements: boolean;
  /** True when the variant's balance is non-zero at any location. */
  readonly hasNonZeroBalance: boolean;
  /** True when a low-stock threshold is configured (not cleared) for the variant at any location. */
  readonly hasConfiguredThreshold: boolean;
}

function validSellingPrice(price: Money, businessCurrency: CurrencyCode): Money {
  if (!(price instanceof Money)) {
    throw new DomainError("INVALID_VALUE", "price must be Money", "price");
  }
  if (price.currency !== businessCurrency) {
    throw new DomainError("INVALID_VALUE", "price currency must be the business currency", "currency");
  }
  if (!price.isPositive() || price.amountMinor > MAX_SELLING_PRICE_MINOR) {
    throw new DomainError("INVALID_VALUE", "price must be greater than zero and within range", "amountMinor");
  }
  return price;
}

function priceEntry(props: {
  readonly id: ProductVariantPriceId;
  readonly variant: ProductVariant;
  readonly price: Money;
  readonly priceVersion: number;
  readonly now: Date;
  readonly setByMembershipId: MembershipId;
  readonly reason: CatalogChangeReason | undefined;
}): ProductVariantPrice {
  return Object.freeze({
    id: props.id,
    businessId: props.variant.businessId,
    variantId: props.variant.id,
    price: props.price,
    priceVersion: props.priceVersion,
    effectiveAt: new Date(props.now.getTime()),
    setByMembershipId: props.setByMembershipId,
    ...(props.reason === undefined ? {} : { reason: props.reason }),
  });
}

export interface InitialSellingPrice {
  readonly id: ProductVariantPriceId;
  readonly price: Money;
  readonly businessCurrency: CurrencyCode;
}

/**
 * Creates a product together with its default variant: there is no way to
 * build one without the other. An optional initial price produces the first
 * history row (priceVersion 1).
 */
export function createProduct(props: {
  readonly id: ProductId;
  readonly variantId: ProductVariantId;
  readonly businessId: BusinessId;
  readonly name: ProductName;
  readonly description?: ProductDescription;
  readonly categoryId?: ProductCategoryId;
  readonly sku?: Sku;
  readonly barcode?: Barcode;
  readonly stockUnit: UnitCode;
  readonly trackInventory: boolean;
  readonly initialPrice?: InitialSellingPrice;
  readonly createdByMembershipId: MembershipId;
  readonly now: Date;
}): { readonly item: CatalogProduct; readonly priceEntry?: ProductVariantPrice } {
  const now = validInstant(props.now, "now");
  if (typeof props.trackInventory !== "boolean") {
    throw new DomainError("INVALID_VALUE", "trackInventory must be a boolean", "trackInventory");
  }
  const stockUnit = parseUnitCode(props.stockUnit);
  const initial =
    props.initialPrice === undefined
      ? undefined
      : {
          ...props.initialPrice,
          price: validSellingPrice(props.initialPrice.price, props.initialPrice.businessCurrency),
        };
  const product: Product = Object.freeze({
    id: props.id,
    businessId: props.businessId,
    name: props.name,
    ...(props.description === undefined ? {} : { description: props.description }),
    ...(props.categoryId === undefined ? {} : { categoryId: props.categoryId }),
    status: "ACTIVE",
    version: 1,
    createdByMembershipId: props.createdByMembershipId,
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
  const variant: ProductVariant = Object.freeze({
    id: props.variantId,
    businessId: props.businessId,
    productId: props.id,
    isDefault: true,
    status: "ACTIVE",
    ...(props.sku === undefined ? {} : { sku: props.sku }),
    ...(props.barcode === undefined ? {} : { barcode: props.barcode }),
    stockUnit,
    trackInventory: props.trackInventory,
    ...(initial === undefined ? {} : { sellingPrice: initial.price }),
    priceVersion: initial === undefined ? 0 : 1,
    version: 1,
    createdAt: new Date(now.getTime()),
    updatedAt: new Date(now.getTime()),
  });
  const item: CatalogProduct = Object.freeze({ product, variant });
  if (initial === undefined) return { item };
  return {
    item,
    priceEntry: priceEntry({
      id: initial.id,
      variant,
      price: initial.price,
      priceVersion: 1,
      now,
      setByMembershipId: props.createdByMembershipId,
      reason: undefined,
    }),
  };
}

/** Validates a product and its default variant read from storage, including the pairing invariants. */
export function restoreCatalogProduct(props: {
  readonly product: {
    readonly id: ProductId;
    readonly businessId: BusinessId;
    readonly name: string;
    readonly description?: string;
    readonly categoryId?: ProductCategoryId;
    readonly status: string;
    readonly version: number;
    readonly createdByMembershipId: MembershipId;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly variant: {
    readonly id: ProductVariantId;
    readonly businessId: BusinessId;
    readonly productId: ProductId;
    readonly isDefault: boolean;
    readonly status: string;
    readonly sku?: { readonly value: string; readonly normalized: string };
    readonly barcode?: { readonly value: string; readonly normalized: string };
    readonly stockUnit: string;
    readonly trackInventory: boolean;
    readonly sellingPrice?: Money;
    readonly priceVersion: number;
    readonly version: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
}): CatalogProduct {
  const p = props.product;
  const v = props.variant;
  if (v.businessId !== p.businessId || v.productId !== p.id || !v.isDefault) {
    throw new DomainError("INVALID_VALUE", "variant is not this product's default variant", "variant");
  }
  const status = validCatalogStatus(p.status);
  if (validCatalogStatus(v.status) !== status) {
    throw new DomainError("INVALID_VALUE", "default variant status must equal product status", "status");
  }
  if (!Number.isSafeInteger(v.priceVersion) || v.priceVersion < 0) {
    throw new DomainError("INVALID_VALUE", "priceVersion must be a non-negative integer", "priceVersion");
  }
  if ((v.sellingPrice === undefined) !== (v.priceVersion === 0)) {
    throw new DomainError("INVALID_VALUE", "a priced variant has priceVersion >= 1, an unpriced one 0", "priceVersion");
  }
  if (v.sellingPrice !== undefined) {
    validSellingPrice(v.sellingPrice, v.sellingPrice.currency);
  }
  if (typeof v.trackInventory !== "boolean") {
    throw new DomainError("INVALID_VALUE", "trackInventory must be a boolean", "trackInventory");
  }
  const product: Product = Object.freeze({
    id: p.id,
    businessId: p.businessId,
    name: parseProductName(p.name),
    ...(p.description === undefined ? {} : { description: parseProductDescription(p.description) }),
    ...(p.categoryId === undefined ? {} : { categoryId: p.categoryId }),
    status,
    version: validVersion(p.version),
    createdByMembershipId: p.createdByMembershipId,
    createdAt: validInstant(p.createdAt, "createdAt"),
    updatedAt: validInstant(p.updatedAt, "updatedAt"),
  });
  const variant: ProductVariant = Object.freeze({
    id: v.id,
    businessId: v.businessId,
    productId: v.productId,
    isDefault: true,
    status,
    ...(v.sku === undefined ? {} : { sku: restoreSku(v.sku.value, v.sku.normalized) }),
    ...(v.barcode === undefined ? {} : { barcode: restoreBarcode(v.barcode.value, v.barcode.normalized) }),
    stockUnit: parseUnitCode(v.stockUnit),
    trackInventory: v.trackInventory,
    ...(v.sellingPrice === undefined ? {} : { sellingPrice: v.sellingPrice }),
    priceVersion: v.priceVersion,
    version: validVersion(v.version),
    createdAt: validInstant(v.createdAt, "createdAt"),
    updatedAt: validInstant(v.updatedAt, "updatedAt"),
  });
  return Object.freeze({ product, variant });
}

export function restoreProductVariantPrice(props: {
  readonly id: ProductVariantPriceId;
  readonly businessId: BusinessId;
  readonly variantId: ProductVariantId;
  readonly price: Money;
  readonly priceVersion: number;
  readonly effectiveAt: Date;
  readonly setByMembershipId: MembershipId;
  readonly reason?: string;
}): ProductVariantPrice {
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    variantId: props.variantId,
    price: validSellingPrice(props.price, props.price.currency),
    priceVersion: validVersion(props.priceVersion, "priceVersion"),
    effectiveAt: validInstant(props.effectiveAt, "effectiveAt"),
    setByMembershipId: props.setByMembershipId,
    ...(props.reason === undefined ? {} : { reason: parseCatalogChangeReason(props.reason) }),
  });
}

/**
 * A requested product edit. An absent field is left alone; `null` clears an
 * optional field. The request states the desired values, so a field equal to
 * the current value is not a change.
 */
export interface ProductUpdate {
  readonly name?: ProductName;
  readonly description?: ProductDescription | null;
  readonly categoryId?: ProductCategoryId | null;
  readonly sku?: Sku | null;
  readonly barcode?: Barcode | null;
  readonly stockUnit?: UnitCode;
  readonly trackInventory?: boolean;
}

/** Which fields a real update changed. */
export interface ProductChanges {
  readonly name: boolean;
  readonly description: boolean;
  readonly category: boolean;
  readonly sku: boolean;
  readonly barcode: boolean;
  readonly stockUnit: boolean;
  readonly trackInventory: boolean;
}

export type CatalogProductTransition =
  | { readonly outcome: "unchanged"; readonly item: CatalogProduct }
  | {
      readonly outcome: "changed";
      readonly item: CatalogProduct;
      readonly previous: CatalogProduct;
    };

export type ProductUpdateTransition =
  | { readonly outcome: "unchanged"; readonly item: CatalogProduct }
  | {
      readonly outcome: "changed";
      readonly item: CatalogProduct;
      readonly previous: CatalogProduct;
      readonly changes: ProductChanges;
    };

function optionalDiffers<T>(
  requested: T | null | undefined,
  current: T | undefined,
  same: (a: T, b: T) => boolean,
): boolean {
  if (requested === undefined) return false;
  if (requested === null) return current !== undefined;
  return current === undefined || !same(requested, current);
}

const sameValue = <T>(a: T, b: T): boolean => a === b;
const sameIdentifier = (a: { readonly value: string }, b: { readonly value: string }): boolean => a.value === b.value;

/**
 * Applies a product edit (ADR-008 sections 3.1 and 3.2). The version is
 * checked first; a matching request that changes nothing is a no-op. Inventory-dependent
 * guards: the stock unit is immutable once any movement exists at any
 * location, and inventory tracking cannot be turned off while any location
 * holds a non-zero balance. A pack factor counts minor quantities of the
 * stock unit, so the unit cannot change while an ACTIVE pack exists: the
 * packs are retired first and added again for the new unit.
 */
export function updateProduct(props: {
  readonly item: CatalogProduct;
  readonly expectedVersion: number;
  readonly update: ProductUpdate;
  readonly inventory: VariantInventoryState;
  readonly hasActivePacks: boolean;
  readonly now: Date;
}): ProductUpdateTransition {
  const { item, update } = props;
  const { product, variant } = item;
  if (update.stockUnit !== undefined) parseUnitCode(update.stockUnit);
  if (update.trackInventory !== undefined && typeof update.trackInventory !== "boolean") {
    throw new DomainError("INVALID_VALUE", "trackInventory must be a boolean", "trackInventory");
  }
  const changes: ProductChanges = {
    name: update.name !== undefined && update.name !== product.name,
    description: optionalDiffers(update.description, product.description, sameValue),
    category: optionalDiffers(update.categoryId, product.categoryId, sameValue),
    sku: optionalDiffers(update.sku, variant.sku, sameIdentifier),
    barcode: optionalDiffers(update.barcode, variant.barcode, sameIdentifier),
    stockUnit: update.stockUnit !== undefined && update.stockUnit !== variant.stockUnit,
    trackInventory: update.trackInventory !== undefined && update.trackInventory !== variant.trackInventory,
  };
  const productChanged = changes.name || changes.description || changes.category;
  const variantChanged = changes.sku || changes.barcode || changes.stockUnit || changes.trackInventory;
  requireExpectedVersion(product.version, props.expectedVersion);
  if (!productChanged && !variantChanged) return { outcome: "unchanged", item };

  if (changes.stockUnit && props.inventory.hasMovements) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "the stock unit cannot change once inventory movements exist",
      "stockUnit",
    );
  }
  if (changes.stockUnit && props.inventory.hasConfiguredThreshold) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "the stock unit cannot change while a low-stock threshold is configured",
      "stockUnit",
    );
  }
  if (changes.stockUnit && props.hasActivePacks) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "the stock unit cannot change while active packs are defined in it",
      "stockUnit",
    );
  }
  if (changes.trackInventory && update.trackInventory === false && props.inventory.hasNonZeroBalance) {
    throw new DomainError(
      "INVALID_TRANSITION",
      "inventory tracking cannot be turned off while a balance is not zero",
      "trackInventory",
    );
  }

  const now = validInstant(props.now, "now");
  const description = changes.description ? (update.description ?? undefined) : product.description;
  const categoryId = changes.category ? (update.categoryId ?? undefined) : product.categoryId;
  const nextProduct: Product = Object.freeze({
    id: product.id,
    businessId: product.businessId,
    name: update.name ?? product.name,
    ...(description === undefined ? {} : { description }),
    ...(categoryId === undefined ? {} : { categoryId }),
    status: product.status,
    version: product.version + 1,
    createdByMembershipId: product.createdByMembershipId,
    createdAt: product.createdAt,
    updatedAt: now,
  });
  let nextVariant = variant;
  if (variantChanged) {
    const sku = changes.sku ? (update.sku ?? undefined) : variant.sku;
    const barcode = changes.barcode ? (update.barcode ?? undefined) : variant.barcode;
    nextVariant = Object.freeze({
      id: variant.id,
      businessId: variant.businessId,
      productId: variant.productId,
      isDefault: variant.isDefault,
      status: variant.status,
      ...(sku === undefined ? {} : { sku }),
      ...(barcode === undefined ? {} : { barcode }),
      stockUnit: update.stockUnit ?? variant.stockUnit,
      trackInventory: update.trackInventory ?? variant.trackInventory,
      ...(variant.sellingPrice === undefined ? {} : { sellingPrice: variant.sellingPrice }),
      priceVersion: variant.priceVersion,
      version: variant.version + 1,
      createdAt: variant.createdAt,
      updatedAt: new Date(now.getTime()),
    });
  }
  return {
    outcome: "changed",
    previous: item,
    item: Object.freeze({ product: nextProduct, variant: nextVariant }),
    changes,
  };
}

function setStatus(
  props: { readonly item: CatalogProduct; readonly expectedVersion: number; readonly now: Date },
  status: CatalogStatus,
): CatalogProductTransition {
  const { item } = props;
  requireExpectedVersion(item.product.version, props.expectedVersion);
  if (item.product.status === status) return { outcome: "unchanged", item };
  const now = validInstant(props.now, "now");
  return {
    outcome: "changed",
    previous: item,
    item: Object.freeze({
      product: Object.freeze({ ...item.product, status, version: item.product.version + 1, updatedAt: now }),
      variant: Object.freeze({
        ...item.variant,
        status,
        version: item.variant.version + 1,
        updatedAt: new Date(now.getTime()),
      }),
    }),
  };
}

/** Archives the product and its default variant together. Archive is not deletion. */
export function archiveProduct(props: {
  readonly item: CatalogProduct;
  readonly expectedVersion: number;
  readonly now: Date;
}): CatalogProductTransition {
  return setStatus(props, "ARCHIVED");
}

/** Reactivates the product and its default variant together. */
export function reactivateProduct(props: {
  readonly item: CatalogProduct;
  readonly expectedVersion: number;
  readonly now: Date;
}): CatalogProductTransition {
  return setStatus(props, "ACTIVE");
}

export type SellingPriceTransition =
  | { readonly outcome: "unchanged"; readonly item: CatalogProduct }
  | {
      readonly outcome: "changed";
      readonly item: CatalogProduct;
      readonly previous: CatalogProduct;
      readonly priceEntry: ProductVariantPrice;
    };

/**
 * Sets the business-wide selling price per stock unit (ADR-008 section 3.5).
 * Setting the current price is a no-op: no history row and no version bump.
 * A real change appends exactly one history row with the next priceVersion.
 */
export function setSellingPrice(props: {
  readonly item: CatalogProduct;
  readonly expectedVersion: number;
  readonly price: Money;
  readonly businessCurrency: CurrencyCode;
  readonly priceId: ProductVariantPriceId;
  readonly setByMembershipId: MembershipId;
  readonly reason?: CatalogChangeReason;
  readonly now: Date;
}): SellingPriceTransition {
  const { item } = props;
  const price = validSellingPrice(props.price, props.businessCurrency);
  requireExpectedVersion(item.product.version, props.expectedVersion);
  const current = item.variant.sellingPrice;
  if (current !== undefined && current.currency === price.currency && current.equals(price)) {
    return { outcome: "unchanged", item };
  }
  const now = validInstant(props.now, "now");
  const priceVersion = item.variant.priceVersion + 1;
  const variant: ProductVariant = Object.freeze({
    ...item.variant,
    sellingPrice: price,
    priceVersion,
    version: item.variant.version + 1,
    updatedAt: now,
  });
  return {
    outcome: "changed",
    previous: item,
    item: Object.freeze({
      product: Object.freeze({
        ...item.product,
        version: item.product.version + 1,
        updatedAt: new Date(now.getTime()),
      }),
      variant,
    }),
    priceEntry: priceEntry({
      id: props.priceId,
      variant,
      price,
      priceVersion,
      now,
      setByMembershipId: props.setByMembershipId,
      reason: props.reason,
    }),
  };
}
