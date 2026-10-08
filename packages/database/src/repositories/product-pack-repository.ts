import type { ProductPackRepository } from "@tali/application";
import { assertPackTransition, ConcurrentModificationError } from "@tali/application";
import type { ProductPack, ProductPackId } from "@tali/domain";
import { parseBusinessId, parseProductPackId, parseProductVariantId, restorePack } from "@tali/domain";
import type { ProductPack as ProductPackRow } from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { keysetArgs, toPage } from "./pagination.js";

export const PACK_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  product_packs_active_name_unique: "An active pack with this name already exists",
});

function toPack(row: ProductPackRow): ProductPack {
  return restorePack({
    id: parseProductPackId(row.id),
    businessId: parseBusinessId(row.businessId),
    variantId: parseProductVariantId(row.variantId),
    name: row.name,
    factorMinor: row.factorMinor,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Pack conversions (tenant-owned; ADR-008 section 4.3). Name and factor are
 * immutable; the only change is ACTIVE to RETIRED. The ACTIVE name is unique
 * per variant (exact, case-sensitive) as a partial unique index; a lost race
 * surfaces as ConflictError.
 */
export function createProductPackRepository(): ProductPackRepository {
  return {
    async insert(scope, pack) {
      await translatingUniqueViolations(PACK_CONFLICTS, () =>
        transactionClient(scope).productPack.create({
          data: {
            businessId: pack.businessId,
            id: pack.id,
            variantId: pack.variantId,
            name: pack.name,
            factorMinor: pack.factorMinor,
            status: pack.status,
            createdAt: pack.createdAt,
            updatedAt: pack.updatedAt,
          },
        }),
      );
    },

    async findByIdForUpdate(scope, businessId, packId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM product_packs WHERE business_id = ${businessId}::uuid AND id = ${packId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.productPack.findUnique({ where: { businessId_id: { businessId, id: packId } } });
      return row === null ? undefined : toPack(row);
    },

    async update(scope, previous, next) {
      assertPackTransition(previous, next);
      const { count } = await transactionClient(scope).productPack.updateMany({
        where: { businessId: previous.businessId, id: previous.id, status: "ACTIVE" },
        data: { status: next.status, updatedAt: next.updatedAt },
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },

    async listForVariant(scope, businessId, variantId, status, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).productPack.findMany({
        where: { businessId, variantId, status, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
      });
      return toPage(rows, request, (row) => row.id, toPack);
    },

    async hasActivePacks(scope, businessId, variantId) {
      const row = await transactionClient(scope).productPack.findFirst({
        where: { businessId, variantId, status: "ACTIVE" },
        select: { id: true },
      });
      return row !== null;
    },

    async findActiveIdByName(scope, businessId, variantId, name) {
      const row = await transactionClient(scope).productPack.findFirst({
        where: { businessId, variantId, status: "ACTIVE", name },
        select: { id: true },
      });
      return row === null ? undefined : parseProductPackId(row.id);
    },

    async findForEntry(scope, businessId, packIds) {
      const found = new Map<ProductPackId, ProductPack>();
      if (packIds.size === 0) return found;
      const rows = await transactionClient(scope).productPack.findMany({
        where: { businessId, id: { in: [...packIds] } },
        orderBy: { id: "asc" },
      });
      for (const row of rows) {
        const pack = toPack(row);
        found.set(pack.id, pack);
      }
      return found;
    },
  };
}
