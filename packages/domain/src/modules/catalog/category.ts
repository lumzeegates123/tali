import { normalizeBoundedName } from "../../text.js";
import type { BusinessId } from "../business/index.js";
import type { CatalogStatus } from "./common.js";
import { requireExpectedVersion, validCatalogStatus, validInstant, validVersion } from "./common.js";
import type { ProductCategoryId } from "./ids.js";

declare const categoryNameBrand: unique symbol;
declare const categoryNameKeyBrand: unique symbol;

/** 1 to 60 characters after trimming and NFC normalization. */
export type CategoryName = string & { readonly [categoryNameBrand]: true };

/** Case-insensitive comparison key; unique among a business's ACTIVE categories (ADR-008 section 3.3). */
export type CategoryNameKey = string & { readonly [categoryNameKeyBrand]: true };

export const CATEGORY_NAME_MAX_LENGTH = 60;

export function parseCategoryName(value: string): CategoryName {
  return normalizeBoundedName(value, "name", CATEGORY_NAME_MAX_LENGTH) as CategoryName;
}

export function categoryNameKey(name: CategoryName): CategoryNameKey {
  return name.toLowerCase() as CategoryNameKey;
}

/** A flat, business-scoped product grouping. No nesting in Build 2. */
export interface ProductCategory {
  readonly id: ProductCategoryId;
  readonly businessId: BusinessId;
  readonly name: CategoryName;
  readonly normalizedName: CategoryNameKey;
  readonly status: CatalogStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CategoryTransition =
  | { readonly outcome: "unchanged"; readonly category: ProductCategory }
  | { readonly outcome: "changed"; readonly category: ProductCategory; readonly previous: ProductCategory };

export function createCategory(props: {
  readonly id: ProductCategoryId;
  readonly businessId: BusinessId;
  readonly name: CategoryName;
  readonly now: Date;
}): ProductCategory {
  const now = validInstant(props.now, "now");
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    name: props.name,
    normalizedName: categoryNameKey(props.name),
    status: "ACTIVE",
    version: 1,
    createdAt: now,
    updatedAt: new Date(now.getTime()),
  });
}

export function restoreCategory(props: {
  readonly id: ProductCategoryId;
  readonly businessId: BusinessId;
  readonly name: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ProductCategory {
  const name = parseCategoryName(props.name);
  return Object.freeze({
    id: props.id,
    businessId: props.businessId,
    name,
    normalizedName: categoryNameKey(name),
    status: validCatalogStatus(props.status),
    version: validVersion(props.version),
    createdAt: validInstant(props.createdAt, "createdAt"),
    updatedAt: validInstant(props.updatedAt, "updatedAt"),
  });
}

/** Renaming to the current name is a no-op; a case-only change is a real change of display name. */
export function renameCategory(props: {
  readonly category: ProductCategory;
  readonly expectedVersion: number;
  readonly name: CategoryName;
  readonly now: Date;
}): CategoryTransition {
  const { category } = props;
  requireExpectedVersion(category.version, props.expectedVersion);
  if (category.name === props.name) return { outcome: "unchanged", category };
  return {
    outcome: "changed",
    previous: category,
    category: Object.freeze({
      ...category,
      name: props.name,
      normalizedName: categoryNameKey(props.name),
      version: category.version + 1,
      updatedAt: validInstant(props.now, "now"),
    }),
  };
}

/**
 * Archiving hides the category from new assignment. Products keep their
 * assignment (ADR-008 section 3.3). Build 2 has no category reactivation.
 */
export function archiveCategory(props: {
  readonly category: ProductCategory;
  readonly expectedVersion: number;
  readonly now: Date;
}): CategoryTransition {
  const { category } = props;
  requireExpectedVersion(category.version, props.expectedVersion);
  if (category.status === "ARCHIVED") return { outcome: "unchanged", category };
  return {
    outcome: "changed",
    previous: category,
    category: Object.freeze({
      ...category,
      status: "ARCHIVED",
      version: category.version + 1,
      updatedAt: validInstant(props.now, "now"),
    }),
  };
}
