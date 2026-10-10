import type {
  InventoryMovement,
  ProductVariant,
  ProductVariantId,
  StockBalance,
  Stocktake,
  StocktakeId,
  StocktakeLine,
} from "@tali/domain";
import {
  decideCancelStocktake,
  decidePostStocktake,
  decideRecordStocktakeCount,
  decideRemoveStocktakeLine,
  MAX_QUANTITY_MINOR,
  packEntryQuantity,
  parseProductVariantId,
  parseStocktakeId,
  planCountCorrections,
  Quantity,
  startStocktake,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { ConflictError, NotFoundError, StocktakeStaleError, ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import type { KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import type { ProductPackRepository, ProductRepository, UnitReferenceRepository } from "../catalog/index.js";
import { PACK_NOT_FOUND, PRODUCT_NOT_FOUND } from "../catalog/index.js";
import { inventoryPermissions } from "../identity/index.js";
import { inventoryStocktakeCancelled, inventoryStocktakePosted, inventoryStocktakeStarted } from "./audit-actions.js";
import type { StocktakeCreationSnapshot } from "./codecs.js";
import { stocktakeCreationSnapshot, stocktakeCreationSnapshotCodec } from "./codecs.js";
import type { StocktakeCountInput, StocktakeCountSyntax } from "./inventory-common.js";
import {
  idOrNotFound,
  parseOptionalCancelReason,
  parseOptionalNote,
  parseStocktakeCount,
  resolveDirectQuantity,
  STOCKTAKE_LINE_NOT_FOUND,
  STOCKTAKE_NOT_FOUND,
} from "./inventory-common.js";
import type {
  InventoryMovementRepository,
  StockBalanceRepository,
  StocktakeLineRepository,
  StocktakeRepository,
} from "./ports.js";
import { planRecording, prepareInventoryCommand } from "./stock-document.js";
import type { StocktakeLineView, StocktakeView, StocktakeVisibility } from "./stocktake-views.js";
import { stocktakeLineView, stocktakeView, stocktakeVisibilityFor } from "./stocktake-views.js";

export const CREATE_STOCKTAKE_OPERATION = "inventory.stocktake.create.v1";

export interface CreateStocktakeInput {
  readonly note?: string;
  readonly idempotencyKey: string | undefined;
}

export interface CreateStocktakeOutcome {
  /** The DRAFT version-1 header as created, on both the fresh and the replay path. */
  readonly stocktake: StocktakeCreationSnapshot;
  readonly replayed: boolean;
}

export interface RecordStocktakeCountInput {
  readonly stocktakeId: string;
  readonly variantId: string;
  readonly count: StocktakeCountInput;
  /** Absent or 0 for a variant not counted yet; the line version last read otherwise. */
  readonly expectedVersion?: number;
}

export interface RemoveStocktakeLineInput {
  readonly stocktakeId: string;
  readonly variantId: string;
  readonly expectedVersion: number;
}

export interface PostStocktakeInput {
  readonly stocktakeId: string;
  readonly expectedVersion: number;
}

export interface CancelStocktakeInput {
  readonly stocktakeId: string;
  readonly expectedVersion: number;
  /** Optional, 1 to 500 characters; recorded on the audit record only. */
  readonly reason?: string;
}

export interface StocktakeLineChangeResult {
  readonly stocktake: StocktakeView;
  readonly line: StocktakeLineView;
  /** False for a successful no-op: nothing written, no version increment. */
  readonly changed: boolean;
}

export interface StocktakeChangeResult {
  readonly stocktake: StocktakeView;
  /** False for a successful no-op: nothing written, no audit record. */
  readonly changed: boolean;
}

export interface PostStocktakeResult extends StocktakeChangeResult {
  /** The COUNT_CORRECTION movements written by this call, in ascending variant order; empty for a no-op. */
  readonly movements: readonly InventoryMovement[];
}

/**
 * `inventory:count` (OWNER, MANAGER, STOCK_KEEPER). Keyed. Starts a DRAFT
 * stocktake at the context's location. Only one DRAFT exists per location:
 * another one in progress is a CONFLICT, whatever the key (decision D1).
 */
export interface CreateStocktake {
  execute(context: LocationBoundContext, input: CreateStocktakeInput): Promise<CreateStocktakeOutcome>;
}

/**
 * `inventory:count`. State-setting with the line's `expectedVersion`.
 * Captures one counted quantity with the on-hand and balance version seen at
 * count time. Writes no movement and no audit record.
 */
export interface RecordStocktakeCount {
  execute(context: LocationBoundContext, input: RecordStocktakeCountInput): Promise<StocktakeLineChangeResult>;
}

/** `inventory:count`. Marks a counted line REMOVED; removing a REMOVED line is a no-op. No audit record. */
export interface RemoveStocktakeLine {
  execute(context: LocationBoundContext, input: RemoveStocktakeLineInput): Promise<StocktakeLineChangeResult>;
}

/**
 * `inventory:count-post` (OWNER, MANAGER). State-setting. Posts every COUNTED
 * line as a COUNT_CORRECTION of its variance, atomically, or nothing: a line
 * whose stock item changed since it was counted makes the whole post
 * STOCKTAKE_STALE. Posting a POSTED stocktake is a no-op.
 */
export interface PostStocktake {
  execute(context: LocationBoundContext, input: PostStocktakeInput): Promise<PostStocktakeResult>;
}

/** `inventory:count-post`. State-setting. Cancels a DRAFT; cancelling a CANCELLED stocktake is a no-op. */
export interface CancelStocktake {
  execute(context: LocationBoundContext, input: CancelStocktakeInput): Promise<StocktakeChangeResult>;
}

export interface StocktakeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly packs: ProductPackRepository;
  readonly units: UnitReferenceRepository;
  readonly stocktakes: StocktakeRepository;
  readonly stocktakeLines: StocktakeLineRepository;
  readonly movements: InventoryMovementRepository;
  readonly balances: StockBalanceRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

const countPermission = inventoryPermissions.permissions["inventory:count"];
const postPermission = inventoryPermissions.permissions["inventory:count-post"];

function parseStocktakeTarget(value: string): StocktakeId {
  return idOrNotFound(() => parseStocktakeId(value), STOCKTAKE_NOT_FOUND);
}

function parseVariantTarget(value: string): ProductVariantId {
  return idOrNotFound(() => parseProductVariantId(value), PRODUCT_NOT_FOUND);
}

/** The stocktake of this business at the context's location, locked FOR UPDATE; any other is NOT_FOUND. */
async function stocktakeForUpdate(
  dependencies: StocktakeDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  id: StocktakeId,
): Promise<Stocktake> {
  const stocktake = await dependencies.stocktakes.findByIdForUpdate(scope, context.businessId, id);
  if (stocktake?.locationId !== context.locationId) throw new NotFoundError(STOCKTAKE_NOT_FOUND);
  return stocktake;
}

async function viewOf(
  dependencies: StocktakeDependencies,
  scope: TransactionScope,
  stocktake: Stocktake,
  visibility: StocktakeVisibility,
): Promise<StocktakeView> {
  const counts = await dependencies.stocktakeLines.countByStatus(scope, stocktake.businessId, stocktake.id);
  return stocktakeView(stocktake, counts, visibility);
}

/** The variant of this business locked FOR SHARE; it must track inventory. */
async function lockCountedVariant(
  dependencies: StocktakeDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  variantId: ProductVariantId,
): Promise<ProductVariant> {
  const variants = await dependencies.products.lockVariantsForShare(scope, context.businessId, new Set([variantId]));
  const variant = variants.get(variantId);
  if (variant?.businessId !== context.businessId) throw new NotFoundError(PRODUCT_NOT_FOUND);
  if (!variant.trackInventory) throw new ConflictError("This product does not track inventory");
  return variant;
}

/**
 * The counted quantity in the stock unit: a direct quantity, or whole packs
 * of an ACTIVE pack of this variant plus an optional loose quantity. A foreign
 * or other-variant pack is NOT_FOUND; a RETIRED pack is a CONFLICT.
 */
async function resolveCount(
  dependencies: StocktakeDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  variant: ProductVariant,
  count: StocktakeCountSyntax,
): Promise<Quantity> {
  if (count.form === "direct") {
    return resolveDirectQuantity(scope, dependencies.units, count.quantity, variant.stockUnit, ["count"]);
  }
  const packs = await dependencies.packs.findForEntry(scope, context.businessId, new Set([count.packId]));
  const pack = packs.get(count.packId);
  if (pack?.businessId !== context.businessId || pack.variantId !== variant.id) {
    throw new NotFoundError(PACK_NOT_FOUND);
  }
  const packed = withDomainRules(
    () => packEntryQuantity({ pack, stockUnit: variant.stockUnit, packCount: count.packCount }),
    "packCount",
  );
  const loose =
    count.loose === undefined
      ? Quantity.zero(variant.stockUnit)
      : await resolveDirectQuantity(scope, dependencies.units, count.loose, variant.stockUnit, ["count", "loose"]);
  const counted = packed.add(loose);
  if (counted.amountMinor > MAX_QUANTITY_MINOR) {
    const message = "the counted quantity is out of range";
    throw new ValidationError(message, [{ path: ["count"], message }]);
  }
  return counted;
}

export function createCreateStocktake(dependencies: StocktakeDependencies): CreateStocktake {
  return {
    async execute(locationContext, input) {
      const { actor, context, key } = prepareInventoryCommand(locationContext, countPermission, input.idempotencyKey);
      const note = parseOptionalNote(input.note);
      return dependencies.unitOfWork.run(async (scope): Promise<CreateStocktakeOutcome> => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, countPermission);
        const command = canonicalCommandEncoding({
          operation: CREATE_STOCKTAKE_OPERATION,
          commandSchemaVersion: 1,
          command: { locationId: context.locationId, note },
        });
        const fingerprint = await dependencies.hasher.fingerprint(command);
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "stocktake",
          codec: stocktakeCreationSnapshotCodec,
          plan: () => {
            const stocktake = withDomainRules(() =>
              startStocktake({
                id: dependencies.ids.newId("Stocktake"),
                businessId: context.businessId,
                locationId: context.locationId,
                ...(note === undefined ? {} : { note }),
                createdByMembershipId: membership.id,
                createdAt: dependencies.clock.now(),
              }),
            );
            return Promise.resolve({
              result: stocktakeCreationSnapshot(stocktake),
              resourceId: stocktake.id,
              apply: async () => {
                await dependencies.stocktakes.insert(scope, stocktake);
                await dependencies.audit.recordBusinessEvent(scope, inventoryStocktakeStarted, {
                  ...businessAuditEnvelope(context, key),
                  locationId: context.locationId,
                  entityId: stocktake.id,
                  payload: {},
                });
              },
            });
          },
        });
        return { stocktake: outcome.result, replayed: outcome.replayed };
      });
    },
  };
}

export function createRecordStocktakeCount(dependencies: StocktakeDependencies): RecordStocktakeCount {
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, countPermission);
      const context = requireLocationBound(locationContext);
      const stocktakeId = parseStocktakeTarget(input.stocktakeId);
      const variantId = parseVariantTarget(input.variantId);
      const count = parseStocktakeCount(input.count);
      return dependencies.unitOfWork.run(async (scope): Promise<StocktakeLineChangeResult> => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, countPermission);
        const visibility = stocktakeVisibilityFor(context.permissions);
        const stocktake = await stocktakeForUpdate(dependencies, scope, context, stocktakeId);
        if (stocktake.status !== "DRAFT") throw new ConflictError("Only a draft stocktake can be counted");
        const variant = await lockCountedVariant(dependencies, scope, context, variantId);
        const balance: StockBalance | undefined = await dependencies.balances.find(
          scope,
          context.businessId,
          context.locationId,
          variantId,
        );
        const onHand = balance?.quantity ?? Quantity.zero(variant.stockUnit);
        if (variant.status !== "ACTIVE" && onHand.isZero()) {
          throw new ConflictError("An archived product with no stock on hand cannot be counted");
        }
        const counted = await resolveCount(dependencies, scope, context, variant, count);
        const current = await dependencies.stocktakeLines.find(scope, context.businessId, stocktake.id, variantId);
        // The decision reads the distinct-line count only when the variant has no line yet.
        const distinctLineCount =
          current === undefined
            ? await dependencies.stocktakeLines.countForStocktake(scope, context.businessId, stocktake.id)
            : 0;
        const decision = withDomainRules(() =>
          decideRecordStocktakeCount({
            stocktake,
            current,
            currentDistinctLineCount: distinctLineCount,
            variantId,
            counted,
            stockUnit: variant.stockUnit,
            expectedOnHand: onHand,
            balanceVersion: balance?.version ?? 0,
            actorMembershipId: membership.id,
            now: dependencies.clock.now(),
            expectedVersion: input.expectedVersion,
          }),
        );
        if (decision.changed) {
          if (current === undefined) await dependencies.stocktakeLines.insert(scope, decision.line);
          else await dependencies.stocktakeLines.update(scope, current, decision.line);
          await dependencies.stocktakes.update(scope, stocktake, decision.stocktake);
        }
        return {
          stocktake: await viewOf(dependencies, scope, decision.stocktake, visibility),
          line: stocktakeLineView(decision.stocktake, decision.line, visibility),
          changed: decision.changed,
        };
      });
    },
  };
}

export function createRemoveStocktakeLine(dependencies: StocktakeDependencies): RemoveStocktakeLine {
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, countPermission);
      const context = requireLocationBound(locationContext);
      const stocktakeId = parseStocktakeTarget(input.stocktakeId);
      const variantId = parseVariantTarget(input.variantId);
      return dependencies.unitOfWork.run(async (scope): Promise<StocktakeLineChangeResult> => {
        await requireActingMembership(scope, dependencies.memberships, context, countPermission);
        const visibility = stocktakeVisibilityFor(context.permissions);
        const stocktake = await stocktakeForUpdate(dependencies, scope, context, stocktakeId);
        const line = await dependencies.stocktakeLines.find(scope, context.businessId, stocktake.id, variantId);
        if (line === undefined) throw new NotFoundError(STOCKTAKE_LINE_NOT_FOUND);
        const decision = withDomainRules(() =>
          decideRemoveStocktakeLine({ stocktake, line, expectedVersion: input.expectedVersion }),
        );
        if (decision.changed) {
          await dependencies.stocktakeLines.update(scope, line, decision.line);
          await dependencies.stocktakes.update(scope, stocktake, decision.stocktake);
        }
        return {
          stocktake: await viewOf(dependencies, scope, decision.stocktake, visibility),
          line: stocktakeLineView(decision.stocktake, decision.line, visibility),
          changed: decision.changed,
        };
      });
    },
  };
}

/** Lines whose stock item moved, or whose stock unit changed, since they were counted (decisions D4 and D8). */
function staleLines(
  lines: readonly StocktakeLine[],
  variants: ReadonlyMap<string, ProductVariant>,
  balances: ReadonlyMap<string, StockBalance>,
): readonly StocktakeLine[] {
  return lines.filter((line) => {
    const variant = variants.get(line.variantId);
    const balance = balances.get(line.variantId);
    if (variant === undefined || balance === undefined) throw new Error("a counted line's stock item was not locked");
    return balance.version !== line.balanceVersionAtCount || variant.stockUnit !== line.stockUnitAtCount;
  });
}

export function createPostStocktake(dependencies: StocktakeDependencies): PostStocktake {
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, postPermission);
      const context = requireLocationBound(locationContext);
      const stocktakeId = parseStocktakeTarget(input.stocktakeId);
      return dependencies.unitOfWork.run(async (scope): Promise<PostStocktakeResult> => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, postPermission);
        const visibility = stocktakeVisibilityFor(context.permissions);
        const stocktake = await stocktakeForUpdate(dependencies, scope, context, stocktakeId);
        if (stocktake.status === "POSTED") {
          return { stocktake: await viewOf(dependencies, scope, stocktake, visibility), movements: [], changed: false };
        }
        const { businessId, locationId } = context;
        const counted = await dependencies.stocktakeLines.listCounted(scope, businessId, stocktake.id);
        const recording = planRecording(dependencies.clock, context, membership.id);
        const header = withDomainRules(() =>
          decidePostStocktake({
            stocktake,
            countedLineCount: counted.length,
            postedByMembershipId: membership.id,
            postedAt: recording.occurredAt,
            businessDate: recording.businessDate,
            expectedVersion: input.expectedVersion,
          }),
        );

        const variantIds = new Set(counted.map((line) => line.variantId));
        const variants = await dependencies.products.lockVariantsForShare(scope, businessId, variantIds);
        for (const variantId of variantIds) {
          const variant = variants.get(variantId);
          if (variant?.businessId !== businessId) throw new Error("a counted line's variant cannot be locked");
          if (!variant.trackInventory) throw new ConflictError("This product does not track inventory");
        }
        const locked = await dependencies.balances.lockForUpdate(scope, businessId, locationId, variantIds);
        const balances = new Map(locked.balances.map((balance) => [balance.variantId as string, balance]));
        const stale = staleLines(counted, variants, balances);
        if (stale.length > 0) {
          throw new StocktakeStaleError(
            stale.map((line) => line.variantId),
            stale.length,
          );
        }

        const plan = withDomainRules(() =>
          planCountCorrections({
            businessId,
            locationId,
            stocktakeId: stocktake.id,
            lines: counted.map((line) => ({
              variantId: line.variantId,
              counted: line.countedQuantity,
              balance: balances.get(line.variantId) as StockBalance,
              movementId: dependencies.ids.newId("InventoryMovement"),
            })),
            recording,
          }),
        );
        if (plan.movements.length > 0) {
          await dependencies.movements.insertMany(scope, plan.movements);
          await dependencies.balances.apply(scope, locked, plan.balances);
        }
        const lineVersions = new Map(counted.map((line) => [line.variantId as string, line.version]));
        await dependencies.stocktakeLines.applyPostingVariances(
          scope,
          businessId,
          stocktake.id,
          plan.variances.map((row) => ({
            variantId: row.variantId,
            lineVersion: lineVersions.get(row.variantId) as number,
            variance: row.variance,
          })),
        );
        await dependencies.stocktakes.update(scope, stocktake, header.stocktake);
        await dependencies.audit.recordBusinessEvent(scope, inventoryStocktakePosted, {
          ...businessAuditEnvelope(context),
          locationId,
          entityId: stocktake.id,
          payload: {
            countedLineCount: counted.length,
            correctionMovementCount: plan.movements.length,
            zeroVarianceCount: counted.length - plan.movements.length,
          },
        });
        return {
          stocktake: await viewOf(dependencies, scope, header.stocktake, visibility),
          movements: plan.movements,
          changed: true,
        };
      });
    },
  };
}

export function createCancelStocktake(dependencies: StocktakeDependencies): CancelStocktake {
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, postPermission);
      const context = requireLocationBound(locationContext);
      const stocktakeId = parseStocktakeTarget(input.stocktakeId);
      const reason = parseOptionalCancelReason(input.reason);
      return dependencies.unitOfWork.run(async (scope): Promise<StocktakeChangeResult> => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, postPermission);
        const visibility = stocktakeVisibilityFor(context.permissions);
        const stocktake = await stocktakeForUpdate(dependencies, scope, context, stocktakeId);
        const decision = withDomainRules(() =>
          decideCancelStocktake({
            stocktake,
            cancelledByMembershipId: membership.id,
            cancelledAt: dependencies.clock.now(),
            expectedVersion: input.expectedVersion,
          }),
        );
        if (!decision.changed) {
          return { stocktake: await viewOf(dependencies, scope, stocktake, visibility), changed: false };
        }
        await dependencies.stocktakes.update(scope, stocktake, decision.stocktake);
        const counts = await dependencies.stocktakeLines.countByStatus(scope, context.businessId, stocktake.id);
        await dependencies.audit.recordBusinessEvent(scope, inventoryStocktakeCancelled, {
          ...businessAuditEnvelope(context),
          locationId: context.locationId,
          entityId: stocktake.id,
          ...(reason === undefined ? {} : { reason }),
          payload: { countedLineCount: counts.counted },
        });
        return { stocktake: stocktakeView(decision.stocktake, counts, visibility), changed: true };
      });
    },
  };
}
