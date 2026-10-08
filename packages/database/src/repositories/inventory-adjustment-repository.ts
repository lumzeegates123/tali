import type { InventoryAdjustmentRepository } from "@tali/application";
import { assertDocumentReversal, ConcurrentModificationError } from "@tali/application";
import type { InventoryAdjustment } from "@tali/domain";
import { parseBusinessId, parseInventoryAdjustmentId, parseLocationId, restoreInventoryAdjustment } from "@tali/domain";
import type { InventoryAdjustment as InventoryAdjustmentRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { recordingColumns, recordingProps, reversalColumns, reversalProps } from "./inventory-rows.js";

function toAdjustment(row: InventoryAdjustmentRow): InventoryAdjustment {
  return restoreInventoryAdjustment({
    id: parseInventoryAdjustmentId(row.id),
    businessId: parseBusinessId(row.businessId),
    locationId: parseLocationId(row.locationId),
    kind: row.kind,
    reasonCode: row.reasonCode,
    ...(row.reasonNote === null ? {} : { reasonNote: row.reasonNote }),
    ...(row.note === null ? {} : { note: row.note }),
    ...reversalProps(row),
    ...recordingProps(row),
  });
}

/**
 * Adjustment and write-off headers (tenant-owned; ADR-008 section 11). The
 * only change is POSTED to REVERSED; the application role may update the four
 * reversal columns and nothing else, and has no DELETE.
 */
export function createInventoryAdjustmentRepository(): InventoryAdjustmentRepository {
  return {
    async insert(scope, adjustment) {
      await transactionClient(scope).inventoryAdjustment.create({
        data: {
          businessId: adjustment.businessId,
          id: adjustment.id,
          locationId: adjustment.locationId,
          kind: adjustment.kind,
          reasonCode: adjustment.reasonCode,
          reasonNote: adjustment.reasonNote ?? null,
          note: adjustment.note ?? null,
          ...reversalColumns(adjustment),
          ...recordingColumns(adjustment),
        },
      });
    },

    async findById(scope, businessId, id) {
      const row = await transactionClient(scope).inventoryAdjustment.findUnique({
        where: { businessId_id: { businessId, id } },
      });
      return row === null ? undefined : toAdjustment(row);
    },

    async findByIdForUpdate(scope, businessId, id) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM inventory_adjustments
        WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.inventoryAdjustment.findUnique({ where: { businessId_id: { businessId, id } } });
      return row === null ? undefined : toAdjustment(row);
    },

    async markReversed(scope, previous, next) {
      assertDocumentReversal(previous, next);
      const { count } = await transactionClient(scope).inventoryAdjustment.updateMany({
        where: { businessId: previous.businessId, id: previous.id, status: "POSTED" },
        data: reversalColumns(next),
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },
  };
}
