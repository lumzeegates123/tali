import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";

export type ProductId = Id<"Product">;
export type ProductVariantId = Id<"ProductVariant">;
export type ProductCategoryId = Id<"ProductCategory">;
export type ProductPackId = Id<"ProductPack">;
export type ProductVariantPriceId = Id<"ProductVariantPrice">;

export function parseProductId(value: string): ProductId {
  return parseId("Product", value);
}

export function parseProductVariantId(value: string): ProductVariantId {
  return parseId("ProductVariant", value);
}

export function parseProductCategoryId(value: string): ProductCategoryId {
  return parseId("ProductCategory", value);
}

export function parseProductPackId(value: string): ProductPackId {
  return parseId("ProductPack", value);
}

export function parseProductVariantPriceId(value: string): ProductVariantPriceId {
  return parseId("ProductVariantPrice", value);
}
