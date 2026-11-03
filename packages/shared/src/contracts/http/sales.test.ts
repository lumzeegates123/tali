import { describe, expect, it } from "vitest";
import {
  DiscountExceedsLineDetailsSchema,
  DiscountExceedsLineErrorEnvelopeSchema,
  InsufficientStockDetailsSchema,
  InsufficientStockErrorEnvelopeSchema,
  PriceChangedDetailsSchema,
  PriceChangedErrorEnvelopeSchema,
  PriceNotSetDetailsSchema,
  PriceNotSetErrorEnvelopeSchema,
  ProductArchivedDetailsSchema,
  ProductArchivedErrorEnvelopeSchema,
  RecordSaleRequestSchema,
  ReverseSaleRequestSchema,
  SaleCostStatusWireSchema,
  SaleLineCostStatusWireSchema,
  SalePathSchema,
  SaleResponseSchema,
  SalesResponseSchema,
  SaleTaxKindWireSchema,
  TenderMethodWireSchema,
  TenderTotalMismatchDetailsSchema,
  TenderTotalMismatchErrorEnvelopeSchema,
  TenderVerificationStatusWireSchema,
} from "./sales.js";

const ID = "0190a000-0000-7000-8000-000000000001";
const ID2 = "0190a000-0000-7000-8000-000000000002";
const AT = "2026-11-02T08:00:00.000Z";
const DAY = "2026-11-02";
const ngn = (amountMinor: string) => ({ amountMinor, currency: "NGN" });

type Schema = { safeParse(value: unknown): { success: boolean } };
const ok = (schema: Schema, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(true);
};
const bad = (schema: Schema, value: unknown) => {
  expect(schema.safeParse(value).success).toBe(false);
};

const line = {
  variantId: ID,
  quantity: { quantityMinor: "2", unit: "PIECE" },
  expectedPriceVersion: 1,
};
const request = { saleId: ID, lines: [line], tenders: [{ method: "CASH", amount: ngn("100000") }] };

const responseLine = {
  lineNumber: 1,
  variantId: ID,
  productName: "Soap",
  sku: null,
  tracked: true,
  quantity: { quantityMinor: "2", unit: "PIECE" },
  unitScale: 0,
  unitPrice: ngn("50000"),
  priceVersion: 1,
  gross: ngn("100000"),
  discount: { kind: "NONE" },
  discountAmount: ngn("0"),
  net: ngn("100000"),
  taxKind: "NONE",
  tax: ngn("0"),
  total: ngn("100000"),
};
const tender = {
  tenderNumber: 1,
  method: "CASH",
  amount: ngn("100000"),
  reference: null,
  verificationStatus: "NOT_APPLICABLE",
  cashReceived: ngn("100000"),
  changeGiven: ngn("0"),
};
const sale = {
  saleId: ID,
  locationId: ID2,
  receiptNumber: "S-000001",
  status: "POSTED",
  currency: "NGN",
  grossTotal: ngn("100000"),
  discountTotal: ngn("0"),
  taxTotal: ngn("0"),
  total: ngn("100000"),
  occurredAt: AT,
  businessDate: DAY,
  recordedAt: AT,
  deviceReportedAt: null,
  reversedAt: null,
  reversalTenderUnwoundConfirmed: null,
  lines: [responseLine],
  tenders: [tender],
};
const costed = {
  ...sale,
  costStatus: "VALUED",
  cogsTotal: ngn("70000"),
  lines: [{ ...responseLine, costStatus: "VALUED", cost: ngn("70000") }],
};

describe("RecordSaleRequestSchema", () => {
  it("accepts a minimal sale, split tenders, both discount kinds and device time", () => {
    ok(RecordSaleRequestSchema, request);
    ok(RecordSaleRequestSchema, {
      ...request,
      deviceReportedAt: AT,
      lines: [
        { ...line, discount: { kind: "FIXED", amount: ngn("1000") } },
        { ...line, variantId: ID2, discount: { kind: "BASIS_POINTS", basisPoints: 9999 } },
      ],
      tenders: [
        { method: "CASH", amount: ngn("60000"), cashReceived: ngn("70000") },
        { method: "BANK_TRANSFER", amount: ngn("20000"), reference: "TRF-1" },
        { method: "POS_CARD", amount: ngn("10000") },
        { method: "OTHER", amount: ngn("10000") },
      ],
    });
    expect(TenderMethodWireSchema.options).toEqual(["CASH", "BANK_TRANSFER", "POS_CARD", "OTHER"]);
  });

  it("rejects a client location, price, total, tax, cost, receipt, status, device or channel", () => {
    const forbidden = [
      "locationId",
      "sourceChannel",
      "correlationId",
      "actorMembershipId",
      "recordedByMembershipId",
      "deviceId",
      "receiptNumber",
      "status",
      "total",
      "grossTotal",
      "taxTotal",
      "cost",
      "cogs",
      "changeGiven",
      "journalEntryId",
      "businessId",
      "occurredAt",
      "currency",
    ];
    for (const key of forbidden) bad(RecordSaleRequestSchema, { ...request, [key]: "x" });
    const lineForbidden = [
      "unitPrice",
      "price",
      "priceMinor",
      "tax",
      "taxRate",
      "taxKind",
      "taxTreatmentId",
      "costStatus",
      "cogs",
      "averageCost",
      "margin",
      "packId",
      "packCount",
      "locationId",
      "lineNumber",
      "total",
    ];
    for (const key of lineForbidden) bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, [key]: "1" }] });
    for (const key of ["changeGiven", "verificationStatus", "tenderNumber", "currency", "amountMinor"]) {
      bad(RecordSaleRequestSchema, { ...request, tenders: [{ method: "CASH", amount: ngn("100000"), [key]: "x" }] });
    }
  });

  it("bounds lines and tenders and requires positive canonical string quantities", () => {
    bad(RecordSaleRequestSchema, { ...request, lines: [] });
    ok(RecordSaleRequestSchema, { ...request, lines: Array.from({ length: 200 }, () => line) });
    bad(RecordSaleRequestSchema, { ...request, lines: Array.from({ length: 201 }, () => line) });
    bad(RecordSaleRequestSchema, { ...request, tenders: [] });
    const tenders = (count: number) => Array.from({ length: count }, () => ({ method: "CASH", amount: ngn("1") }));
    ok(RecordSaleRequestSchema, { ...request, tenders: tenders(10) });
    bad(RecordSaleRequestSchema, { ...request, tenders: tenders(11) });
    for (const quantityMinor of ["0", "-1", "01", "1.5", "", "1000000000000001", 2]) {
      bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, quantity: { quantityMinor, unit: "PIECE" } }] });
    }
    ok(RecordSaleRequestSchema, {
      ...request,
      lines: [{ ...line, quantity: { quantityMinor: "1000000000000000", unit: "PIECE" } }],
    });
    bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, quantity: { quantityMinor: "2", unit: "piece" } }] });
    bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, quantity: { quantityMinor: "2" } }] });
    bad(RecordSaleRequestSchema, {
      ...request,
      lines: [{ ...line, quantity: { quantityMinor: "2", unit: "PIECE", decimal: "2" } }],
    });
  });

  it("requires a persisted price version and integer basis points from 1 to 9999", () => {
    for (const expectedPriceVersion of [0, -1, 1.5, "1"]) {
      bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, expectedPriceVersion }] });
    }
    bad(RecordSaleRequestSchema, { ...request, lines: [{ variantId: ID, quantity: line.quantity }] });
    for (const basisPoints of [0, 10_000, 1.5, "100"]) {
      bad(RecordSaleRequestSchema, {
        ...request,
        lines: [{ ...line, discount: { kind: "BASIS_POINTS", basisPoints } }],
      });
    }
    bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, discount: { kind: "NONE" } }] });
    bad(RecordSaleRequestSchema, { ...request, lines: [{ ...line, discount: { kind: "FIXED", amountMinor: "1" } }] });
    bad(RecordSaleRequestSchema, {
      ...request,
      lines: [{ ...line, discount: { kind: "FIXED", amount: ngn("1"), basisPoints: 1 } }],
    });
  });

  it("carries money as strict string MoneyWire, never numbers", () => {
    bad(RecordSaleRequestSchema, {
      ...request,
      tenders: [{ method: "CASH", amount: { amountMinor: 100000, currency: "NGN" } }],
    });
    bad(RecordSaleRequestSchema, {
      ...request,
      tenders: [{ method: "CASH", amount: { amountMinor: "1.5", currency: "NGN" } }],
    });
    bad(RecordSaleRequestSchema, {
      ...request,
      tenders: [{ method: "CASH", amount: { amountMinor: "1", currency: "ngn" } }],
    });
    bad(RecordSaleRequestSchema, { ...request, tenders: [{ method: "CASH", amountMinor: "100000" }] });
    bad(RecordSaleRequestSchema, {
      ...request,
      tenders: [{ method: "CASH", amount: ngn("1"), cashReceived: { amountMinor: 1, currency: "NGN" } }],
    });
    bad(RecordSaleRequestSchema, { ...request, tenders: [{ method: "CHEQUE", amount: ngn("1") }] });
    bad(RecordSaleRequestSchema, {
      ...request,
      tenders: [{ method: "CASH", amount: ngn("1"), reference: "x".repeat(257) }],
    });
    ok(RecordSaleRequestSchema, {
      ...request,
      tenders: [{ method: "CASH", amount: { amountMinor: "1", currency: "USD" } }],
    });
  });

  it("accepts a saleId claim and only ISO device instants", () => {
    ok(RecordSaleRequestSchema, { ...request, saleId: "not-a-uuid" });
    bad(RecordSaleRequestSchema, { ...request, saleId: "x".repeat(65) });
    bad(RecordSaleRequestSchema, { ...request, deviceReportedAt: "yesterday" });
    bad(RecordSaleRequestSchema, { ...request, saleId: undefined });
  });
});

describe("ReverseSaleRequestSchema", () => {
  it("requires a nonblank reason and a boolean confirmation the server checks", () => {
    ok(ReverseSaleRequestSchema, { reason: "Returned", tenderUnwoundConfirmed: true });
    ok(ReverseSaleRequestSchema, { reason: "Returned", tenderUnwoundConfirmed: false });
    ok(ReverseSaleRequestSchema, { reason: "x".repeat(501), tenderUnwoundConfirmed: true });
    bad(ReverseSaleRequestSchema, { reason: "x".repeat(2001), tenderUnwoundConfirmed: true });
    bad(ReverseSaleRequestSchema, { reason: "   ", tenderUnwoundConfirmed: true });
    bad(ReverseSaleRequestSchema, { reason: "Returned" });
    bad(ReverseSaleRequestSchema, { reason: "Returned", tenderUnwoundConfirmed: "true" });
    bad(ReverseSaleRequestSchema, { tenderUnwoundConfirmed: true });
    for (const key of ["amount", "refund", "lines", "locationId", "status", "journalEntryId"]) {
      bad(ReverseSaleRequestSchema, { reason: "Returned", tenderUnwoundConfirmed: true, [key]: "x" });
    }
  });
});

describe("SalePathSchema", () => {
  it("takes the business and sale IDs as claims", () => {
    ok(SalePathSchema, { businessId: "b", saleId: "s" });
    bad(SalePathSchema, { businessId: "b" });
    bad(SalePathSchema, { businessId: "b", saleId: "s", locationId: "l" });
  });
});

describe("SaleResponseSchema", () => {
  it("accepts a sale without cost and a sale with cost", () => {
    ok(SaleResponseSchema, sale);
    ok(SaleResponseSchema, costed);
    ok(SaleResponseSchema, {
      ...costed,
      costStatus: "UNVALUED",
      lines: [{ ...responseLine, costStatus: "UNVALUED", cost: null }],
    });
    ok(SalesResponseSchema, { items: [sale, costed], nextCursor: null });
    ok(SalesResponseSchema, { items: [], nextCursor: "abc" });
  });

  it("shows cost all together or not at all, and never null in place of absent", () => {
    bad(SaleResponseSchema, { ...sale, costStatus: null, cogsTotal: null });
    bad(SaleResponseSchema, { ...sale, costStatus: "VALUED" });
    bad(SaleResponseSchema, { ...sale, cogsTotal: ngn("1") });
    bad(SaleResponseSchema, { ...costed, lines: [responseLine] });
    bad(SaleResponseSchema, { ...sale, lines: [{ ...responseLine, costStatus: "VALUED", cost: ngn("1") }] });
    bad(SaleResponseSchema, { ...costed, lines: [{ ...responseLine, costStatus: "VALUED" }] });
    bad(SaleResponseSchema, { ...costed, lines: [{ ...responseLine, costStatus: "PARTIAL", cost: null }] });
  });

  it("rejects margin, recording metadata and internal IDs", () => {
    for (const key of [
      "margin",
      "marginMinor",
      "recordedByMembershipId",
      "journalEntryId",
      "reversalJournalEntryId",
      "businessId",
      "deviceId",
      "correlationId",
      "sourceChannel",
      "fingerprint",
    ]) {
      bad(SaleResponseSchema, { ...sale, [key]: ID });
    }
    for (const key of ["movementId", "valuationVersionRead", "margin"]) {
      bad(SaleResponseSchema, { ...sale, lines: [{ ...responseLine, [key]: 1 }] });
    }
  });

  it("requires string money in the sale currency and one reversal state", () => {
    bad(SaleResponseSchema, { ...sale, total: { amountMinor: 100000, currency: "NGN" } });
    bad(SaleResponseSchema, { ...sale, total: { amountMinor: "100000", currency: "KES" } });
    bad(SaleResponseSchema, { ...sale, tenders: [{ ...tender, changeGiven: { amountMinor: "0", currency: "KES" } }] });
    bad(SaleResponseSchema, { ...sale, lines: [{ ...responseLine, quantity: { quantityMinor: 2, unit: "PIECE" } }] });
    ok(SaleResponseSchema, {
      ...sale,
      status: "REVERSED",
      reversedAt: AT,
      reversalTenderUnwoundConfirmed: true,
    });
    bad(SaleResponseSchema, { ...sale, status: "REVERSED" });
    bad(SaleResponseSchema, { ...sale, reversedAt: AT });
    bad(SaleResponseSchema, { ...sale, reversalTenderUnwoundConfirmed: false });
    bad(SaleResponseSchema, { ...sale, status: "VOIDED" });
  });

  it("duplicates the domain enums exactly", () => {
    expect(SaleCostStatusWireSchema.options).toEqual(["VALUED", "PARTIAL", "UNVALUED", "NOT_APPLICABLE"]);
    expect(SaleLineCostStatusWireSchema.options).toEqual(["VALUED", "UNVALUED", "NOT_APPLICABLE"]);
    expect(SaleTaxKindWireSchema.options).toEqual(["NONE", "STANDARD", "ZERO_RATED", "EXEMPT"]);
    expect(TenderVerificationStatusWireSchema.options).toEqual(["NOT_APPLICABLE", "NOT_VERIFIED"]);
  });
});

describe("sales error details", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => `0190a000-0000-7000-8000-${(index + 1).toString().padStart(12, "0")}`);

  it("lists unique ascending variant IDs, at most 200", () => {
    for (const schema of [PriceNotSetDetailsSchema, ProductArchivedDetailsSchema]) {
      ok(schema, { variantIds: [ID, ID2] });
      ok(schema, { variantIds: many(200) });
      bad(schema, { variantIds: many(201) });
      bad(schema, { variantIds: [] });
      bad(schema, { variantIds: [ID2, ID] });
      bad(schema, { variantIds: [ID, ID] });
      bad(schema, { variantIds: ["variant"] });
      bad(schema, { variantIds: [ID], businessId: ID });
    }
  });

  it("shows the current price as strings and nothing else", () => {
    const change = { variantId: ID, currentPriceMinor: "60000", currentPriceVersion: 2 };
    ok(PriceChangedDetailsSchema, { changes: [change] });
    bad(PriceChangedDetailsSchema, { changes: [] });
    bad(PriceChangedDetailsSchema, { changes: [{ ...change, currentPriceMinor: 60000 }] });
    bad(PriceChangedDetailsSchema, { changes: [{ ...change, currentPriceMinor: "-1" }] });
    bad(PriceChangedDetailsSchema, { changes: [{ ...change, currentPriceVersion: 0 }] });
    bad(PriceChangedDetailsSchema, { changes: [{ ...change, cost: "1" }] });
    bad(PriceChangedDetailsSchema, { changes: [{ ...change, variantId: ID2 }, change] });
  });

  it("shows availability per variant only for a real shortage", () => {
    ok(InsufficientStockDetailsSchema, { shortages: [{ variantId: ID, availableQuantityMinor: "1" }] });
    ok(InsufficientStockDetailsSchema, { shortages: [{ variantId: ID, availableQuantityMinor: "-3" }] });
    bad(InsufficientStockDetailsSchema, { shortages: [] });
    bad(InsufficientStockDetailsSchema, { shortages: [{ variantId: ID, availableQuantityMinor: 1 }] });
    bad(InsufficientStockDetailsSchema, {
      shortages: [{ variantId: ID, availableQuantityMinor: "1", valueMinor: "1" }],
    });
    bad(InsufficientStockDetailsSchema, {
      shortages: [
        { variantId: ID, availableQuantityMinor: "1" },
        { variantId: ID, availableQuantityMinor: "2" },
      ],
    });
  });

  it("bounds the discount line and the server total", () => {
    ok(DiscountExceedsLineDetailsSchema, { lineNumber: 1 });
    ok(DiscountExceedsLineDetailsSchema, { lineNumber: 200 });
    bad(DiscountExceedsLineDetailsSchema, { lineNumber: 0 });
    bad(DiscountExceedsLineDetailsSchema, { lineNumber: 201 });
    ok(TenderTotalMismatchDetailsSchema, { serverTotalMinor: "100000" });
    bad(TenderTotalMismatchDetailsSchema, { serverTotalMinor: 100000 });
    bad(TenderTotalMismatchDetailsSchema, { serverTotalMinor: "100000", tenderTotalMinor: "1" });
  });

  it("wraps each in the strict error envelope with its own code", () => {
    const message = "conflict";
    ok(PriceNotSetErrorEnvelopeSchema, { error: { code: "PRICE_NOT_SET", message, details: { variantIds: [ID] } } });
    bad(PriceNotSetErrorEnvelopeSchema, { error: { code: "PRICE_CHANGED", message, details: { variantIds: [ID] } } });
    ok(PriceChangedErrorEnvelopeSchema, {
      error: {
        code: "PRICE_CHANGED",
        message,
        details: { changes: [{ variantId: ID, currentPriceMinor: "1", currentPriceVersion: 2 }] },
      },
    });
    ok(ProductArchivedErrorEnvelopeSchema, {
      error: { code: "PRODUCT_ARCHIVED", message, details: { variantIds: [ID] } },
    });
    ok(InsufficientStockErrorEnvelopeSchema, {
      error: {
        code: "INSUFFICIENT_STOCK",
        message,
        details: { shortages: [{ variantId: ID, availableQuantityMinor: "0" }] },
      },
    });
    ok(DiscountExceedsLineErrorEnvelopeSchema, {
      error: { code: "DISCOUNT_EXCEEDS_LINE", message, details: { lineNumber: 1 } },
    });
    ok(TenderTotalMismatchErrorEnvelopeSchema, {
      error: { code: "TENDER_TOTAL_MISMATCH", message, details: { serverTotalMinor: "1" } },
    });
    bad(TenderTotalMismatchErrorEnvelopeSchema, { error: { code: "TENDER_TOTAL_MISMATCH", message } });
  });
});
