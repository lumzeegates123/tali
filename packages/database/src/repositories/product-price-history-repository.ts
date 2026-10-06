import type { ProductPriceHistoryRepository } from "@tali/application";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

export const PRICE_HISTORY_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  product_variant_prices_business_id_variant_id_price_version_key: "The selling price was changed by another request",
});

/**
 * The append-only selling-price history (ADR-008 section 3.4). INSERT only:
 * the application role has no UPDATE or DELETE on the table. One row per
 * (business, variant, price version); a lost race surfaces as ConflictError.
 */
export function createProductPriceHistoryRepository(): ProductPriceHistoryRepository {
  return {
    async append(scope, entry) {
      await translatingUniqueViolations(PRICE_HISTORY_CONFLICTS, () =>
        transactionClient(scope).productVariantPrice.create({
          data: {
            businessId: entry.businessId,
            id: entry.id,
            variantId: entry.variantId,
            amountMinor: entry.price.amountMinor,
            currency: entry.price.currency,
            priceVersion: entry.priceVersion,
            effectiveAt: entry.effectiveAt,
            setByMembershipId: entry.setByMembershipId,
            reason: entry.reason ?? null,
          },
        }),
      );
    },
  };
}
