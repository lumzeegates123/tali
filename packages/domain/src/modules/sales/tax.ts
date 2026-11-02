import { DomainError } from "../../errors.js";
import type { CurrencyCode } from "../../kernel/currency.js";
import { Money } from "../../kernel/money.js";

/** ADR-010 section 7. S4 production snapshots are only NONE. */
export const SALE_TAX_KINDS = ["NONE", "STANDARD", "ZERO_RATED", "EXEMPT"] as const;
export type SaleTaxKind = (typeof SALE_TAX_KINDS)[number];

export const SALE_TAX_PRICING_MODES = ["EXCLUSIVE", "INCLUSIVE"] as const;
export type SaleTaxPricingMode = (typeof SALE_TAX_PRICING_MODES)[number];

export const SALE_TAX_ROUNDING_MODES = ["HALF_EVEN"] as const;
export type SaleTaxRoundingMode = (typeof SALE_TAX_ROUNDING_MODES)[number];

/**
 * Immutable line tax snapshot (ADR-010 section 7). S8 fills configured
 * treatments later. S4's resolver only produces {@link noTaxSnapshot}.
 */
export interface SaleTaxSnapshot {
  readonly taxTreatmentId?: string;
  readonly taxName?: string;
  readonly taxKind: SaleTaxKind;
  readonly taxRateBps?: number;
  readonly taxPricingMode?: SaleTaxPricingMode;
  readonly taxRoundingMode?: SaleTaxRoundingMode;
  readonly taxableBase: Money;
  readonly tax: Money;
}

export function noTaxSnapshot(taxableBase: Money): SaleTaxSnapshot {
  return Object.freeze({
    taxKind: "NONE" as const,
    taxableBase,
    tax: Money.zero(taxableBase.currency),
  });
}

export function assertTaxSnapshot(snapshot: SaleTaxSnapshot, currency: CurrencyCode): void {
  if (!(SALE_TAX_KINDS as readonly string[]).includes(snapshot.taxKind)) {
    throw new DomainError("INVALID_VALUE", "unknown tax kind", "taxKind");
  }
  if (snapshot.taxableBase.currency !== currency || snapshot.tax.currency !== currency) {
    throw new DomainError("INVALID_VALUE", "tax snapshot currency must match the sale", "tax");
  }
  if (snapshot.tax.isNegative() || snapshot.taxableBase.isNegative()) {
    throw new DomainError("INVALID_VALUE", "tax snapshot amounts cannot be negative", "tax");
  }
  if (snapshot.taxKind === "NONE") {
    if (!snapshot.tax.isZero()) {
      throw new DomainError("INVALID_VALUE", "a NONE tax snapshot has zero tax", "tax");
    }
    if (
      snapshot.taxTreatmentId !== undefined ||
      snapshot.taxName !== undefined ||
      snapshot.taxRateBps !== undefined ||
      snapshot.taxPricingMode !== undefined ||
      snapshot.taxRoundingMode !== undefined
    ) {
      throw new DomainError("INVALID_VALUE", "a NONE tax snapshot carries no treatment", "taxKind");
    }
  }
}
