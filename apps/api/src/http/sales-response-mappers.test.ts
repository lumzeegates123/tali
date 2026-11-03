import type { SaleLineView, SaleView } from "@tali/application";
import {
  DISCOUNT_KINDS,
  INVENTORY_MOVEMENT_TYPES,
  MAX_DISCOUNT_BASIS_POINTS,
  MAX_SALE_LINES,
  MAX_SALE_TENDERS,
  SALE_COST_STATUSES,
  SALE_LINE_COST_STATUSES,
  SALE_STATUSES,
  SALE_TAX_KINDS,
  TENDER_METHODS,
  TENDER_VERIFICATION_STATUSES,
} from "@tali/domain";
import {
  InventoryMovementSourceKindWireSchema,
  InventoryMovementTypeWireSchema,
  SaleCostStatusWireSchema,
  SaleDiscountWireSchema,
  SaleLineCostStatusWireSchema,
  SaleResponseSchema,
  SalesResponseSchema,
  SaleStatusWireSchema,
  SaleTaxKindWireSchema,
  TenderMethodWireSchema,
  TenderVerificationStatusWireSchema,
} from "@tali/shared";
import { describe, expect, it } from "vitest";
import { toSaleResponse, toSalesResponse } from "./sales-response-mappers.js";

const SALE = "019a0000-0000-7000-8000-0000000000a1";
const LOCATION = "019a0000-0000-7000-8000-0000000000a2";
const VARIANT = "019a0000-0000-7000-8000-0000000000a3";
const MEMBER = "019a0000-0000-7000-8000-0000000000a4";
const JOURNAL = "019a0000-0000-7000-8000-0000000000a5";
const MOVEMENT = "019a0000-0000-7000-8000-0000000000a6";
const AT = "2026-11-02T08:00:00.000Z";

const LINE: SaleLineView = {
  lineNumber: 1,
  variantId: VARIANT,
  productName: "Soap",
  tracked: true,
  quantityMinor: "2",
  unit: "PIECE",
  unitScale: 0,
  unitPriceMinor: "50000",
  priceVersion: 1,
  grossMinor: "100000",
  discountKind: "NONE",
  discountValue: "0",
  discountMinor: "0",
  netMinor: "100000",
  taxKind: "NONE",
  taxMinor: "0",
  totalMinor: "100000",
  movementId: MOVEMENT,
};

const VIEW: SaleView = {
  saleId: SALE,
  locationId: LOCATION,
  receiptNumber: "S-000001",
  status: "POSTED",
  currency: "NGN",
  grossTotalMinor: "100000",
  discountTotalMinor: "0",
  taxTotalMinor: "0",
  totalMinor: "100000",
  recordedByMembershipId: MEMBER,
  occurredAt: AT,
  businessDate: "2026-11-02",
  recordedAt: AT,
  journalEntryId: JOURNAL,
  lines: [LINE],
  tenders: [{ tenderNumber: 1, method: "CASH", amountMinor: "100000", verificationStatus: "NOT_APPLICABLE" }],
};

const COSTED: SaleView = {
  ...VIEW,
  costStatus: "PARTIAL",
  cogsTotalMinor: "70000",
  lines: [
    { ...LINE, costStatus: "VALUED", costMinor: "70000", valuationVersionRead: 3 },
    { ...LINE, lineNumber: 2, tracked: false, costStatus: "NOT_APPLICABLE" },
  ],
};

const FORBIDDEN = [
  "recordedByMembershipId",
  "journalEntryId",
  "reversalJournalEntryId",
  "movementId",
  "valuationVersionRead",
  "businessId",
  "deviceId",
  "correlationId",
  "sourceChannel",
  "fingerprint",
  "margin",
];

function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keysDeep(item, into);
    }
  }
  return into;
}

describe("toSaleResponse", () => {
  it("writes the public sale as MoneyWire in the sale currency with explicit nulls", () => {
    expect(toSaleResponse(VIEW)).toEqual({
      saleId: SALE,
      locationId: LOCATION,
      receiptNumber: "S-000001",
      status: "POSTED",
      currency: "NGN",
      grossTotal: { amountMinor: "100000", currency: "NGN" },
      discountTotal: { amountMinor: "0", currency: "NGN" },
      taxTotal: { amountMinor: "0", currency: "NGN" },
      total: { amountMinor: "100000", currency: "NGN" },
      occurredAt: AT,
      businessDate: "2026-11-02",
      recordedAt: AT,
      deviceReportedAt: null,
      reversedAt: null,
      reversalTenderUnwoundConfirmed: null,
      lines: [
        {
          lineNumber: 1,
          variantId: VARIANT,
          productName: "Soap",
          sku: null,
          tracked: true,
          quantity: { quantityMinor: "2", unit: "PIECE" },
          unitScale: 0,
          unitPrice: { amountMinor: "50000", currency: "NGN" },
          priceVersion: 1,
          gross: { amountMinor: "100000", currency: "NGN" },
          discount: { kind: "NONE" },
          discountAmount: { amountMinor: "0", currency: "NGN" },
          net: { amountMinor: "100000", currency: "NGN" },
          taxKind: "NONE",
          tax: { amountMinor: "0", currency: "NGN" },
          total: { amountMinor: "100000", currency: "NGN" },
        },
      ],
      tenders: [
        {
          tenderNumber: 1,
          method: "CASH",
          amount: { amountMinor: "100000", currency: "NGN" },
          reference: null,
          verificationStatus: "NOT_APPLICABLE",
          cashReceived: null,
          changeGiven: null,
        },
      ],
    });
  });

  it("leaves cost fields absent, not null, when the view has none", () => {
    const body = toSaleResponse(VIEW);
    expect(body).not.toHaveProperty("costStatus");
    expect(body).not.toHaveProperty("cogsTotal");
    expect(body.lines[0]).not.toHaveProperty("costStatus");
    expect(body.lines[0]).not.toHaveProperty("cost");
  });

  it("shows cost with cost-read, with a null cost for a line without one", () => {
    const body = toSaleResponse(COSTED);
    expect(body).toMatchObject({ costStatus: "PARTIAL", cogsTotal: { amountMinor: "70000", currency: "NGN" } });
    expect(body.lines[0]).toMatchObject({ costStatus: "VALUED", cost: { amountMinor: "70000", currency: "NGN" } });
    expect(body.lines[1]).toMatchObject({ costStatus: "NOT_APPLICABLE", cost: null });
  });

  it("never writes recording metadata, internal IDs or margin", () => {
    const keys = keysDeep([toSaleResponse(VIEW), toSaleResponse(COSTED)]);
    for (const key of FORBIDDEN) expect(keys.has(key)).toBe(false);
  });

  it("maps each discount kind and the cash, reference and reversal fields", () => {
    const body = toSaleResponse({
      ...VIEW,
      status: "REVERSED",
      deviceReportedAt: AT,
      reversedAt: AT,
      reversalJournalEntryId: JOURNAL,
      reversalTenderUnwoundConfirmed: true,
      lines: [
        { ...LINE, sku: "SKU-1", discountKind: "FIXED", discountValue: "1000", discountMinor: "1000" },
        { ...LINE, lineNumber: 2, discountKind: "BASIS_POINTS", discountValue: "250", discountMinor: "2500" },
      ],
      tenders: [
        {
          tenderNumber: 1,
          method: "CASH",
          amountMinor: "90000",
          verificationStatus: "NOT_APPLICABLE",
          cashReceivedMinor: "100000",
          changeGivenMinor: "10000",
        },
        {
          tenderNumber: 2,
          method: "BANK_TRANSFER",
          amountMinor: "10000",
          reference: "TRF-1",
          verificationStatus: "NOT_VERIFIED",
        },
      ],
    });
    expect(body).toMatchObject({ status: "REVERSED", reversedAt: AT, reversalTenderUnwoundConfirmed: true });
    expect(body.deviceReportedAt).toBe(AT);
    expect(body.lines.map((line) => line.discount)).toEqual([
      { kind: "FIXED", amount: { amountMinor: "1000", currency: "NGN" } },
      { kind: "BASIS_POINTS", basisPoints: 250 },
    ]);
    expect(body.lines[0]?.sku).toBe("SKU-1");
    expect(body.tenders[0]).toMatchObject({
      cashReceived: { amountMinor: "100000", currency: "NGN" },
      changeGiven: { amountMinor: "10000", currency: "NGN" },
      reference: null,
    });
    expect(body.tenders[1]).toMatchObject({
      reference: "TRF-1",
      cashReceived: null,
      verificationStatus: "NOT_VERIFIED",
    });
  });

  it("refuses a view that breaks the shared contract instead of sending it", () => {
    expect(() => toSaleResponse({ ...VIEW, costStatus: "VALUED" })).toThrow();
    expect(() => toSaleResponse({ ...VIEW, totalMinor: "1.5" })).toThrow();
    expect(() => toSaleResponse({ ...VIEW, status: "REVERSED" })).toThrow();
  });

  it("maps a page and its cursor", () => {
    const page = toSalesResponse({ items: [VIEW, COSTED], nextCursor: "cursor" });
    expect(SalesResponseSchema.parse(page)).toEqual(page);
    expect(page.nextCursor).toBe("cursor");
    expect(toSalesResponse({ items: [], nextCursor: null }).nextCursor).toBeNull();
    expect(SaleResponseSchema.safeParse(page.items[0]).success).toBe(true);
  });
});

describe("sales wire enums match the domain", () => {
  it("duplicates every sales enum and bound exactly", () => {
    expect(TenderMethodWireSchema.options).toEqual([...TENDER_METHODS]);
    expect(TenderVerificationStatusWireSchema.options).toEqual([...TENDER_VERIFICATION_STATUSES]);
    expect(SaleStatusWireSchema.options).toEqual([...SALE_STATUSES]);
    expect(SaleCostStatusWireSchema.options).toEqual([...SALE_COST_STATUSES]);
    expect(SaleLineCostStatusWireSchema.options).toEqual([...SALE_LINE_COST_STATUSES]);
    expect(SaleTaxKindWireSchema.options).toEqual([...SALE_TAX_KINDS]);
    expect(SaleDiscountWireSchema.options.map((option) => option.shape.kind.value)).toEqual([...DISCOUNT_KINDS]);
    expect(InventoryMovementTypeWireSchema.options).toEqual([...INVENTORY_MOVEMENT_TYPES]);
    expect(InventoryMovementSourceKindWireSchema.options).toContain("SALE");
    const discounted = (basisPoints: number) =>
      SaleDiscountWireSchema.safeParse({ kind: "BASIS_POINTS", basisPoints }).success;
    expect(discounted(MAX_DISCOUNT_BASIS_POINTS)).toBe(true);
    expect(discounted(MAX_DISCOUNT_BASIS_POINTS + 1)).toBe(false);
    const lines = (count: number) =>
      SaleResponseSchema.safeParse({
        ...toSaleResponse(VIEW),
        lines: Array.from({ length: count }, () => toSaleResponse(VIEW).lines[0]),
      }).success;
    expect(lines(MAX_SALE_LINES)).toBe(true);
    expect(lines(MAX_SALE_LINES + 1)).toBe(false);
    const tenders = (count: number) =>
      SaleResponseSchema.safeParse({
        ...toSaleResponse(VIEW),
        tenders: Array.from({ length: count }, () => toSaleResponse(VIEW).tenders[0]),
      }).success;
    expect(tenders(MAX_SALE_TENDERS)).toBe(true);
    expect(tenders(MAX_SALE_TENDERS + 1)).toBe(false);
  });
});
