import type { InventoryMovementRepository } from "@tali/application";
import type { InventoryMovement, InventoryMovementSource } from "@tali/domain";
import {
  parseBusinessId,
  parseGoodsReceiptId,
  parseInventoryAdjustmentId,
  parseInventoryMovementId,
  parseLocationId,
  parseOpeningBatchId,
  parseProductPackId,
  parseProductVariantId,
  parseStocktakeId,
  parseUnitCode,
  Quantity,
  restoreMovement,
} from "@tali/domain";
import type { InventoryMovement as InventoryMovementRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { recordingColumns, recordingProps } from "./inventory-rows.js";
import { toPage } from "./pagination.js";

/** Exactly one typed document column is set per movement (ADR-008 section 8). */
function sourceColumns(source: InventoryMovementSource) {
  return {
    openingBatchId: source.kind === "OPENING_BATCH" ? source.id : null,
    goodsReceiptId: source.kind === "GOODS_RECEIPT" ? source.id : null,
    adjustmentId: source.kind === "ADJUSTMENT" ? source.id : null,
    stocktakeId: source.kind === "STOCKTAKE" ? source.id : null,
  };
}

function sourceFilter(source: InventoryMovementSource) {
  switch (source.kind) {
    case "OPENING_BATCH":
      return { openingBatchId: source.id };
    case "GOODS_RECEIPT":
      return { goodsReceiptId: source.id };
    case "ADJUSTMENT":
      return { adjustmentId: source.id };
    case "STOCKTAKE":
      return { stocktakeId: source.id };
  }
}

function toSource(row: InventoryMovementRow): InventoryMovementSource {
  const set = [row.openingBatchId, row.goodsReceiptId, row.adjustmentId, row.stocktakeId].filter((id) => id !== null);
  if (set.length !== 1) throw new Error("a stored movement must reference exactly one document");
  if (row.openingBatchId !== null) return { kind: "OPENING_BATCH", id: parseOpeningBatchId(row.openingBatchId) };
  if (row.goodsReceiptId !== null) return { kind: "GOODS_RECEIPT", id: parseGoodsReceiptId(row.goodsReceiptId) };
  if (row.adjustmentId !== null) return { kind: "ADJUSTMENT", id: parseInventoryAdjustmentId(row.adjustmentId) };
  return { kind: "STOCKTAKE", id: parseStocktakeId(row.stocktakeId as string) };
}

const withStockUnit = { variant: { select: { stockUnitCode: true } } } as const;

function toPack(row: InventoryMovementRow) {
  const { packId, packName, packCount, packFactorMinor } = row;
  if (packId === null && packName === null && packCount === null && packFactorMinor === null) return undefined;
  if (packId === null || packName === null || packCount === null || packFactorMinor === null) {
    throw new Error("a stored pack snapshot must be complete");
  }
  return { packId: parseProductPackId(packId), name: packName, count: packCount, factorMinor: packFactorMinor };
}

/** Movement quantities are stored in minor units of the variant's stock unit, which is fixed once stock moves. */
function toMovement(row: InventoryMovementRow, stockUnitCode: string): InventoryMovement {
  const unit = parseUnitCode(stockUnitCode);
  const pack = toPack(row);
  return restoreMovement({
    id: parseInventoryMovementId(row.id),
    businessId: parseBusinessId(row.businessId),
    locationId: parseLocationId(row.locationId),
    variantId: parseProductVariantId(row.variantId),
    type: row.type,
    delta: Quantity.ofMinor(row.quantityDeltaMinor, unit),
    balanceAfter: Quantity.ofMinor(row.balanceAfterMinor, unit),
    balanceVersion: row.balanceVersion,
    source: toSource(row),
    ...(pack === undefined ? {} : { pack }),
    ...(row.reversesMovementId === null
      ? {}
      : { reversesMovementId: parseInventoryMovementId(row.reversesMovementId) }),
    ...(row.reasonCode === null ? {} : { reasonCode: row.reasonCode }),
    ...(row.reasonNote === null ? {} : { reasonNote: row.reasonNote }),
    ...recordingProps(row),
  });
}

/**
 * The append-only movement ledger (tenant-owned; ADR-008 section 7.1). The
 * application role has INSERT and SELECT only. Every database invariant (one
 * document reference matching the type, direction, reason, pack arithmetic,
 * gap-free versions, one reversal per original) is also a constraint.
 */
export function createInventoryMovementRepository(): InventoryMovementRepository {
  return {
    async insertMany(scope, movements) {
      if (movements.length === 0) return;
      await transactionClient(scope).inventoryMovement.createMany({
        data: movements.map((movement) => ({
          businessId: movement.businessId,
          id: movement.id,
          locationId: movement.locationId,
          variantId: movement.variantId,
          type: movement.type,
          quantityDeltaMinor: movement.delta.amountMinor,
          balanceAfterMinor: movement.balanceAfter.amountMinor,
          balanceVersion: movement.balanceVersion,
          ...sourceColumns(movement.source),
          packId: movement.pack?.packId ?? null,
          packName: movement.pack?.name ?? null,
          packCount: movement.pack?.count ?? null,
          packFactorMinor: movement.pack?.factorMinor ?? null,
          reversesMovementId: movement.reversesMovementId ?? null,
          reasonCode: movement.reasonCode ?? null,
          reasonNote: movement.reasonNote ?? null,
          ...recordingColumns(movement),
        })),
      });
    },

    async listOriginals(scope, businessId, source) {
      const rows = await transactionClient(scope).inventoryMovement.findMany({
        where: { businessId, ...sourceFilter(source), reversesMovementId: null },
        include: withStockUnit,
        orderBy: { variantId: "asc" },
      });
      return rows.map((row) => toMovement(row, row.variant.stockUnitCode));
    },

    async listForSource(scope, businessId, source) {
      const client = transactionClient(scope);
      const where = { businessId, ...sourceFilter(source) };
      const originals = await client.inventoryMovement.findMany({
        where: { ...where, reversesMovementId: null },
        include: withStockUnit,
        orderBy: { variantId: "asc" },
      });
      const reversals = await client.inventoryMovement.findMany({
        where: { ...where, reversesMovementId: { not: null } },
        include: withStockUnit,
        orderBy: { variantId: "asc" },
      });
      return [...originals, ...reversals].map((row) => toMovement(row, row.variant.stockUnitCode));
    },

    async listForItem(scope, businessId, locationId, variantId, request) {
      const client = transactionClient(scope);
      const item = { businessId, locationId, variantId };
      let below: { readonly balanceVersion: { readonly lt: number } } | undefined;
      if (request.after !== undefined) {
        const cursor = await client.inventoryMovement.findFirst({
          where: { ...item, id: request.after },
          select: { balanceVersion: true },
        });
        if (cursor === null) return undefined;
        below = { balanceVersion: { lt: cursor.balanceVersion } };
      }
      const rows = await client.inventoryMovement.findMany({
        where: { ...item, ...below },
        include: withStockUnit,
        orderBy: { balanceVersion: "desc" },
        take: request.limit + 1,
      });
      return toPage(
        rows,
        request,
        (row) => row.id,
        (row) => toMovement(row, row.variant.stockUnitCode),
      );
    },
  };
}
