import type {
  AdjustmentResponse,
  DocumentMovementResponse,
  GoodsReceiptResponse,
  InventoryItemResponse,
  InventoryMovementResponse,
  OpeningBatchResponse,
  StocktakeLineResponse,
  StocktakeResponse,
} from "@tali/shared";

const INSTANT = "2026-10-06T08:00:00.000Z";
const DATE = "2026-10-06";
export const LOCATION_ID = "0190a000-0000-7000-8000-0000000001aa";

let sequence = 0;
export function inventoryId(): string {
  sequence += 1;
  return `0190a000-0000-7000-8000-${(0xc00000 + sequence).toString(16).padStart(12, "0")}`;
}

export function itemFixture(overrides: Partial<InventoryItemResponse> = {}): InventoryItemResponse {
  return {
    productId: inventoryId(),
    variantId: inventoryId(),
    name: "Peak Milk 400g",
    sku: null,
    barcode: null,
    productStatus: "ACTIVE",
    stockUnit: "PIECE",
    onHand: { quantityMinor: "12", unit: "PIECE" },
    balanceVersion: 1,
    threshold: null,
    thresholdVersion: 0,
    lowStock: false,
    ...overrides,
  };
}

export function movementFixture(overrides: Partial<InventoryMovementResponse> = {}): InventoryMovementResponse {
  return {
    movementId: inventoryId(),
    type: "PURCHASE_RECEIPT",
    delta: { quantityMinor: "24", unit: "PIECE" },
    balanceAfter: { quantityMinor: "36", unit: "PIECE" },
    balanceVersion: 2,
    source: { kind: "GOODS_RECEIPT", id: inventoryId() },
    pack: null,
    reversesMovementId: null,
    reasonCode: null,
    reasonNote: null,
    sourceChannel: "WEB",
    occurredAt: INSTANT,
    businessDate: DATE,
    ...overrides,
  };
}

export function documentMovement(
  variantId: string,
  overrides: Partial<DocumentMovementResponse> = {},
): DocumentMovementResponse {
  return { ...movementFixture(), variantId, ...overrides };
}

const header = (id: string) => ({ id, locationId: LOCATION_ID, note: null, occurredAt: INSTANT, businessDate: DATE });

export function openingFixture(variantId: string, id = inventoryId()): OpeningBatchResponse {
  return {
    document: header(id),
    movements: [documentMovement(variantId, { type: "OPENING", source: { kind: "OPENING_BATCH", id } })],
  };
}

export function receiptFixture(
  variantId: string,
  id = inventoryId(),
  status: "POSTED" | "REVERSED" = "POSTED",
): GoodsReceiptResponse {
  return {
    document: {
      ...header(id),
      reference: "INV-1",
      status,
      reversedAt: status === "REVERSED" ? INSTANT : null,
      reversalReason: status === "REVERSED" ? "Wrong delivery" : null,
    },
    movements: [documentMovement(variantId, { source: { kind: "GOODS_RECEIPT", id } })],
  };
}

export function adjustmentFixture(
  variantId: string,
  kind: "ADJUSTMENT" | "WRITE_OFF" = "ADJUSTMENT",
  id = inventoryId(),
): AdjustmentResponse {
  const document =
    kind === "ADJUSTMENT"
      ? {
          ...header(id),
          kind,
          reasonCode: "FOUND_STOCK" as const,
          reasonNote: null,
          status: "POSTED" as const,
          reversedAt: null,
          reversalReason: null,
        }
      : {
          ...header(id),
          kind,
          reasonCode: "DAMAGED" as const,
          reasonNote: null,
          status: "POSTED" as const,
          reversedAt: null,
          reversalReason: null,
        };
  return {
    document,
    movements: [
      documentMovement(variantId, {
        type: kind,
        delta: { quantityMinor: kind === "WRITE_OFF" ? "-2" : "3", unit: "PIECE" },
        source: { kind: "ADJUSTMENT", id },
        reasonCode: document.reasonCode,
      }),
    ],
  };
}

export function stocktakeFixture(
  visibility: "FULL" | "BLIND",
  overrides: Partial<Omit<StocktakeResponse, "visibility">> = {},
): StocktakeResponse {
  return {
    visibility,
    stocktakeId: inventoryId(),
    locationId: LOCATION_ID,
    status: "DRAFT",
    version: 1,
    note: null,
    createdAt: INSTANT,
    postedAt: null,
    businessDate: null,
    cancelledAt: null,
    countedLineCount: 0,
    posting: null,
    ...overrides,
  };
}

export function blindLine(variantId: string, overrides: Partial<StocktakeLineResponse> = {}): StocktakeLineResponse {
  return {
    visibility: "BLIND",
    variantId,
    status: "COUNTED",
    countedQuantity: { quantityMinor: "10", unit: "PIECE" },
    stockUnit: "PIECE",
    version: 1,
    countedAt: INSTANT,
    ...overrides,
  } as StocktakeLineResponse;
}

export function fullLine(
  variantId: string,
  overrides: Partial<Extract<StocktakeLineResponse, { visibility: "FULL" }>> = {},
): StocktakeLineResponse {
  return {
    visibility: "FULL",
    variantId,
    status: "COUNTED",
    countedQuantity: { quantityMinor: "10", unit: "PIECE" },
    stockUnit: "PIECE",
    version: 1,
    countedAt: INSTANT,
    expectedAtCount: { quantityMinor: "987", unit: "PIECE" },
    variance: null,
    ...overrides,
  };
}
