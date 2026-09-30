import type { LocationRepository } from "@tali/application";
import type { BusinessLocation } from "@tali/domain";
import { parseBusinessId, parseLocationId, restoreLocation } from "@tali/domain";
import type { BusinessLocation as LocationRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { keysetArgs, toPage } from "./pagination.js";

function toLocation(row: LocationRow): BusinessLocation {
  return restoreLocation({
    id: parseLocationId(row.id),
    businessId: parseBusinessId(row.businessId),
    name: row.name,
    isDefault: row.isDefault,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** Business locations (tenant-owned). Every read is filtered by the context business. */
export function createLocationRepository(): LocationRepository {
  return {
    async insert(scope, location) {
      await transactionClient(scope).businessLocation.create({
        data: {
          businessId: location.businessId,
          id: location.id,
          name: location.name,
          isDefault: location.isDefault,
          status: location.status,
          createdAt: location.createdAt,
          updatedAt: location.updatedAt,
        },
      });
    },

    async listForBusiness(scope, businessId, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).businessLocation.findMany({
        where: { businessId, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
      });
      return toPage(rows, request, (row) => row.id, toLocation);
    },
  };
}
