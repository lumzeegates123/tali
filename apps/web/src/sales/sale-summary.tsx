"use client";

import type { CurrencyDefinition } from "@tali/domain/kernel";
import type { SaleLineResponse, SaleResponse, SaleTenderResponse, UnitResponse } from "@tali/shared";
import { formatMoney } from "../catalog/money-format";
import { formatInstant, formatQuantity } from "../inventory/inventory-format";
import { basisPointsText, TENDER_LABEL } from "./sale-draft";

export const SALE_STATUS_LABEL: Readonly<Record<SaleResponse["status"], string>> = {
  POSTED: "Posted",
  REVERSED: "Reversed",
};

export const NOT_VERIFIED_HINT =
  "Tali has not checked this payment with a bank or payment provider. It is recorded as the cashier entered it.";

/** The cost disclosure of one line; amounts only as the API returned them. */
export function lineCostText(line: SaleLineResponse, currency: CurrencyDefinition | undefined): string | undefined {
  switch (line.costStatus) {
    case undefined:
      return undefined;
    case "UNVALUED":
      return "Cost unknown";
    case "NOT_APPLICABLE":
      return "Cost not applicable";
    case "VALUED":
      return line.cost === null || line.cost === undefined
        ? "Cost unknown"
        : `Cost: ${formatMoney(line.cost, currency)}`;
  }
}

/**
 * What the sale says about margin. Tali never computes a margin here; a
 * PARTIAL or UNVALUED sale says the margin is incomplete.
 */
export function saleCostDisclosure(sale: SaleResponse): readonly string[] {
  switch (sale.costStatus) {
    case "PARTIAL":
      return ["Margin incomplete", "Some item costs are unknown."];
    case "UNVALUED":
      return ["Margin incomplete", "Cost unknown for this sale."];
    case "NOT_APPLICABLE":
      return ["Cost not applicable"];
    case "VALUED":
    case undefined:
      return [];
  }
}

function discountText(line: SaleLineResponse, currency: CurrencyDefinition | undefined): string | undefined {
  switch (line.discount.kind) {
    case "NONE":
      return undefined;
    case "FIXED":
      return `Discount ${formatMoney(line.discount.amount, currency)}: ${formatMoney(line.discountAmount, currency)}`;
    case "BASIS_POINTS":
      return `Discount ${basisPointsText(line.discount.basisPoints)}: ${formatMoney(line.discountAmount, currency)}`;
  }
}

function TenderRow({
  tender,
  currency,
}: {
  readonly tender: SaleTenderResponse;
  readonly currency: CurrencyDefinition | undefined;
}) {
  return (
    <li className="catalog-row">
      <span className="catalog-name">{TENDER_LABEL[tender.method]}</span>
      <span>{formatMoney(tender.amount, currency)}</span>
      {tender.verificationStatus === "NOT_VERIFIED" ? (
        <span>
          <strong>Not verified</strong> <span className="hint">{NOT_VERIFIED_HINT}</span>
        </span>
      ) : null}
      {tender.reference === null ? null : <span>Reference: {tender.reference}</span>}
      {tender.cashReceived === null ? null : <span>Cash received: {formatMoney(tender.cashReceived, currency)}</span>}
      {tender.changeGiven === null ? null : <span>Change: {formatMoney(tender.changeGiven, currency)}</span>}
    </li>
  );
}

/** A recorded sale exactly as the API returned it: the receipt and the sale detail. */
export function SaleSummary({
  sale,
  currency,
  units,
}: {
  readonly sale: SaleResponse;
  readonly currency: CurrencyDefinition | undefined;
  readonly units: readonly UnitResponse[];
}) {
  const disclosure = saleCostDisclosure(sale);
  return (
    <div className="sale-summary">
      <dl>
        <dt>Receipt number</dt>
        <dd>{sale.receiptNumber}</dd>
        <dt>Status</dt>
        <dd>{SALE_STATUS_LABEL[sale.status]}</dd>
        <dt>Recorded</dt>
        <dd>{formatInstant(sale.recordedAt)}</dd>
        <dt>Business date</dt>
        <dd>{sale.businessDate}</dd>
        {sale.reversedAt === null ? null : (
          <>
            <dt>Reversed</dt>
            <dd>{formatInstant(sale.reversedAt)}</dd>
          </>
        )}
      </dl>
      <ul className="catalog-list" aria-label="Sale lines">
        {sale.lines.map((line) => {
          const discount = discountText(line, currency);
          const cost = lineCostText(line, currency);
          return (
            <li key={line.lineNumber} className="catalog-row">
              <span className="catalog-name">{line.productName}</span>
              {line.sku === null ? null : <span>SKU: {line.sku}</span>}
              <span>
                {formatQuantity(line.quantity, units)} × {formatMoney(line.unitPrice, currency)}
              </span>
              {discount === undefined ? null : <span>{discount}</span>}
              <span>Line total: {formatMoney(line.total, currency)}</span>
              {cost === undefined ? null : <span>{cost}</span>}
            </li>
          );
        })}
      </ul>
      <dl aria-label="Sale totals">
        <dt>Subtotal</dt>
        <dd>{formatMoney(sale.grossTotal, currency)}</dd>
        <dt>Discounts</dt>
        <dd>{formatMoney(sale.discountTotal, currency)}</dd>
        <dt>Tax</dt>
        <dd>{formatMoney(sale.taxTotal, currency)}</dd>
        <dt>Total</dt>
        <dd>{formatMoney(sale.total, currency)}</dd>
        {sale.cogsTotal === undefined ? null : (
          <>
            <dt>Cost of goods sold</dt>
            <dd>{formatMoney(sale.cogsTotal, currency)}</dd>
          </>
        )}
      </dl>
      {disclosure.length === 0 ? null : (
        <div role="note" className="notice">
          {disclosure.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      )}
      <ul className="catalog-list" aria-label="Tenders">
        {sale.tenders.map((tender) => (
          <TenderRow key={tender.tenderNumber} tender={tender} currency={currency} />
        ))}
      </ul>
    </div>
  );
}
