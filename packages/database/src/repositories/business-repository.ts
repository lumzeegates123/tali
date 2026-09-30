import type { BusinessRepository, CurrencyReferenceRepository } from "@tali/application";
import type { Business } from "@tali/domain";
import { defineCurrency, parseBusinessId, parseUserId, restoreBusiness } from "@tali/domain";
import type { Business as BusinessRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

export function toBusiness(row: BusinessRow): Business {
  return restoreBusiness({
    id: parseBusinessId(row.id),
    name: row.name,
    currencyCode: row.currencyCode,
    timeZone: row.timeZone,
    status: row.status,
    createdByUserId: parseUserId(row.createdByUserId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** Businesses: `businesses.id` is the tenant key itself (ADR-005 sections 5 and 19). */
export function createBusinessRepository(): BusinessRepository {
  return {
    async findById(scope, businessId) {
      const row = await transactionClient(scope).business.findUnique({ where: { id: businessId } });
      return row === null ? undefined : toBusiness(row);
    },

    async findByIdForUpdate(scope, businessId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.business.findUnique({ where: { id: businessId } });
      return row === null ? undefined : toBusiness(row);
    },

    async update(scope, business) {
      const { count } = await transactionClient(scope).business.updateMany({
        where: { id: business.id },
        data: { name: business.name, updatedAt: business.updatedAt },
      });
      if (count !== 1) throw new Error("business update affected no row");
    },

    async insert(scope, business) {
      await transactionClient(scope).business.create({
        data: {
          id: business.id,
          name: business.name,
          currencyCode: business.currencyCode,
          timeZone: business.timeZone,
          status: business.status,
          createdByUserId: business.createdByUserId,
          createdAt: business.createdAt,
          updatedAt: business.updatedAt,
        },
      });
    },
  };
}

/** The global, read-only currency reference data (ADR-005 section 5). */
export function createCurrencyReferenceRepository(): CurrencyReferenceRepository {
  return {
    async findByCode(scope, code) {
      const row = await transactionClient(scope).currency.findUnique({ where: { code } });
      return row === null ? undefined : defineCurrency(row.code, row.minorUnitDigits);
    },
  };
}
