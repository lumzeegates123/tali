import type { Sale, SaleLine, SaleTender } from "@tali/domain";

/**
 * Cost and COGS are omitted entirely without `inventory:cost-read` (ADR-011
 * section 20, M6). Margin is not included: ADR-011 does not define an exact
 * margin formula. Display of margin is an S7 concern, and only when
 * `costStatus` is VALUED.
 */
export interface SaleLineView {
  readonly lineNumber: number;
  readonly variantId: string;
  readonly productName: string;
  readonly sku?: string;
  readonly tracked: boolean;
  readonly quantityMinor: string;
  readonly unit: string;
  readonly unitScale: number;
  readonly unitPriceMinor: string;
  readonly priceVersion: number;
  readonly grossMinor: string;
  readonly discountKind: SaleLine["discountKind"];
  readonly discountValue: string;
  readonly discountMinor: string;
  readonly netMinor: string;
  readonly taxKind: SaleLine["tax"]["taxKind"];
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly costStatus?: SaleLine["costStatus"];
  readonly costMinor?: string;
  readonly valuationVersionRead?: number;
  readonly movementId?: string;
}

export interface SaleTenderView {
  readonly tenderNumber: number;
  readonly method: SaleTender["method"];
  readonly amountMinor: string;
  readonly reference?: string;
  readonly verificationStatus: SaleTender["verificationStatus"];
  readonly cashReceivedMinor?: string;
  readonly changeGivenMinor?: string;
}

export interface SaleView {
  readonly saleId: string;
  readonly locationId: string;
  readonly receiptNumber: string;
  readonly status: Sale["status"];
  readonly currency: string;
  readonly grossTotalMinor: string;
  readonly discountTotalMinor: string;
  readonly taxTotalMinor: string;
  readonly totalMinor: string;
  readonly costStatus?: Sale["costStatus"];
  readonly cogsTotalMinor?: string;
  readonly recordedByMembershipId: string;
  readonly occurredAt: string;
  readonly businessDate: string;
  readonly recordedAt: string;
  readonly deviceReportedAt?: string;
  readonly journalEntryId?: string;
  readonly reversedAt?: string;
  readonly reversalJournalEntryId?: string;
  readonly reversalTenderUnwoundConfirmed?: true;
  readonly lines: readonly SaleLineView[];
  readonly tenders: readonly SaleTenderView[];
}

export function presentSale(sale: Sale, includeCost: boolean): SaleView {
  return {
    saleId: sale.id,
    locationId: sale.locationId,
    receiptNumber: sale.receiptNumber,
    status: sale.status,
    currency: sale.currency,
    grossTotalMinor: sale.grossTotal.toMinorUnitsString(),
    discountTotalMinor: sale.discountTotal.toMinorUnitsString(),
    taxTotalMinor: sale.taxTotal.toMinorUnitsString(),
    totalMinor: sale.total.toMinorUnitsString(),
    ...(includeCost ? { costStatus: sale.costStatus, cogsTotalMinor: sale.cogsTotal.toMinorUnitsString() } : {}),
    recordedByMembershipId: sale.recordedByMembershipId,
    occurredAt: sale.occurredAt.toISOString(),
    businessDate: sale.businessDate.toString(),
    recordedAt: sale.recordedAt.toISOString(),
    ...(sale.deviceReportedAt === undefined ? {} : { deviceReportedAt: sale.deviceReportedAt.toISOString() }),
    ...(sale.journalEntryId === undefined ? {} : { journalEntryId: sale.journalEntryId }),
    ...(sale.reversedAt === undefined ? {} : { reversedAt: sale.reversedAt.toISOString() }),
    ...(sale.reversalJournalEntryId === undefined ? {} : { reversalJournalEntryId: sale.reversalJournalEntryId }),
    ...(sale.reversalTenderUnwoundConfirmed === undefined
      ? {}
      : { reversalTenderUnwoundConfirmed: sale.reversalTenderUnwoundConfirmed }),
    lines: sale.lines.map((line) => presentLine(line, includeCost)),
    tenders: sale.tenders.map(presentTender),
  };
}

function presentLine(line: SaleLine, includeCost: boolean): SaleLineView {
  return {
    lineNumber: line.lineNumber,
    variantId: line.variantId,
    productName: line.productName,
    ...(line.sku === undefined ? {} : { sku: line.sku }),
    tracked: line.tracked,
    quantityMinor: line.quantity.toMinorUnitsString(),
    unit: line.quantity.unit,
    unitScale: line.unitScale,
    unitPriceMinor: line.unitPrice.toMinorUnitsString(),
    priceVersion: line.priceVersion,
    grossMinor: line.gross.toMinorUnitsString(),
    discountKind: line.discountKind,
    discountValue: line.discountValue.toString(),
    discountMinor: line.discountAmount.toMinorUnitsString(),
    netMinor: line.net.toMinorUnitsString(),
    taxKind: line.tax.taxKind,
    taxMinor: line.taxAmount.toMinorUnitsString(),
    totalMinor: line.total.toMinorUnitsString(),
    ...(includeCost
      ? {
          costStatus: line.costStatus,
          ...(line.cost === undefined ? {} : { costMinor: line.cost.toMinorUnitsString() }),
          ...(line.valuationVersionRead === undefined ? {} : { valuationVersionRead: line.valuationVersionRead }),
        }
      : {}),
    ...(line.movementId === undefined ? {} : { movementId: line.movementId }),
  };
}

function presentTender(tender: SaleTender): SaleTenderView {
  return {
    tenderNumber: tender.tenderNumber,
    method: tender.method,
    amountMinor: tender.amount.toMinorUnitsString(),
    ...(tender.reference === undefined ? {} : { reference: tender.reference }),
    verificationStatus: tender.verificationStatus,
    ...(tender.cashReceived === undefined ? {} : { cashReceivedMinor: tender.cashReceived.toMinorUnitsString() }),
    ...(tender.changeGiven === undefined ? {} : { changeGivenMinor: tender.changeGiven.toMinorUnitsString() }),
  };
}
