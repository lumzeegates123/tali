import type { ProductPriceHistoryRepository } from "@tali/application";
import type { ProductVariantPrice } from "@tali/domain";
import {
  Money,
  parseBusinessId,
  parseCurrencyCode,
  parseMembershipId,
  parseProductVariantId,
  parseProductVariantPriceId,
  restoreProductVariantPrice,
} from "@tali/domain";
import type { ProductVariantPrice as ProductVariantPriceRow } from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { keysetArgs, toPage } from "./pagination.js";

export const PRICE_HISTORY_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  product_variant_prices_business_id_variant_id_price_version_key: "The selling price was changed by another request",
});

function toPriceEntry(row: ProductVariantPriceRow): ProductVariantPrice {
  return restoreProductVariantPrice({
    id: parseProductVariantPriceId(row.id),
    businessId: parseBusinessId(row.businessId),
    variantId: parseProductVariantId(row.variantId),
    price: Money.ofMinor(row.amountMinor, parseCurrencyCode(row.currency)),
    priceVersion: row.priceVersion,
    effectiveAt: row.effectiveAt,
    setByMembershipId: parseMembershipId(row.setByMembershipId),
    ...(row.reason === null ? {} : { reason: row.reason }),
  });
}

/**
 * The append-only selling-price history (ADR-008 section 3.4). INSERT and
 * SELECT only: the application role has no UPDATE or DELETE on the table. One
 * row per (business, variant, price version); a lost race surfaces as
 * ConflictError.
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

    async listForVariant(scope, businessId, variantId, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).productVariantPrice.findMany({
        where: { businessId, variantId, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
      });
      return toPage(rows, request, (row) => row.id, toPriceEntry);
    },
  };
}
