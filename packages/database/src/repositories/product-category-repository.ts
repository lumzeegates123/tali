import type { ProductCategoryRepository } from "@tali/application";
import { assertCategoryTransition, ConcurrentModificationError } from "@tali/application";
import type { ProductCategory } from "@tali/domain";
import { parseBusinessId, parseProductCategoryId, restoreCategory } from "@tali/domain";
import type { ProductCategory as ProductCategoryRow } from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { keysetArgs, toPage } from "./pagination.js";

export const CATEGORY_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  product_categories_active_name_unique: "An active category with this name already exists",
});

/** The stored name key must be the one the domain computes from the stored name; anything else fails loudly. */
export function toCategory(row: ProductCategoryRow): ProductCategory {
  const category = restoreCategory({
    id: parseProductCategoryId(row.id),
    businessId: parseBusinessId(row.businessId),
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (category.normalizedName !== row.normalizedName) {
    throw new Error("stored category name key does not match its name");
  }
  return category;
}

/**
 * Flat product categories (tenant-owned; ADR-008 section 3.3). The ACTIVE
 * name key is unique per business as a partial unique index; a lost race
 * surfaces as ConflictError.
 */
export function createProductCategoryRepository(): ProductCategoryRepository {
  return {
    async insert(scope, category) {
      await translatingUniqueViolations(CATEGORY_CONFLICTS, () =>
        transactionClient(scope).productCategory.create({
          data: {
            businessId: category.businessId,
            id: category.id,
            name: category.name,
            normalizedName: category.normalizedName,
            status: category.status,
            version: category.version,
            createdAt: category.createdAt,
            updatedAt: category.updatedAt,
          },
        }),
      );
    },

    async findByIdForUpdate(scope, businessId, categoryId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM product_categories
        WHERE business_id = ${businessId}::uuid AND id = ${categoryId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.productCategory.findUnique({
        where: { businessId_id: { businessId, id: categoryId } },
      });
      return row === null ? undefined : toCategory(row);
    },

    async findById(scope, businessId, categoryId) {
      const row = await transactionClient(scope).productCategory.findUnique({
        where: { businessId_id: { businessId, id: categoryId } },
      });
      return row === null ? undefined : toCategory(row);
    },

    async list(scope, businessId, status, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).productCategory.findMany({
        where: { businessId, status, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
      });
      return toPage(rows, request, (row) => row.id, toCategory);
    },

    async update(scope, previous, next) {
      assertCategoryTransition(previous, next);
      await translatingUniqueViolations(CATEGORY_CONFLICTS, async () => {
        const { count } = await transactionClient(scope).productCategory.updateMany({
          where: { businessId: previous.businessId, id: previous.id, version: previous.version },
          data: {
            name: next.name,
            normalizedName: next.normalizedName,
            status: next.status,
            version: next.version,
            updatedAt: next.updatedAt,
          },
        });
        if (count !== 1) throw new ConcurrentModificationError();
      });
    },

    async findActiveIdByName(scope, businessId, name) {
      const row = await transactionClient(scope).productCategory.findFirst({
        where: { businessId, status: "ACTIVE", normalizedName: name },
        select: { id: true },
      });
      return row === null ? undefined : parseProductCategoryId(row.id);
    },
  };
}
