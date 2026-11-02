import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";
import { RoundingMode } from "../../kernel/rounding.js";
import { assertTaxSnapshot, type SaleTaxPricingMode, type SaleTaxSnapshot } from "./tax.js";

export const DISCOUNT_KINDS = ["NONE", "FIXED", "BASIS_POINTS"] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export const MAX_DISCOUNT_BASIS_POINTS = 9999;

export type LineDiscount =
  | { readonly kind: "NONE" }
  | { readonly kind: "FIXED"; readonly amount: Money }
  | { readonly kind: "BASIS_POINTS"; readonly basisPoints: number };

/**
 * gross = unit_price * quantity_minor / 10^unit_scale, rounded HALF_EVEN once
 * (ADR-011 section 10; ADR-009 A19).
 */
export function lineGross(unitPrice: Money, quantityMinor: bigint, unitScale: number): Money {
  if (quantityMinor <= 0n) {
    throw new DomainError("INVALID_VALUE", "sale quantity must be positive", "quantity");
  }
  if (!Number.isSafeInteger(unitScale) || unitScale < 0 || unitScale > 3) {
    throw new DomainError("INVALID_VALUE", "unit scale must be an integer from 0 to 3", "unitScale");
  }
  const denominator = 10n ** BigInt(unitScale);
  return unitPrice.multiplyByFraction(quantityMinor, denominator, RoundingMode.HALF_EVEN);
}

/**
 * Line discount strictly below the gross (ADR-011 section 11). A basis-point
 * discount that rounds to the gross is rejected. A rounded zero is allowed:
 * the net stays equal to the gross and remains positive.
 */
export function lineDiscountAmount(gross: Money, discount: LineDiscount): Money {
  if (!gross.isPositive()) {
    throw new DomainError("INVALID_VALUE", "line gross must be positive", "gross");
  }
  if (discount.kind === "NONE") return Money.zero(gross.currency);
  if (discount.kind === "FIXED") {
    if (discount.amount.currency !== gross.currency) {
      throw new DomainError("INVALID_VALUE", "discount currency must match the line", "discount");
    }
    if (discount.amount.amountMinor <= 0n || discount.amount.amountMinor >= gross.amountMinor) {
      throw new DomainError(
        "INVALID_VALUE",
        "a fixed discount must be greater than zero and less than the line gross",
        "discount",
      );
    }
    return discount.amount;
  }
  if (
    !Number.isSafeInteger(discount.basisPoints) ||
    discount.basisPoints < 1 ||
    discount.basisPoints > MAX_DISCOUNT_BASIS_POINTS
  ) {
    throw new DomainError("INVALID_VALUE", "discount basis points must be an integer from 1 to 9999", "discount");
  }
  const amount = gross.multiplyByFraction(BigInt(discount.basisPoints), 10_000n, RoundingMode.HALF_EVEN);
  if (amount.amountMinor >= gross.amountMinor) {
    throw new DomainError("INVALID_VALUE", "a rounded discount must stay below the line gross", "discount");
  }
  return amount;
}

export function discountValueOf(discount: LineDiscount): bigint {
  if (discount.kind === "NONE") return 0n;
  if (discount.kind === "FIXED") return discount.amount.amountMinor;
  return BigInt(discount.basisPoints);
}

export interface PricedSaleLineAmounts {
  readonly gross: Money;
  readonly discountAmount: Money;
  readonly net: Money;
  readonly tax: SaleTaxSnapshot;
  readonly taxAmount: Money;
  readonly total: Money;
}

/** net = gross - discount. NONE tax: total = net. Exclusive: total = net + tax. Inclusive: total = net. */
export function priceSaleLine(gross: Money, discount: LineDiscount, tax: SaleTaxSnapshot): PricedSaleLineAmounts {
  assertTaxSnapshot(tax, gross.currency);
  const discountAmount = lineDiscountAmount(gross, discount);
  const net = gross.subtract(discountAmount);
  if (!net.isPositive()) {
    throw new DomainError("INVALID_VALUE", "every sale line net must be positive", "net");
  }
  if (!tax.taxableBase.equals(net)) {
    throw new DomainError("INVALID_VALUE", "taxable base must equal the line net", "taxableBase");
  }
  const total = lineTotal(net, tax);
  if (!total.isPositive()) {
    throw new DomainError("INVALID_VALUE", "every sale line total must be positive", "total");
  }
  return Object.freeze({
    gross,
    discountAmount,
    net,
    tax,
    taxAmount: tax.tax,
    total,
  });
}

function lineTotal(net: Money, tax: SaleTaxSnapshot): Money {
  if (tax.taxKind === "NONE" || tax.taxPricingMode === undefined) {
    if (!tax.tax.isZero()) {
      throw new DomainError("INVALID_VALUE", "a line without a pricing mode cannot carry tax", "tax");
    }
    return net;
  }
  if (tax.taxPricingMode === "EXCLUSIVE") return net.add(tax.tax);
  if (tax.tax.amountMinor > net.amountMinor) {
    throw new DomainError("INVALID_VALUE", "inclusive tax cannot exceed the line net", "tax");
  }
  return net;
}

export function revenueAmount(gross: Money, taxAmount: Money, pricingMode: SaleTaxPricingMode | undefined): Money {
  if (pricingMode === "INCLUSIVE") return gross.subtract(taxAmount);
  return gross;
}

export function sumMoney(currency: CurrencyCode, amounts: readonly Money[]): Money {
  return Money.sum(currency, amounts);
}
