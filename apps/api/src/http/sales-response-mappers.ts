import type { Page, SaleLineView, SaleTenderView, SaleView } from "@tali/application";
import {
  type MoneyWire,
  type SaleDiscountWire,
  type SaleLineResponse,
  type SaleResponse,
  SaleResponseSchema,
  type SalesResponse,
  SalesResponseSchema,
  type SaleTenderResponse,
} from "@tali/shared";

/**
 * Sale views to wire DTOs (ADR-011, plan 005 Slice 6). Each mapper builds a
 * fresh object from the fields it names, writes every amount as MoneyWire in
 * the sale currency and every absent optional field as an explicit null, and
 * parses the result with the strict shared schema. Cost fields exist only when
 * the application included them (`inventory:cost-read`); otherwise they are
 * absent, never null. The recording membership, journal entry IDs, movement
 * IDs and valuation versions read never reach the wire, and neither does margin.
 */

function money(amountMinor: string, currency: string): MoneyWire {
  return { amountMinor, currency };
}

function discount(line: SaleLineView, currency: string): SaleDiscountWire {
  switch (line.discountKind) {
    case "NONE":
      return { kind: "NONE" };
    case "FIXED":
      return { kind: "FIXED", amount: money(line.discountValue, currency) };
    case "BASIS_POINTS":
      return { kind: "BASIS_POINTS", basisPoints: Number.parseInt(line.discountValue, 10) };
  }
}

function line(view: SaleLineView, currency: string): SaleLineResponse {
  return {
    lineNumber: view.lineNumber,
    variantId: view.variantId,
    productName: view.productName,
    sku: view.sku ?? null,
    tracked: view.tracked,
    quantity: { quantityMinor: view.quantityMinor, unit: view.unit },
    unitScale: view.unitScale,
    unitPrice: money(view.unitPriceMinor, currency),
    priceVersion: view.priceVersion,
    gross: money(view.grossMinor, currency),
    discount: discount(view, currency),
    discountAmount: money(view.discountMinor, currency),
    net: money(view.netMinor, currency),
    taxKind: view.taxKind,
    tax: money(view.taxMinor, currency),
    total: money(view.totalMinor, currency),
    ...(view.costStatus === undefined
      ? {}
      : {
          costStatus: view.costStatus,
          cost: view.costMinor === undefined ? null : money(view.costMinor, currency),
        }),
  };
}

function tender(view: SaleTenderView, currency: string): SaleTenderResponse {
  return {
    tenderNumber: view.tenderNumber,
    method: view.method,
    amount: money(view.amountMinor, currency),
    reference: view.reference ?? null,
    verificationStatus: view.verificationStatus,
    cashReceived: view.cashReceivedMinor === undefined ? null : money(view.cashReceivedMinor, currency),
    changeGiven: view.changeGivenMinor === undefined ? null : money(view.changeGivenMinor, currency),
  };
}

function sale(view: SaleView): SaleResponse {
  const currency = view.currency;
  return {
    saleId: view.saleId,
    locationId: view.locationId,
    receiptNumber: view.receiptNumber,
    status: view.status,
    currency,
    grossTotal: money(view.grossTotalMinor, currency),
    discountTotal: money(view.discountTotalMinor, currency),
    taxTotal: money(view.taxTotalMinor, currency),
    total: money(view.totalMinor, currency),
    ...(view.costStatus === undefined ? {} : { costStatus: view.costStatus }),
    ...(view.cogsTotalMinor === undefined ? {} : { cogsTotal: money(view.cogsTotalMinor, currency) }),
    occurredAt: view.occurredAt,
    businessDate: view.businessDate,
    recordedAt: view.recordedAt,
    deviceReportedAt: view.deviceReportedAt ?? null,
    reversedAt: view.reversedAt ?? null,
    reversalTenderUnwoundConfirmed: view.reversalTenderUnwoundConfirmed ?? null,
    lines: view.lines.map((item) => line(item, currency)),
    tenders: view.tenders.map((item) => tender(item, currency)),
  };
}

export function toSaleResponse(view: SaleView): SaleResponse {
  return SaleResponseSchema.parse(sale(view));
}

export function toSalesResponse(page: Page<SaleView>): SalesResponse {
  return SalesResponseSchema.parse({ items: page.items.map(sale), nextCursor: page.nextCursor });
}
