import type { InventoryItemQuery, InventoryItemReader, InventoryItemRow } from "@tali/application";
import type { BusinessId, CatalogStatus, LocationId } from "@tali/domain";
import {
  parseProductId,
  parseProductName,
  parseProductVariantId,
  parseUnitCode,
  Quantity,
  restoreBarcode,
  restoreSku,
} from "@tali/domain";
import { Prisma } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { escapeLikePattern } from "./product-repository.js";

interface ItemRow {
  readonly product_id: string;
  readonly variant_id: string;
  readonly name: string;
  readonly sku: string | null;
  readonly sku_normalized: string | null;
  readonly barcode: string | null;
  readonly barcode_normalized: string | null;
  readonly status: string;
  readonly stock_unit_code: string;
  readonly track_inventory: boolean;
  readonly on_hand_minor: bigint | null;
  readonly balance_version: number | null;
  readonly threshold_minor: bigint | null;
  readonly threshold_version: number | null;
}

function catalogStatus(value: string): CatalogStatus {
  if (value !== "ACTIVE" && value !== "ARCHIVED") throw new Error("a stored product status must be ACTIVE or ARCHIVED");
  return value;
}

/** Quantities are minor units of the variant's current stock unit, which cannot change while stock or a threshold exists. */
function toItem(row: ItemRow): InventoryItemRow {
  const unit = parseUnitCode(row.stock_unit_code);
  if ((row.sku === null) !== (row.sku_normalized === null)) {
    throw new Error("stored sku and its normalized form must be present together");
  }
  if ((row.barcode === null) !== (row.barcode_normalized === null)) {
    throw new Error("stored barcode and its normalized form must be present together");
  }
  return Object.freeze({
    productId: parseProductId(row.product_id),
    variantId: parseProductVariantId(row.variant_id),
    name: parseProductName(row.name),
    ...(row.sku === null || row.sku_normalized === null ? {} : { sku: restoreSku(row.sku, row.sku_normalized) }),
    ...(row.barcode === null || row.barcode_normalized === null
      ? {}
      : { barcode: restoreBarcode(row.barcode, row.barcode_normalized) }),
    productStatus: catalogStatus(row.status),
    stockUnit: unit,
    trackInventory: row.track_inventory,
    onHand: Quantity.ofMinor(row.on_hand_minor ?? 0n, unit),
    balanceVersion: row.balance_version ?? 0,
    ...(row.threshold_minor === null ? {} : { threshold: Quantity.ofMinor(row.threshold_minor, unit) }),
    thresholdVersion: row.threshold_version ?? 0,
  });
}

/** The visible-item rule of the list and the detail read (Slice 6 plan section 31). */
const VISIBLE = Prisma.sql`v.track_inventory AND (p.status = 'ACTIVE' OR COALESCE(b.quantity_minor, 0) <> 0)`;

/** deriveLowStock in SQL: ACTIVE, tracked, a configured threshold, and on-hand at or below it. */
const LOW_STOCK = Prisma.sql`p.status = 'ACTIVE' AND v.status = 'ACTIVE' AND v.track_inventory
  AND t.low_stock_threshold_minor IS NOT NULL AND COALESCE(b.quantity_minor, 0) <= t.low_stock_threshold_minor`;

function searchFilter(search: InventoryItemQuery["search"]): Prisma.Sql {
  if (search === undefined) return Prisma.empty;
  const pattern = `%${escapeLikePattern(search.nameContains)}%`;
  const sku = search.skuKey === undefined ? Prisma.empty : Prisma.sql` OR v.sku_normalized = ${search.skuKey}`;
  const barcode =
    search.barcodeKey === undefined ? Prisma.empty : Prisma.sql` OR v.barcode_normalized = ${search.barcodeKey}`;
  return Prisma.sql` AND (p.name ILIKE ${pattern} ESCAPE '\\'${sku}${barcode})`;
}

function itemsSql(businessId: BusinessId, locationId: LocationId, where: Prisma.Sql, tail: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT p.id::text AS product_id, v.id::text AS variant_id, p.name, v.sku, v.sku_normalized, v.barcode,
           v.barcode_normalized, p.status, v.stock_unit_code, v.track_inventory,
           b.quantity_minor AS on_hand_minor, b.version AS balance_version,
           t.low_stock_threshold_minor AS threshold_minor, t.version AS threshold_version
    FROM products p
    JOIN product_variants v ON v.business_id = p.business_id AND v.product_id = p.id AND v.is_default
    LEFT JOIN inventory_balances b
      ON b.business_id = v.business_id AND b.location_id = ${locationId}::uuid AND b.variant_id = v.id
    LEFT JOIN inventory_stock_thresholds t
      ON t.business_id = v.business_id AND t.location_id = ${locationId}::uuid AND t.variant_id = v.id
    WHERE p.business_id = ${businessId}::uuid AND ${VISIBLE}${where}
    ${tail}`;
}

/**
 * Inventory list and detail reads (tenant-owned; Slice 6 plan section 31):
 * the business's own default variants joined to this location's balance and
 * threshold, one query each. Both reads apply the same visibility, so a
 * variant the list never shows is not found in detail either.
 */
export function createInventoryItemReader(): InventoryItemReader {
  return {
    async listItems(scope, businessId, locationId, query, request) {
      const after = request.after === undefined ? Prisma.empty : Prisma.sql` AND v.id > ${request.after}::uuid`;
      const lowStock = query.lowStockOnly === true ? Prisma.sql` AND ${LOW_STOCK}` : Prisma.empty;
      const rows = await transactionClient(scope).$queryRaw<ItemRow[]>(
        itemsSql(
          businessId,
          locationId,
          Prisma.sql`${searchFilter(query.search)}${lowStock}${after}`,
          Prisma.sql`ORDER BY v.id LIMIT ${request.limit + 1}::int`,
        ),
      );
      const selected = rows.slice(0, request.limit);
      const last = selected.at(-1);
      return {
        items: selected.map(toItem),
        nextCursor: rows.length > request.limit && last !== undefined ? last.variant_id : null,
      };
    },

    async getItem(scope, businessId, locationId, variantId) {
      const rows = await transactionClient(scope).$queryRaw<ItemRow[]>(
        itemsSql(businessId, locationId, Prisma.sql` AND v.id = ${variantId}::uuid`, Prisma.empty),
      );
      const [row] = rows;
      return row === undefined ? undefined : toItem(row);
    },
  };
}
