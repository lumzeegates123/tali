import type { CategoryResponse, PackResponse, PriceHistoryEntryResponse, ProductResponse } from "@tali/shared";

export const BUSINESS_ID = "0190a000-0000-7000-8000-00000000b001";
export const OTHER_BUSINESS_ID = "0190a000-0000-7000-8000-00000000b002";
const INSTANT = "2026-10-06T08:00:00.000Z";

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `0190a000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

export function productFixture(overrides: Partial<ProductResponse> = {}): ProductResponse {
  return {
    id: nextId(),
    variantId: nextId(),
    name: "Peak Milk 400g",
    description: null,
    categoryId: null,
    status: "ACTIVE",
    version: 1,
    sku: null,
    barcode: null,
    stockUnit: "PIECE",
    trackInventory: true,
    sellingPrice: null,
    priceVersion: 0,
    createdAt: INSTANT,
    updatedAt: INSTANT,
    ...overrides,
  };
}

export function categoryFixture(overrides: Partial<CategoryResponse> = {}): CategoryResponse {
  return {
    id: nextId(),
    name: "Dairy",
    status: "ACTIVE",
    version: 1,
    createdAt: INSTANT,
    updatedAt: INSTANT,
    ...overrides,
  };
}

export function packFixture(overrides: Partial<PackResponse> = {}): PackResponse {
  return {
    id: nextId(),
    variantId: nextId(),
    name: "Crate",
    factorMinor: "24",
    status: "ACTIVE",
    createdAt: INSTANT,
    updatedAt: INSTANT,
    ...overrides,
  };
}

export function priceEntryFixture(overrides: Partial<PriceHistoryEntryResponse> = {}): PriceHistoryEntryResponse {
  return {
    id: nextId(),
    variantId: nextId(),
    price: { amountMinor: "35000", currency: "NGN" },
    priceVersion: 1,
    effectiveAt: INSTANT,
    setByMembershipId: nextId(),
    reason: null,
    ...overrides,
  };
}

export const UNITS = {
  items: [
    { code: "PIECE", kind: "COUNT", scale: 0 },
    { code: "KG", kind: "MASS", scale: 3 },
    { code: "L", kind: "VOLUME", scale: 3 },
  ],
} as const;

export const NGN = { code: "NGN", minorUnitDigits: 2 } as const;
