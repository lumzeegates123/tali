import type {
  Barcode,
  BusinessDate,
  CatalogStatus,
  GoodsReceipt,
  GoodsReceiptId,
  GoodsReceiptReference,
  InventoryAdjustment,
  InventoryAdjustmentId,
  InventoryAdjustmentKind,
  InventoryDocumentStatus,
  InventoryMovement,
  InventoryMovementId,
  InventoryMovementSource,
  InventoryMovementType,
  InventoryNote,
  InventoryReasonCode,
  InventoryReasonNote,
  LocationId,
  OpeningBatch,
  OpeningBatchId,
  PackSnapshot,
  ProductId,
  ProductName,
  ProductVariantId,
  Quantity,
  Sku,
  UnitCode,
} from "@tali/domain";
import {
  deriveLowStock,
  parseGoodsReceiptId,
  parseInventoryAdjustmentId,
  parseOpeningBatchId,
  parseProductVariantId,
} from "@tali/domain";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireContextPermission, requireLocationBound } from "../../context/business-context.js";
import { NotFoundError, ValidationError } from "../../errors/application-error.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { Page } from "../../queries/pagination.js";
import { invalidCursorError, parsePageRequest } from "../../queries/pagination.js";
import { PRODUCT_NOT_FOUND, parseProductSearch } from "../catalog/index.js";
import { inventoryPermissions } from "../identity/index.js";
import {
  ADJUSTMENT_NOT_FOUND,
  GOODS_RECEIPT_NOT_FOUND,
  idOrNotFound,
  OPENING_BATCH_NOT_FOUND,
} from "./inventory-common.js";
import type {
  GoodsReceiptRepository,
  InventoryAdjustmentRepository,
  InventoryItemReader,
  InventoryItemRow,
  InventoryMovementRepository,
  OpeningBatchRepository,
} from "./ports.js";

/** One stock item at the context's location, with low-stock derived on read. */
export interface InventoryItemView {
  readonly productId: ProductId;
  readonly variantId: ProductVariantId;
  readonly name: ProductName;
  readonly sku?: Sku;
  readonly barcode?: Barcode;
  readonly productStatus: CatalogStatus;
  readonly stockUnit: UnitCode;
  readonly onHand: Quantity;
  /** 0 when the stock item has no balance row yet. */
  readonly balanceVersion: number;
  readonly threshold?: Quantity;
  /** 0 when no threshold row exists; a cleared threshold keeps its row's version. */
  readonly thresholdVersion: number;
  readonly lowStock: boolean;
}

/**
 * One movement of a stock item's history. Who recorded it, from which device
 * and under which correlation ID stay in the audit trail; they are not part
 * of this view.
 */
export interface InventoryMovementView {
  readonly movementId: InventoryMovementId;
  readonly type: InventoryMovementType;
  readonly delta: Quantity;
  readonly balanceAfter: Quantity;
  readonly balanceVersion: number;
  readonly source: InventoryMovementSource;
  readonly pack?: PackSnapshot;
  readonly reversesMovementId?: InventoryMovementId;
  readonly reasonCode?: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
  readonly sourceChannel: string;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
}

/** A movement of a document, which may cover several stock items. */
export interface DocumentMovementView extends InventoryMovementView {
  readonly variantId: ProductVariantId;
}

interface DocumentHeaderView {
  readonly locationId: LocationId;
  readonly note?: InventoryNote;
  readonly sourceChannel: string;
  readonly occurredAt: Date;
  readonly businessDate: BusinessDate;
}

interface ReversibleHeaderView extends DocumentHeaderView {
  readonly status: InventoryDocumentStatus;
  readonly reversedAt?: Date;
  readonly reversalReason?: InventoryReasonNote;
}

export interface OpeningBatchView extends DocumentHeaderView {
  readonly id: OpeningBatchId;
}

export interface GoodsReceiptView extends ReversibleHeaderView {
  readonly id: GoodsReceiptId;
  readonly reference?: GoodsReceiptReference;
}

export interface AdjustmentView extends ReversibleHeaderView {
  readonly id: InventoryAdjustmentId;
  readonly kind: InventoryAdjustmentKind;
  readonly reasonCode: InventoryReasonCode;
  readonly reasonNote?: InventoryReasonNote;
}

/** A document header with every movement it wrote: originals first, then any reversals, each by variant ID. */
export interface InventoryDocumentResult<Header> {
  readonly document: Header;
  readonly movements: readonly DocumentMovementView[];
}

export interface ListInventoryItemsInput {
  /** Name contains, or exact SKU or barcode, as in the catalog product search. */
  readonly q?: string;
  readonly lowStockOnly?: boolean;
  readonly limit?: number;
  readonly after?: string;
}

export interface ListItemMovementsInput {
  readonly variantId: string;
  readonly limit?: number;
  readonly after?: string;
}

/**
 * `inventory:read` (every role). Stock items at the context's location:
 * tracked ACTIVE products, with or without stock, and tracked ARCHIVED
 * products that still have stock. Untracked products are never listed.
 */
export interface ListInventoryItems {
  execute(context: LocationBoundContext, input?: ListInventoryItemsInput): Promise<Page<InventoryItemView>>;
}

/** `inventory:read`. One visible stock item; any other variant is NOT_FOUND. */
export interface GetInventoryItem {
  execute(context: LocationBoundContext, input: { readonly variantId: string }): Promise<InventoryItemView>;
}

/**
 * `inventory:read`. A visible stock item's movements, newest first. A
 * malformed cursor, or one that is not a movement of this stock item, is
 * VALIDATION_FAILED.
 */
export interface ListItemMovements {
  execute(context: LocationBoundContext, input: ListItemMovementsInput): Promise<Page<InventoryMovementView>>;
}

/** `inventory:read`. An opening-stock batch at the context's location with its movements. */
export interface GetOpeningBatch {
  execute(
    context: LocationBoundContext,
    input: { readonly documentId: string },
  ): Promise<InventoryDocumentResult<OpeningBatchView>>;
}

/** `inventory:read`. A goods receipt at the context's location with its movements and any reversals. */
export interface GetGoodsReceipt {
  execute(
    context: LocationBoundContext,
    input: { readonly documentId: string },
  ): Promise<InventoryDocumentResult<GoodsReceiptView>>;
}

/** `inventory:read`. An adjustment or write-off at the context's location with its movements and any reversals. */
export interface GetAdjustment {
  execute(
    context: LocationBoundContext,
    input: { readonly documentId: string },
  ): Promise<InventoryDocumentResult<AdjustmentView>>;
}

export interface InventoryReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly items: InventoryItemReader;
  readonly movements: InventoryMovementRepository;
  readonly openings: OpeningBatchRepository;
  readonly receipts: GoodsReceiptRepository;
  readonly adjustments: InventoryAdjustmentRepository;
}

const readPermission = inventoryPermissions.permissions["inventory:read"];

function readContext(context: LocationBoundContext): LocationBoundContext {
  requireContextPermission(context, readPermission);
  return requireLocationBound(context);
}

/** Tracked, and ACTIVE or still holding stock (Slice 6 plan section 31). */
export function isVisibleInventoryItem(row: InventoryItemRow): boolean {
  return row.trackInventory && (row.productStatus === "ACTIVE" || !row.onHand.isZero());
}

function itemView(row: InventoryItemRow): InventoryItemView {
  const lowStock = deriveLowStock({
    variantStatus: row.productStatus,
    trackInventory: row.trackInventory,
    stockUnit: row.stockUnit,
    threshold: row.threshold,
    onHand: row.onHand,
  });
  return Object.freeze({
    productId: row.productId,
    variantId: row.variantId,
    name: row.name,
    ...(row.sku === undefined ? {} : { sku: row.sku }),
    ...(row.barcode === undefined ? {} : { barcode: row.barcode }),
    productStatus: row.productStatus,
    stockUnit: row.stockUnit,
    onHand: row.onHand,
    balanceVersion: row.balanceVersion,
    ...(row.threshold === undefined ? {} : { threshold: row.threshold }),
    thresholdVersion: row.thresholdVersion,
    lowStock,
  });
}

function movementView(movement: InventoryMovement): InventoryMovementView {
  return Object.freeze({
    movementId: movement.id,
    type: movement.type,
    delta: movement.delta,
    balanceAfter: movement.balanceAfter,
    balanceVersion: movement.balanceVersion,
    source: movement.source,
    ...(movement.pack === undefined ? {} : { pack: movement.pack }),
    ...(movement.reversesMovementId === undefined ? {} : { reversesMovementId: movement.reversesMovementId }),
    ...(movement.reasonCode === undefined ? {} : { reasonCode: movement.reasonCode }),
    ...(movement.reasonNote === undefined ? {} : { reasonNote: movement.reasonNote }),
    sourceChannel: movement.sourceChannel,
    occurredAt: movement.occurredAt,
    businessDate: movement.businessDate,
  });
}

function documentMovementView(movement: InventoryMovement): DocumentMovementView {
  return Object.freeze({ ...movementView(movement), variantId: movement.variantId });
}

function headerView(document: OpeningBatch | GoodsReceipt | InventoryAdjustment): DocumentHeaderView {
  return {
    locationId: document.locationId,
    ...(document.note === undefined ? {} : { note: document.note }),
    sourceChannel: document.sourceChannel,
    occurredAt: document.occurredAt,
    businessDate: document.businessDate,
  };
}

function reversibleHeaderView(document: GoodsReceipt | InventoryAdjustment): ReversibleHeaderView {
  return {
    ...headerView(document),
    status: document.status,
    ...(document.reversedAt === undefined ? {} : { reversedAt: document.reversedAt }),
    ...(document.reversalReason === undefined ? {} : { reversalReason: document.reversalReason }),
  };
}

/** The visible item of this business at the context's location; anything else is NOT_FOUND. */
async function visibleItem(
  dependencies: InventoryReadDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  variantId: ProductVariantId,
): Promise<InventoryItemRow> {
  const row = await dependencies.items.getItem(scope, context.businessId, context.locationId, variantId);
  if (row === undefined || !isVisibleInventoryItem(row)) throw new NotFoundError(PRODUCT_NOT_FOUND);
  return row;
}

async function documentMovements(
  dependencies: InventoryReadDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  source: InventoryMovementSource,
): Promise<readonly DocumentMovementView[]> {
  const movements = await dependencies.movements.listForSource(scope, context.businessId, source);
  return movements.map(documentMovementView);
}

function parseLowStockOnly(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ValidationError("lowStockOnly must be true or false", [
      { path: ["lowStockOnly"], message: "must be a boolean" },
    ]);
  }
  return value;
}

export function createListInventoryItems(dependencies: InventoryReadDependencies): ListInventoryItems {
  return {
    async execute(locationContext, input) {
      const context = readContext(locationContext);
      const search = input?.q === undefined ? undefined : parseProductSearch(input.q);
      const lowStockOnly = parseLowStockOnly(input?.lowStockOnly);
      const request = parsePageRequest({
        ...(input?.limit === undefined ? {} : { limit: input.limit }),
        ...(input?.after === undefined ? {} : { after: input.after }),
      });
      return dependencies.unitOfWork.run(async (scope) => {
        const page = await dependencies.items.listItems(
          scope,
          context.businessId,
          context.locationId,
          { ...(search === undefined ? {} : { search }), lowStockOnly },
          request,
        );
        const items = page.items.map((row) => {
          const view = itemView(row);
          if (!isVisibleInventoryItem(row) || (lowStockOnly && !view.lowStock)) {
            throw new Error("the inventory item reader returned a row outside the query");
          }
          return view;
        });
        return { items, nextCursor: page.nextCursor };
      });
    },
  };
}

export function createGetInventoryItem(dependencies: InventoryReadDependencies): GetInventoryItem {
  return {
    async execute(locationContext, input) {
      const context = readContext(locationContext);
      const variantId = idOrNotFound(() => parseProductVariantId(input.variantId), PRODUCT_NOT_FOUND);
      return dependencies.unitOfWork.run(async (scope) =>
        itemView(await visibleItem(dependencies, scope, context, variantId)),
      );
    },
  };
}

export function createListItemMovements(dependencies: InventoryReadDependencies): ListItemMovements {
  return {
    async execute(locationContext, input) {
      const context = readContext(locationContext);
      const variantId = idOrNotFound(() => parseProductVariantId(input.variantId), PRODUCT_NOT_FOUND);
      const request = parsePageRequest({
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined ? {} : { after: input.after }),
      });
      return dependencies.unitOfWork.run(async (scope) => {
        await visibleItem(dependencies, scope, context, variantId);
        const page = await dependencies.movements.listForItem(
          scope,
          context.businessId,
          context.locationId,
          variantId,
          request,
        );
        if (page === undefined) throw invalidCursorError();
        return { items: page.items.map(movementView), nextCursor: page.nextCursor };
      });
    },
  };
}

export function createGetOpeningBatch(dependencies: InventoryReadDependencies): GetOpeningBatch {
  return {
    async execute(locationContext, input) {
      const context = readContext(locationContext);
      const id = idOrNotFound(() => parseOpeningBatchId(input.documentId), OPENING_BATCH_NOT_FOUND);
      return dependencies.unitOfWork.run(async (scope) => {
        const batch = await dependencies.openings.findById(scope, context.businessId, id);
        if (batch?.locationId !== context.locationId) throw new NotFoundError(OPENING_BATCH_NOT_FOUND);
        return {
          document: Object.freeze({ id: batch.id, ...headerView(batch) }),
          movements: await documentMovements(dependencies, scope, context, { kind: "OPENING_BATCH", id: batch.id }),
        };
      });
    },
  };
}

export function createGetGoodsReceipt(dependencies: InventoryReadDependencies): GetGoodsReceipt {
  return {
    async execute(locationContext, input) {
      const context = readContext(locationContext);
      const id = idOrNotFound(() => parseGoodsReceiptId(input.documentId), GOODS_RECEIPT_NOT_FOUND);
      return dependencies.unitOfWork.run(async (scope) => {
        const receipt = await dependencies.receipts.findById(scope, context.businessId, id);
        if (receipt?.locationId !== context.locationId) throw new NotFoundError(GOODS_RECEIPT_NOT_FOUND);
        return {
          document: Object.freeze({
            id: receipt.id,
            ...(receipt.reference === undefined ? {} : { reference: receipt.reference }),
            ...reversibleHeaderView(receipt),
          }),
          movements: await documentMovements(dependencies, scope, context, { kind: "GOODS_RECEIPT", id: receipt.id }),
        };
      });
    },
  };
}

export function createGetAdjustment(dependencies: InventoryReadDependencies): GetAdjustment {
  return {
    async execute(locationContext, input) {
      const context = readContext(locationContext);
      const id = idOrNotFound(() => parseInventoryAdjustmentId(input.documentId), ADJUSTMENT_NOT_FOUND);
      return dependencies.unitOfWork.run(async (scope) => {
        const adjustment = await dependencies.adjustments.findById(scope, context.businessId, id);
        if (adjustment?.locationId !== context.locationId) throw new NotFoundError(ADJUSTMENT_NOT_FOUND);
        return {
          document: Object.freeze({
            id: adjustment.id,
            kind: adjustment.kind,
            reasonCode: adjustment.reasonCode,
            ...(adjustment.reasonNote === undefined ? {} : { reasonNote: adjustment.reasonNote }),
            ...reversibleHeaderView(adjustment),
          }),
          movements: await documentMovements(dependencies, scope, context, { kind: "ADJUSTMENT", id: adjustment.id }),
        };
      });
    },
  };
}
