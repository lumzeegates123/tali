import type { Id } from "../../kernel/index.js";
import { parseId } from "../../kernel/index.js";

export type InventoryMovementId = Id<"InventoryMovement">;
export type OpeningBatchId = Id<"OpeningBatch">;
export type GoodsReceiptId = Id<"GoodsReceipt">;
export type InventoryAdjustmentId = Id<"InventoryAdjustment">;
export type StockThresholdId = Id<"StockThreshold">;
export type StocktakeId = Id<"Stocktake">;

export function parseInventoryMovementId(value: string): InventoryMovementId {
  return parseId("InventoryMovement", value);
}

export function parseOpeningBatchId(value: string): OpeningBatchId {
  return parseId("OpeningBatch", value);
}

export function parseGoodsReceiptId(value: string): GoodsReceiptId {
  return parseId("GoodsReceipt", value);
}

export function parseInventoryAdjustmentId(value: string): InventoryAdjustmentId {
  return parseId("InventoryAdjustment", value);
}

export function parseStockThresholdId(value: string): StockThresholdId {
  return parseId("StockThreshold", value);
}

export function parseStocktakeId(value: string): StocktakeId {
  return parseId("Stocktake", value);
}
