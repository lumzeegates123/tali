import { parseCatalogChangeReason, setSellingPrice } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { catalogPermissions } from "../identity/index.js";
import { productPriceSet } from "./audit-actions.js";
import { parseExpectedVersion, parseSellingPrice, PRODUCT_NOT_FOUND, productIdOrNotFound } from "./catalog-common.js";
import type { CatalogProductChangeResult } from "./products.js";
import type { ProductPriceHistoryRepository, ProductRepository } from "./ports.js";

export interface SetSellingPriceInput {
  readonly productId: string;
  readonly expectedVersion: number;
  /** Integer minor units as text, in the business currency. */
  readonly price: { readonly amountMinor: string; readonly currency: string };
  readonly reason?: string;
}

/**
 * `product:price` (OWNER, MANAGER). Sets the business-wide selling price per
 * stock unit of the product's default variant (ADR-008 sections 3.5 and 14).
 * State-setting: the current price again is a successful no-op with no
 * history row, no version increment and no audit record. A real change
 * appends exactly one history row and increments priceVersion.
 */
export interface SetSellingPrice {
  execute(context: BusinessContext, input: SetSellingPriceInput): Promise<CatalogProductChangeResult>;
}

export function createSetSellingPrice(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly prices: ProductPriceHistoryRepository;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): SetSellingPrice {
  const permission = catalogPermissions.permissions["product:price"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const productId = productIdOrNotFound(input.productId);
      const expectedVersion = parseExpectedVersion(input.expectedVersion);
      const price = parseSellingPrice(input.price, context.currency);
      const reason =
        input.reason === undefined
          ? undefined
          : withDomainRules(() => parseCatalogChangeReason(input.reason as string), "reason");
      return dependencies.unitOfWork.run(async (scope) => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const item = await dependencies.products.findByIdForUpdate(scope, context.businessId, productId);
        if (item === undefined) throw new NotFoundError(PRODUCT_NOT_FOUND);
        const current = item.variant.sellingPrice;
        const transition = withDomainRules(() =>
          setSellingPrice({
            item,
            expectedVersion,
            price,
            businessCurrency: context.currency,
            priceId: dependencies.ids.newId("ProductVariantPrice"),
            setByMembershipId: membership.id,
            ...(reason === undefined ? {} : { reason }),
            now: dependencies.clock.now(),
          }),
        );
        if (transition.outcome === "unchanged") return { item, changed: false };
        await dependencies.products.update(scope, item, transition.item);
        await dependencies.prices.append(scope, transition.priceEntry);
        await dependencies.audit.recordBusinessEvent(scope, productPriceSet, {
          ...businessAuditEnvelope(context),
          entityId: item.product.id,
          ...(reason === undefined ? {} : { reason }),
          payload: {
            variantId: item.variant.id,
            ...(current === undefined ? {} : { fromAmountMinor: current.toMinorUnitsString() }),
            toAmountMinor: transition.priceEntry.price.toMinorUnitsString(),
            currency: transition.priceEntry.price.currency,
            priceVersion: transition.priceEntry.priceVersion,
          },
        });
        return { item: transition.item, changed: true };
      });
    },
  };
}
