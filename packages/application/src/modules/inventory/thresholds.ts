import type { LocationId, ProductVariant, ProductVariantId, Quantity, StockThreshold } from "@tali/domain";
import {
  decideClearThreshold,
  decideSetThreshold,
  parseProductVariantId,
  parseThresholdExpectedVersion,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { ConflictError, NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import type { ProductRepository, UnitReferenceRepository } from "../catalog/index.js";
import { PRODUCT_NOT_FOUND } from "../catalog/index.js";
import { inventoryPermissions } from "../identity/index.js";
import { inventoryLowStockThresholdCleared, inventoryLowStockThresholdSet } from "./audit-actions.js";
import type { ThresholdQuantityInput } from "./inventory-common.js";
import { parseThresholdQuantity } from "./inventory-common.js";
import type { StockThresholdRepository } from "./ports.js";

/** A stock item's low-stock configuration at the context's location. Version 0 means no row exists. */
export interface StockThresholdView {
  readonly variantId: ProductVariantId;
  readonly locationId: LocationId;
  readonly threshold?: Quantity;
  readonly version: number;
}

export interface ThresholdChangeResult extends StockThresholdView {
  /** False for a successful no-op: nothing written, no audit record, no version increment. */
  readonly changed: boolean;
}

export interface SetLowStockThresholdInput {
  readonly variantId: string;
  /** The version last read; 0 when no threshold row exists yet. */
  readonly expectedVersion: number;
  readonly threshold: ThresholdQuantityInput;
}

export interface ClearLowStockThresholdInput {
  readonly variantId: string;
  readonly expectedVersion: number;
}

/**
 * `inventory:threshold` (OWNER, MANAGER, STOCK_KEEPER). State-setting with
 * `expectedVersion` (0 or more). Sets the low-stock threshold of an ACTIVE,
 * tracked product at the context's location: a quantity of 0 or more in its
 * stock unit, never a pack. Not a movement: no balance changes (ADR-008
 * section 7.4).
 */
export interface SetLowStockThreshold {
  execute(context: LocationBoundContext, input: SetLowStockThresholdInput): Promise<ThresholdChangeResult>;
}

/**
 * `inventory:threshold`. State-setting. Clears the threshold of any product
 * of the business (archived and untracked included, plan decision D8); the row
 * is kept. Clearing an absent or cleared threshold is a no-op.
 */
export interface ClearLowStockThreshold {
  execute(context: LocationBoundContext, input: ClearLowStockThresholdInput): Promise<ThresholdChangeResult>;
}

interface ThresholdDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly units: UnitReferenceRepository;
  readonly thresholds: StockThresholdRepository;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
}

function result(
  variantId: ProductVariantId,
  locationId: LocationId,
  record: StockThreshold | undefined,
  changed: boolean,
): ThresholdChangeResult {
  return Object.freeze({
    variantId,
    locationId,
    ...(record?.threshold === undefined ? {} : { threshold: record.threshold }),
    version: record?.version ?? 0,
    changed,
  });
}

function parseTarget(input: { readonly variantId: string; readonly expectedVersion: number }) {
  let variantId: ProductVariantId;
  try {
    variantId = parseProductVariantId(input.variantId);
  } catch {
    throw new NotFoundError(PRODUCT_NOT_FOUND);
  }
  const expectedVersion = withDomainRules(
    () => parseThresholdExpectedVersion(input.expectedVersion),
    "expectedVersion",
  );
  return { variantId, expectedVersion };
}

/** The variant of this business, locked FOR SHARE so a product edit waits for the threshold change. */
async function lockVariant(
  dependencies: ThresholdDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  variantId: ProductVariantId,
): Promise<ProductVariant> {
  const variants = await dependencies.products.lockVariantsForShare(scope, context.businessId, new Set([variantId]));
  const variant = variants.get(variantId);
  if (variant?.businessId !== context.businessId) throw new NotFoundError(PRODUCT_NOT_FOUND);
  return variant;
}

export function createSetLowStockThreshold(dependencies: ThresholdDependencies): SetLowStockThreshold {
  const permission = inventoryPermissions.permissions["inventory:threshold"];
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, permission);
      const context = requireLocationBound(locationContext);
      const { variantId, expectedVersion } = parseTarget(input);
      return dependencies.unitOfWork.run(async (scope): Promise<ThresholdChangeResult> => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const variant = await lockVariant(dependencies, scope, context, variantId);
        if (variant.status !== "ACTIVE" || !variant.trackInventory) {
          throw new ConflictError("A low-stock threshold needs an active product that tracks inventory");
        }
        const value = await parseThresholdQuantity(scope, dependencies.units, input.threshold);
        const target = {
          businessId: context.businessId,
          locationId: context.locationId,
          variantId,
          stockUnit: variant.stockUnit,
        };
        const decide = (current: StockThreshold | undefined) =>
          withDomainRules(
            () =>
              decideSetThreshold({
                current,
                expectedVersion,
                target,
                value,
                newId: dependencies.ids.newId("StockThreshold"),
              }),
            "threshold",
          );
        const current = await dependencies.thresholds.findForUpdate(
          scope,
          context.businessId,
          context.locationId,
          variantId,
        );
        const decision = decide(current);
        if (decision.outcome === "unchanged") {
          return result(variantId, context.locationId, decision.record, false);
        }
        if (decision.outcome === "created") {
          if ((await dependencies.thresholds.insertIfAbsent(scope, decision.record)) === "exists") {
            const committed = await dependencies.thresholds.findForUpdate(
              scope,
              context.businessId,
              context.locationId,
              variantId,
            );
            if (committed === undefined) throw new Error("threshold insert reported an existing row that is absent");
            decide(committed);
            throw new Error("a committed threshold row cannot match expectedVersion 0");
          }
        } else {
          await dependencies.thresholds.update(scope, decision.previous, decision.record);
        }
        const from = decision.outcome === "changed" ? decision.previous.threshold : undefined;
        await dependencies.audit.recordBusinessEvent(scope, inventoryLowStockThresholdSet, {
          ...businessAuditEnvelope(context),
          locationId: context.locationId,
          entityId: decision.record.id,
          payload: {
            variantId,
            stockUnit: variant.stockUnit,
            ...(from === undefined ? {} : { fromThresholdMinor: from.toMinorUnitsString() }),
            toThresholdMinor: value.toMinorUnitsString(),
          },
        });
        return result(variantId, context.locationId, decision.record, true);
      });
    },
  };
}

export function createClearLowStockThreshold(dependencies: ThresholdDependencies): ClearLowStockThreshold {
  const permission = inventoryPermissions.permissions["inventory:threshold"];
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, permission);
      const context = requireLocationBound(locationContext);
      const { variantId, expectedVersion } = parseTarget(input);
      return dependencies.unitOfWork.run(async (scope): Promise<ThresholdChangeResult> => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const variant = await lockVariant(dependencies, scope, context, variantId);
        const current = await dependencies.thresholds.findForUpdate(
          scope,
          context.businessId,
          context.locationId,
          variantId,
        );
        const decision = withDomainRules(() =>
          decideClearThreshold({
            current,
            expectedVersion,
            target: { businessId: context.businessId, locationId: context.locationId, variantId },
          }),
        );
        if (decision.outcome !== "changed") {
          return result(variantId, context.locationId, decision.record, false);
        }
        const from = decision.previous.threshold;
        if (from === undefined) throw new Error("a changed clear must have had a threshold");
        await dependencies.thresholds.update(scope, decision.previous, decision.record);
        await dependencies.audit.recordBusinessEvent(scope, inventoryLowStockThresholdCleared, {
          ...businessAuditEnvelope(context),
          locationId: context.locationId,
          entityId: decision.record.id,
          payload: { variantId, stockUnit: variant.stockUnit, fromThresholdMinor: from.toMinorUnitsString() },
        });
        return result(variantId, context.locationId, decision.record, true);
      });
    },
  };
}
