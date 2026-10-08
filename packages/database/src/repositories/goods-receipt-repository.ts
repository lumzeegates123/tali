import type { GoodsReceiptRepository } from "@tali/application";
import { assertDocumentReversal, ConcurrentModificationError } from "@tali/application";
import type { GoodsReceipt } from "@tali/domain";
import { parseBusinessId, parseGoodsReceiptId, parseLocationId, restoreGoodsReceipt } from "@tali/domain";
import type { GoodsReceipt as GoodsReceiptRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { recordingColumns, recordingProps, reversalColumns, reversalProps } from "./inventory-rows.js";

function toGoodsReceipt(row: GoodsReceiptRow): GoodsReceipt {
  return restoreGoodsReceipt({
    id: parseGoodsReceiptId(row.id),
    businessId: parseBusinessId(row.businessId),
    locationId: parseLocationId(row.locationId),
    ...(row.reference === null ? {} : { reference: row.reference }),
    ...(row.note === null ? {} : { note: row.note }),
    ...reversalProps(row),
    ...recordingProps(row),
  });
}

/**
 * Quantity-only goods-receipt headers (tenant-owned; ADR-008 section 11). The
 * only change is POSTED to REVERSED; the application role may update the four
 * reversal columns and nothing else, and has no DELETE.
 */
export function createGoodsReceiptRepository(): GoodsReceiptRepository {
  return {
    async insert(scope, receipt) {
      await transactionClient(scope).goodsReceipt.create({
        data: {
          businessId: receipt.businessId,
          id: receipt.id,
          locationId: receipt.locationId,
          reference: receipt.reference ?? null,
          note: receipt.note ?? null,
          ...reversalColumns(receipt),
          ...recordingColumns(receipt),
        },
      });
    },

    async findById(scope, businessId, id) {
      const row = await transactionClient(scope).goodsReceipt.findUnique({
        where: { businessId_id: { businessId, id } },
      });
      return row === null ? undefined : toGoodsReceipt(row);
    },

    async findByIdForUpdate(scope, businessId, id) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM goods_receipts WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.goodsReceipt.findUnique({ where: { businessId_id: { businessId, id } } });
      return row === null ? undefined : toGoodsReceipt(row);
    },

    async markReversed(scope, previous, next) {
      assertDocumentReversal(previous, next);
      const { count } = await transactionClient(scope).goodsReceipt.updateMany({
        where: { businessId: previous.businessId, id: previous.id, status: "POSTED" },
        data: reversalColumns(next),
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },
  };
}
