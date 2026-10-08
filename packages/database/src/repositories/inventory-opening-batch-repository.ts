import type { OpeningBatchRepository } from "@tali/application";
import { parseBusinessId, parseLocationId, parseOpeningBatchId, restoreOpeningBatch } from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { recordingColumns, recordingProps } from "./inventory-rows.js";

/**
 * Opening-stock headers (tenant-owned; ADR-008 section 11). Append-only: the
 * application role has no UPDATE or DELETE on the table.
 */
export function createOpeningBatchRepository(): OpeningBatchRepository {
  return {
    async insert(scope, batch) {
      await transactionClient(scope).inventoryOpeningBatch.create({
        data: {
          businessId: batch.businessId,
          id: batch.id,
          locationId: batch.locationId,
          note: batch.note ?? null,
          ...recordingColumns(batch),
        },
      });
    },

    async findById(scope, businessId, id) {
      const row = await transactionClient(scope).inventoryOpeningBatch.findUnique({
        where: { businessId_id: { businessId, id } },
      });
      if (row === null) return undefined;
      return restoreOpeningBatch({
        id: parseOpeningBatchId(row.id),
        businessId: parseBusinessId(row.businessId),
        locationId: parseLocationId(row.locationId),
        ...(row.note === null ? {} : { note: row.note }),
        ...recordingProps(row),
      });
    },
  };
}
