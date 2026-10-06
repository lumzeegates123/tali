import { z } from "zod";
import { MoneyWireSchema } from "./money.js";
import { UnitCodeWireSchema } from "./quantity.js";
import { PageQuerySchema } from "./tenancy.js";

/**
 * Build 2 catalog wire contracts (ADR-008, plan 004 Slice 3). Every object is
 * strict: unknown fields are rejected on input and can never appear on
 * output. Length bounds are transport limits only; the exact rules (trimming,
 * NFC, code-point lengths, SKU and barcode syntax, known units, pack factor
 * range, the business currency) are enforced server-side by the domain.
 *
 * Money and pack factors are base-10 integer strings, never JSON numbers.
 * Responses carry display values only: never normalized lookup keys, storage
 * column names, audit data or membership versions. Products expose their one
 * default variant flattened; there is no variant API in Build 2.
 */

const IdWireSchema = z.uuid();
const InstantWireSchema = z.iso.datetime();
const nextCursor = z.string().min(1).max(256).nullable();
const VersionWireSchema = z.number().int().min(1);
const ReasonWireSchema = z.string().max(2000);
const ProductNameWireSchema = z.string().max(480);
const DescriptionWireSchema = z.string().max(2000);
const SkuWireSchema = z.string().max(256);
const BarcodeWireSchema = z.string().max(256);
const CategoryNameWireSchema = z.string().max(240);
/** A path or body ID is a claim: a malformed or foreign ID is answered with NOT_FOUND server-side. */
const IdClaimWireSchema = z.string().max(64);

/** A pack factor in stock-unit minor units: a canonical positive base-10 integer string. */
export const PackFactorMinorWireSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, "must be a positive base-10 integer string");

export const CatalogStatusWireSchema = z.enum(["ACTIVE", "ARCHIVED"]);
export const PackStatusWireSchema = z.enum(["ACTIVE", "RETIRED"]);
export const UnitKindWireSchema = z.enum(["COUNT", "MASS", "VOLUME"]);

// ---- Paths ---------------------------------------------------------------

export const ProductPathSchema = z.strictObject({ businessId: z.string(), productId: z.string() });
export const CategoryPathSchema = z.strictObject({ businessId: z.string(), categoryId: z.string() });
export const PackPathSchema = z.strictObject({ businessId: z.string(), packId: z.string() });

// ---- Queries -------------------------------------------------------------

/** `GET .../products`: keyset page, status (ACTIVE by default) and an optional search term. */
export const ProductListQuerySchema = PageQuerySchema.extend({
  status: CatalogStatusWireSchema.optional(),
  q: z.string().min(1).max(480).optional(),
});
export type ProductListParams = z.infer<typeof ProductListQuerySchema>;

/** `GET .../categories`: keyset page and status (ACTIVE by default). */
export const CategoryListQuerySchema = PageQuerySchema.extend({ status: CatalogStatusWireSchema.optional() });
export type CategoryListParams = z.infer<typeof CategoryListQuerySchema>;

/** `GET .../products/:productId/packs`: keyset page and status (ACTIVE by default). */
export const PackListQuerySchema = PageQuerySchema.extend({ status: PackStatusWireSchema.optional() });
export type PackListParams = z.infer<typeof PackListQuerySchema>;

// ---- Requests ------------------------------------------------------------

/** `POST .../products` (`product:manage`; `initialPrice` also needs `product:price`; requires `Idempotency-Key`). */
export const CreateProductRequestSchema = z.strictObject({
  name: ProductNameWireSchema,
  description: DescriptionWireSchema.optional(),
  categoryId: IdClaimWireSchema.optional(),
  sku: SkuWireSchema.optional(),
  barcode: BarcodeWireSchema.optional(),
  stockUnit: UnitCodeWireSchema,
  trackInventory: z.boolean(),
  initialPrice: MoneyWireSchema.optional(),
});
export type CreateProductRequest = z.infer<typeof CreateProductRequestSchema>;

const PRODUCT_EDITABLE_FIELDS = [
  "name",
  "description",
  "categoryId",
  "sku",
  "barcode",
  "stockUnit",
  "trackInventory",
] as const;

/** `PATCH .../products/:productId` (`product:manage`): at least one field; `null` clears an optional field. */
export const UpdateProductRequestSchema = z
  .strictObject({
    expectedVersion: VersionWireSchema,
    name: ProductNameWireSchema.optional(),
    description: DescriptionWireSchema.nullable().optional(),
    categoryId: IdClaimWireSchema.nullable().optional(),
    sku: SkuWireSchema.nullable().optional(),
    barcode: BarcodeWireSchema.nullable().optional(),
    stockUnit: UnitCodeWireSchema.optional(),
    trackInventory: z.boolean().optional(),
  })
  .refine((body) => PRODUCT_EDITABLE_FIELDS.some((field) => body[field] !== undefined), {
    message: "at least one field to change is required",
  });
export type UpdateProductRequest = z.infer<typeof UpdateProductRequestSchema>;

/** `POST .../products/:productId/archive` (`product:manage`). Archive is never deletion. */
export const ArchiveProductRequestSchema = z.strictObject({
  expectedVersion: VersionWireSchema,
  reason: ReasonWireSchema.optional(),
});
export type ArchiveProductRequest = z.infer<typeof ArchiveProductRequestSchema>;

/** `POST .../products/:productId/reactivate` (`product:manage`). */
export const ReactivateProductRequestSchema = z.strictObject({ expectedVersion: VersionWireSchema });
export type ReactivateProductRequest = z.infer<typeof ReactivateProductRequestSchema>;

/** `PUT .../products/:productId/price` (`product:price`): a positive price in the business currency. */
export const SetSellingPriceRequestSchema = z.strictObject({
  expectedVersion: VersionWireSchema,
  price: MoneyWireSchema,
  reason: ReasonWireSchema.optional(),
});
export type SetSellingPriceRequest = z.infer<typeof SetSellingPriceRequestSchema>;

/** `POST .../categories` (`product:manage`, requires `Idempotency-Key`). */
export const CreateCategoryRequestSchema = z.strictObject({ name: CategoryNameWireSchema });
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

/** `PATCH .../categories/:categoryId` (`product:manage`). */
export const UpdateCategoryRequestSchema = z.strictObject({
  expectedVersion: VersionWireSchema,
  name: CategoryNameWireSchema,
});
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;

/** `POST .../categories/:categoryId/archive` (`product:manage`). */
export const ArchiveCategoryRequestSchema = z.strictObject({ expectedVersion: VersionWireSchema });
export type ArchiveCategoryRequest = z.infer<typeof ArchiveCategoryRequestSchema>;

/** `POST .../products/:productId/packs` (`product:manage`, requires `Idempotency-Key`). No pack price or barcode. */
export const AddPackRequestSchema = z.strictObject({
  name: z.string().max(160),
  factorMinor: PackFactorMinorWireSchema,
});
export type AddPackRequest = z.infer<typeof AddPackRequestSchema>;

// ---- Responses -----------------------------------------------------------

/** A product and its default variant, flattened. */
export const ProductResponseSchema = z.strictObject({
  id: IdWireSchema,
  variantId: IdWireSchema,
  name: z.string(),
  description: z.string().nullable(),
  categoryId: IdWireSchema.nullable(),
  status: CatalogStatusWireSchema,
  version: VersionWireSchema,
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  stockUnit: UnitCodeWireSchema,
  trackInventory: z.boolean(),
  sellingPrice: MoneyWireSchema.nullable(),
  priceVersion: z.number().int().min(0),
  createdAt: InstantWireSchema,
  updatedAt: InstantWireSchema,
});
export type ProductResponse = z.infer<typeof ProductResponseSchema>;

export const ProductsResponseSchema = z.strictObject({ items: z.array(ProductResponseSchema), nextCursor });
export type ProductsResponse = z.infer<typeof ProductsResponseSchema>;

export const CategoryResponseSchema = z.strictObject({
  id: IdWireSchema,
  name: z.string(),
  status: CatalogStatusWireSchema,
  version: VersionWireSchema,
  createdAt: InstantWireSchema,
  updatedAt: InstantWireSchema,
});
export type CategoryResponse = z.infer<typeof CategoryResponseSchema>;

export const CategoriesResponseSchema = z.strictObject({ items: z.array(CategoryResponseSchema), nextCursor });
export type CategoriesResponse = z.infer<typeof CategoriesResponseSchema>;

export const PackResponseSchema = z.strictObject({
  id: IdWireSchema,
  variantId: IdWireSchema,
  name: z.string(),
  factorMinor: PackFactorMinorWireSchema,
  status: PackStatusWireSchema,
  createdAt: InstantWireSchema,
  updatedAt: InstantWireSchema,
});
export type PackResponse = z.infer<typeof PackResponseSchema>;

export const PacksResponseSchema = z.strictObject({ items: z.array(PackResponseSchema), nextCursor });
export type PacksResponse = z.infer<typeof PacksResponseSchema>;

export const PriceHistoryEntryResponseSchema = z.strictObject({
  id: IdWireSchema,
  variantId: IdWireSchema,
  price: MoneyWireSchema,
  priceVersion: VersionWireSchema,
  effectiveAt: InstantWireSchema,
  setByMembershipId: IdWireSchema,
  reason: z.string().nullable(),
});
export type PriceHistoryEntryResponse = z.infer<typeof PriceHistoryEntryResponseSchema>;

export const PriceHistoryResponseSchema = z.strictObject({
  items: z.array(PriceHistoryEntryResponseSchema),
  nextCursor,
});
export type PriceHistoryResponse = z.infer<typeof PriceHistoryResponseSchema>;

export const UnitResponseSchema = z.strictObject({
  code: UnitCodeWireSchema,
  kind: UnitKindWireSchema,
  scale: z.number().int().min(0).max(3),
});
export type UnitResponse = z.infer<typeof UnitResponseSchema>;

/** `GET .../catalog/units`: the small, fixed reference set, not paginated. */
export const UnitsResponseSchema = z.strictObject({ items: z.array(UnitResponseSchema) });
export type UnitsResponse = z.infer<typeof UnitsResponseSchema>;
