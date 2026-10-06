import type {
  Barcode,
  BusinessId,
  CatalogProduct,
  ProductCategoryId,
  ProductId,
  ProductPackId,
  ProductVariantId,
  Sku,
  UnitCode,
} from "@tali/domain";
import {
  Money,
  parseBusinessId,
  parseCurrencyCode,
  parseMembershipId,
  parseProductCategoryId,
  parseProductId,
  parseProductPackId,
  parseProductVariantId,
  restoreCatalogProduct,
} from "@tali/domain";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/application-error.js";
import type { IdempotentResultCodec } from "../../idempotency/keyed-idempotency.js";
import type { JsonObject } from "../../idempotency/result-json.js";
import { booleanAt, instantAt, integerAt, objectAt, optionalTextAt, textAt } from "../../idempotency/result-json.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { ProductCategoryRepository, ProductRepository, UnitReferenceRepository } from "./ports.js";

/** One body for a missing or foreign record, so another business's records are never revealed. */
export const PRODUCT_NOT_FOUND = "Product not found";
export const CATEGORY_NOT_FOUND = "Category not found";
export const PACK_NOT_FOUND = "Pack not found";

function parseOrNotFound<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch {
    throw new NotFoundError(message);
  }
}

export function productIdOrNotFound(value: string): ProductId {
  return parseOrNotFound(() => parseProductId(value), PRODUCT_NOT_FOUND);
}

export function categoryIdOrNotFound(value: string): ProductCategoryId {
  return parseOrNotFound(() => parseProductCategoryId(value), CATEGORY_NOT_FOUND);
}

export function packIdOrNotFound(value: string): ProductPackId {
  return parseOrNotFound(() => parseProductPackId(value), PACK_NOT_FOUND);
}

function invalid(field: string, message: string): ValidationError {
  return new ValidationError(message, [{ path: [field], message }]);
}

/** The version the caller last read (ADR-008 section 9). Malformed input is a validation failure. */
export function parseExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalid("expectedVersion", "expectedVersion must be a positive integer");
  }
  return value;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field, `${field} must be a boolean`);
  return value;
}

/**
 * A price in the business currency, from integer minor units as text
 * (ADR-008 section 14). A different currency is a validation failure, never a
 * conversion.
 */
export function parseSellingPrice(
  value: { readonly amountMinor: string; readonly currency: string },
  businessCurrency: string,
): Money {
  const currency = orInvalid(() => parseCurrencyCode(value.currency), "currency", "currency must be an ISO 4217 code");
  if (currency !== businessCurrency) throw invalid("currency", "price currency must be the business currency");
  if (typeof value.amountMinor !== "string") {
    throw invalid("amountMinor", "amountMinor must be a base-10 integer string of minor units");
  }
  const price = orInvalid(
    () => Money.fromMinorUnitsString(value.amountMinor, currency),
    "amountMinor",
    "amountMinor must be a base-10 integer string of minor units",
  );
  if (!price.isPositive()) throw invalid("amountMinor", "price must be greater than zero");
  return price;
}

function orInvalid<T>(parse: () => T, field: string, message: string): T {
  try {
    return parse();
  } catch {
    throw invalid(field, message);
  }
}

const POSITIVE_INTEGER_STRING = /^[1-9][0-9]*$/;

/** A pack factor from its wire form: a positive base-10 integer string (ADR-008 section 4.3). */
export function parseFactorMinor(value: string): bigint {
  if (typeof value !== "string" || !POSITIVE_INTEGER_STRING.test(value) || value.length > 19) {
    throw invalid("factorMinor", "factorMinor must be a positive base-10 integer string");
  }
  return BigInt(value);
}

export async function requireKnownUnit(
  scope: TransactionScope,
  units: UnitReferenceRepository,
  code: UnitCode,
): Promise<void> {
  if ((await units.findByCode(scope, code)) === undefined) {
    throw invalid("stockUnit", "stockUnit is not a known unit of measure");
  }
}

/** A category can be newly assigned only when it is this business's and ACTIVE (ADR-008 section 3.3). */
export async function requireAssignableCategory(
  scope: TransactionScope,
  categories: ProductCategoryRepository,
  businessId: BusinessId,
  categoryId: ProductCategoryId,
): Promise<void> {
  const category = await categories.findByIdForUpdate(scope, businessId, categoryId);
  if (category === undefined) throw new NotFoundError(CATEGORY_NOT_FOUND);
  if (category.status !== "ACTIVE") throw new ConflictError("An archived category cannot be assigned");
}

/** SKUs are unique per business across all statuses; another variant holding it is a conflict. */
export async function requireSkuAvailable(
  scope: TransactionScope,
  products: ProductRepository,
  businessId: BusinessId,
  sku: Sku,
  self?: ProductVariantId,
): Promise<void> {
  const holder = await products.findVariantIdBySku(scope, businessId, sku.normalized);
  if (holder !== undefined && holder !== self) throw new ConflictError("This SKU is already used by another product");
}

/** Barcodes are unique per business among ACTIVE variants. */
export async function requireBarcodeAvailable(
  scope: TransactionScope,
  products: ProductRepository,
  businessId: BusinessId,
  barcode: Barcode,
  self?: ProductVariantId,
): Promise<void> {
  const holder = await products.findActiveVariantIdByBarcode(scope, businessId, barcode.normalized);
  if (holder !== undefined && holder !== self) {
    throw new ConflictError("This barcode is already used by another active product");
  }
}

function identifierAt(object: JsonObject, name: string): { value: string; normalized: string } | undefined {
  const raw = object[name];
  if (raw === undefined) return undefined;
  const pair = objectAt(raw, name);
  return { value: textAt(pair, "value"), normalized: textAt(pair, "normalized") };
}

/** Stores the created product and variant for replay; decoding re-validates every invariant. */
export const catalogProductCodec: IdempotentResultCodec<CatalogProduct> = {
  encode({ product, variant }) {
    return {
      product: {
        id: product.id,
        businessId: product.businessId,
        name: product.name,
        ...(product.description === undefined ? {} : { description: product.description }),
        ...(product.categoryId === undefined ? {} : { categoryId: product.categoryId }),
        status: product.status,
        version: product.version,
        createdByMembershipId: product.createdByMembershipId,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
      },
      variant: {
        id: variant.id,
        businessId: variant.businessId,
        productId: variant.productId,
        isDefault: variant.isDefault,
        status: variant.status,
        ...(variant.sku === undefined ? {} : { sku: { value: variant.sku.value, normalized: variant.sku.normalized } }),
        ...(variant.barcode === undefined
          ? {}
          : { barcode: { value: variant.barcode.value, normalized: variant.barcode.normalized } }),
        stockUnit: variant.stockUnit,
        trackInventory: variant.trackInventory,
        ...(variant.sellingPrice === undefined
          ? {}
          : {
              sellingPrice: {
                amountMinor: variant.sellingPrice.toMinorUnitsString(),
                currency: variant.sellingPrice.currency,
              },
            }),
        priceVersion: variant.priceVersion,
        version: variant.version,
        createdAt: variant.createdAt.toISOString(),
        updatedAt: variant.updatedAt.toISOString(),
      },
    };
  },
  decode(stored) {
    const root = objectAt(stored, "result");
    const p = objectAt(root["product"], "product");
    const v = objectAt(root["variant"], "variant");
    const description = optionalTextAt(p, "description");
    const categoryId = optionalTextAt(p, "categoryId");
    const sku = identifierAt(v, "sku");
    const barcode = identifierAt(v, "barcode");
    const price = v["sellingPrice"] === undefined ? undefined : objectAt(v["sellingPrice"], "sellingPrice");
    return restoreCatalogProduct({
      product: {
        id: parseProductId(textAt(p, "id")),
        businessId: parseBusinessId(textAt(p, "businessId")),
        name: textAt(p, "name"),
        ...(description === undefined ? {} : { description }),
        ...(categoryId === undefined ? {} : { categoryId: parseProductCategoryId(categoryId) }),
        status: textAt(p, "status"),
        version: integerAt(p, "version"),
        createdByMembershipId: parseMembershipId(textAt(p, "createdByMembershipId")),
        createdAt: instantAt(p, "createdAt"),
        updatedAt: instantAt(p, "updatedAt"),
      },
      variant: {
        id: parseProductVariantId(textAt(v, "id")),
        businessId: parseBusinessId(textAt(v, "businessId")),
        productId: parseProductId(textAt(v, "productId")),
        isDefault: booleanAt(v, "isDefault"),
        status: textAt(v, "status"),
        ...(sku === undefined ? {} : { sku }),
        ...(barcode === undefined ? {} : { barcode }),
        stockUnit: textAt(v, "stockUnit"),
        trackInventory: booleanAt(v, "trackInventory"),
        ...(price === undefined
          ? {}
          : {
              sellingPrice: Money.fromMinorUnitsString(
                textAt(price, "amountMinor"),
                parseCurrencyCode(textAt(price, "currency")),
              ),
            }),
        priceVersion: integerAt(v, "priceVersion"),
        version: integerAt(v, "version"),
        createdAt: instantAt(v, "createdAt"),
        updatedAt: instantAt(v, "updatedAt"),
      },
    });
  },
};
