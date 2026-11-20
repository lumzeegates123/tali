import type { CurrencyDefinition } from "@tali/domain/kernel";
import type { SaleLineResponse, SaleResponse, UnitResponse } from "@tali/shared";
import { Text, View } from "react-native";
import { formatMoney } from "../catalog/money-format";
import { formatInstant, formatQuantity } from "../inventory/inventory-format";
import { styles } from "../onboarding/ui";
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
    <View style={styles.screen}>
      <Text testID="sale-receipt-number">Receipt number: {sale.receiptNumber}</Text>
      <Text testID="sale-status">Status: {SALE_STATUS_LABEL[sale.status]}</Text>
      <Text>Recorded: {formatInstant(sale.recordedAt)}</Text>
      <Text>Business date: {sale.businessDate}</Text>
      {sale.reversedAt === null ? null : <Text>Reversed: {formatInstant(sale.reversedAt)}</Text>}
      {sale.lines.map((line) => {
        const discount = discountText(line, currency);
        const cost = lineCostText(line, currency);
        return (
          <View key={line.lineNumber} style={styles.card} accessible accessibilityLabel={`Line ${line.productName}`}>
            <Text style={styles.strong}>{line.productName}</Text>
            {line.sku === null ? null : <Text>SKU: {line.sku}</Text>}
            <Text>
              {formatQuantity(line.quantity, units)} × {formatMoney(line.unitPrice, currency)}
            </Text>
            {discount === undefined ? null : <Text>{discount}</Text>}
            <Text>Line total: {formatMoney(line.total, currency)}</Text>
            {cost === undefined ? null : <Text>{cost}</Text>}
          </View>
        );
      })}
      <Text>Subtotal: {formatMoney(sale.grossTotal, currency)}</Text>
      <Text>Discounts: {formatMoney(sale.discountTotal, currency)}</Text>
      <Text>Tax: {formatMoney(sale.taxTotal, currency)}</Text>
      <Text style={styles.strong} testID="sale-total">
        Total: {formatMoney(sale.total, currency)}
      </Text>
      {sale.cogsTotal === undefined ? null : (
        <Text testID="sale-cogs">Cost of goods sold: {formatMoney(sale.cogsTotal, currency)}</Text>
      )}
      {disclosure.length === 0 ? null : (
        <View style={styles.notice}>
          {disclosure.map((text) => (
            <Text key={text}>{text}</Text>
          ))}
        </View>
      )}
      {sale.tenders.map((tender) => (
        <View key={tender.tenderNumber} style={styles.card}>
          <Text style={styles.strong}>
            {TENDER_LABEL[tender.method]}: {formatMoney(tender.amount, currency)}
          </Text>
          {tender.verificationStatus === "NOT_VERIFIED" ? (
            <>
              <Text style={styles.strong}>Not verified</Text>
              <Text style={styles.hint}>{NOT_VERIFIED_HINT}</Text>
            </>
          ) : null}
          {tender.reference === null ? null : <Text>Reference: {tender.reference}</Text>}
          {tender.cashReceived === null ? null : (
            <Text>Cash received: {formatMoney(tender.cashReceived, currency)}</Text>
          )}
          {tender.changeGiven === null ? null : <Text>Change: {formatMoney(tender.changeGiven, currency)}</Text>}
        </View>
      ))}
    </View>
  );
}
