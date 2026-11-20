import type {
  AccountBalanceResponse,
  LedgerAccountResponse,
  SaleLineResponse,
  SaleResponse,
  SaleTenderResponse,
} from "@tali/shared";

const INSTANT = "2026-11-03T08:00:00.000Z";
const DATE = "2026-11-03";
export const SALE_LOCATION_ID = "0190a000-0000-7000-8000-0000000002aa";

let sequence = 0;
export function salesId(): string {
  sequence += 1;
  return `0190a000-0000-7000-8000-${(0xd00000 + sequence).toString(16).padStart(12, "0")}`;
}

const ngn = (amountMinor: string) => ({ amountMinor, currency: "NGN" });

export function saleLine(overrides: Partial<SaleLineResponse> = {}): SaleLineResponse {
  return {
    lineNumber: 1,
    variantId: salesId(),
    productName: "Peak Milk 400g",
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
    ...overrides,
  };
}

export function cashTender(overrides: Partial<SaleTenderResponse> = {}): SaleTenderResponse {
  return {
    tenderNumber: 1,
    method: "CASH",
    amount: ngn("100000"),
    reference: null,
    verificationStatus: "NOT_APPLICABLE",
    cashReceived: ngn("150000"),
    changeGiven: ngn("50000"),
    ...overrides,
  };
}

export function saleFixture(overrides: Partial<SaleResponse> = {}): SaleResponse {
  return {
    saleId: salesId(),
    locationId: SALE_LOCATION_ID,
    receiptNumber: "R-000001",
    status: "POSTED",
    currency: "NGN",
    grossTotal: ngn("100000"),
    discountTotal: ngn("0"),
    taxTotal: ngn("0"),
    total: ngn("100000"),
    occurredAt: INSTANT,
    businessDate: DATE,
    recordedAt: INSTANT,
    deviceReportedAt: null,
    reversedAt: null,
    reversalTenderUnwoundConfirmed: null,
    lines: [saleLine()],
    tenders: [cashTender()],
    ...overrides,
  };
}

/** A sale as a cost-read role sees it: sale and line cost fields together. */
export function costedSale(
  costStatus: "VALUED" | "PARTIAL" | "UNVALUED" | "NOT_APPLICABLE",
  overrides: Partial<SaleResponse> = {},
): SaleResponse {
  const lineStatus = costStatus === "PARTIAL" ? "UNVALUED" : costStatus;
  return saleFixture({
    costStatus,
    cogsTotal: ngn(costStatus === "VALUED" ? "60000" : "0"),
    lines: [
      saleLine({
        costStatus: lineStatus,
        cost: lineStatus === "VALUED" ? ngn("60000") : null,
      }),
    ],
    ...overrides,
  });
}

export function ledgerAccount(overrides: Partial<LedgerAccountResponse> = {}): LedgerAccountResponse {
  return {
    accountId: salesId(),
    code: "1000",
    name: "Cash on hand",
    type: "ASSET",
    normalBalance: "DEBIT",
    systemRole: "CASH_ON_HAND",
    templateVersion: 1,
    status: "ACTIVE",
    ...overrides,
  };
}

export function accountBalance(overrides: Partial<AccountBalanceResponse> = {}): AccountBalanceResponse {
  return {
    accountId: salesId(),
    systemRole: "CASH_ON_HAND",
    code: "1000",
    name: "Cash on hand",
    debitTotal: ngn("100000"),
    creditTotal: ngn("0"),
    balance: ngn("100000"),
    ...overrides,
  };
}
