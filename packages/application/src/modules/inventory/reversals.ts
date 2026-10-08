import type {
  BusinessId,
  GoodsReceipt,
  InventoryAdjustment,
  InventoryMovement,
  InventoryMovementId,
  InventoryMovementSource,
  InventoryReasonNote,
  MembershipId,
  StockChangePlan,
} from "@tali/domain";
import {
  createInventoryRecording,
  parseGoodsReceiptId,
  parseInventoryAdjustmentId,
  reverseDocumentMovements,
  reverseGoodsReceipt,
  reverseInventoryAdjustment,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { ConflictError, NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import type { ProductRepository } from "../catalog/index.js";
import { inventoryPermissions } from "../identity/index.js";
import { inventoryAdjustmentReversed, inventoryReceiptReversed } from "./audit-actions.js";
import { ADJUSTMENT_NOT_FOUND, GOODS_RECEIPT_NOT_FOUND, parseReversalReason } from "./inventory-common.js";
import type {
  GoodsReceiptRepository,
  InventoryAdjustmentRepository,
  InventoryMovementRepository,
  LockedBalances,
  StockBalanceRepository,
} from "./ports.js";

export interface ReverseDocumentInput {
  readonly documentId: string;
  /** Required: why the document is reversed, 1 to 500 characters. */
  readonly reason: string;
}

export interface DocumentReversalResult<Document> {
  /** The document after the call: REVERSED either way. */
  readonly document: Document;
  /** The reversal movements written by this call, in ascending variant order; empty for a no-op. */
  readonly reversalMovements: readonly InventoryMovement[];
  /** False when the document was already REVERSED: nothing written, no audit record. */
  readonly changed: boolean;
}

/**
 * `inventory:adjust` (OWNER, MANAGER). State-setting. Reverses a whole goods
 * receipt with one exactly negating movement per original line (ADR-008
 * section 11). Reversing a REVERSED receipt is a no-op. Can raise
 * INSUFFICIENT_STOCK when the received stock is no longer on hand.
 */
export interface ReverseGoodsReceipt {
  execute(context: LocationBoundContext, input: ReverseDocumentInput): Promise<DocumentReversalResult<GoodsReceipt>>;
}

/**
 * `inventory:adjust` (OWNER, MANAGER). State-setting. Reverses a whole
 * adjustment or write-off. Reversing a REVERSED document is a no-op. Can raise
 * INSUFFICIENT_STOCK when a reversed increase is no longer on hand.
 */
export interface ReverseAdjustment {
  execute(
    context: LocationBoundContext,
    input: ReverseDocumentInput,
  ): Promise<DocumentReversalResult<InventoryAdjustment>>;
}

interface ReversalDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly products: ProductRepository;
  readonly movements: InventoryMovementRepository;
  readonly balances: StockBalanceRepository;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

interface PlannedReversal {
  readonly originals: readonly InventoryMovement[];
  readonly locked: LockedBalances;
  readonly plan: StockChangePlan;
}

function idOrNotFound<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch {
    throw new NotFoundError(message);
  }
}

/**
 * Lock order after the header (plan section H): variants FOR SHARE, then
 * balances FOR UPDATE, both ascending, then the pure reversal decision.
 * ARCHIVED products may be reversed; untracked ones are a CONFLICT (D7).
 */
async function planReversal(
  dependencies: ReversalDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  props: {
    readonly businessId: BusinessId;
    readonly source: InventoryMovementSource;
    readonly reason: InventoryReasonNote;
    readonly membershipId: MembershipId;
    readonly now: Date;
  },
): Promise<PlannedReversal> {
  const originals = await dependencies.movements.listOriginals(scope, props.businessId, props.source);
  if (originals.length === 0) throw new Error("a posted inventory document has no movements");
  const variantIds = new Set(originals.map((movement) => movement.variantId));
  const variants = await dependencies.products.lockVariantsForShare(scope, props.businessId, variantIds);
  for (const variantId of variantIds) {
    const variant = variants.get(variantId);
    if (variant === undefined) throw new Error("a movement references a variant that cannot be locked");
    if (!variant.trackInventory) throw new ConflictError("This product does not track inventory");
  }
  const locked = await dependencies.balances.lockForUpdate(scope, props.businessId, context.locationId, variantIds);
  const reversalMovementIds = new Map<InventoryMovementId, InventoryMovementId>(
    originals.map((original) => [original.id, dependencies.ids.newId("InventoryMovement")]),
  );
  const recording = withDomainRules(() =>
    createInventoryRecording({
      actorMembershipId: props.membershipId,
      ...(context.deviceId === undefined ? {} : { deviceId: context.deviceId }),
      sourceChannel: context.sourceChannel,
      correlationId: context.correlationId,
      now: props.now,
      timeZone: context.timeZone,
    }),
  );
  const plan = withDomainRules(() =>
    reverseDocumentMovements({
      originals,
      balances: locked.balances,
      reversalMovementIds,
      reason: props.reason,
      recording,
    }),
  );
  return { originals, locked, plan };
}

async function writeReversal(
  dependencies: ReversalDependencies,
  scope: TransactionScope,
  planned: PlannedReversal,
): Promise<void> {
  await dependencies.movements.insertMany(scope, planned.plan.movements);
  await dependencies.balances.apply(scope, planned.locked, planned.plan.balances);
}

export function createReverseGoodsReceipt(
  dependencies: ReversalDependencies & { readonly receipts: GoodsReceiptRepository },
): ReverseGoodsReceipt {
  const permission = inventoryPermissions.permissions["inventory:adjust"];
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, permission);
      const context = requireLocationBound(locationContext);
      const id = idOrNotFound(() => parseGoodsReceiptId(input.documentId), GOODS_RECEIPT_NOT_FOUND);
      const reason = parseReversalReason(input.reason);
      return dependencies.unitOfWork.run(async (scope) => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const receipt = await dependencies.receipts.findByIdForUpdate(scope, context.businessId, id);
        if (receipt?.locationId !== context.locationId) throw new NotFoundError(GOODS_RECEIPT_NOT_FOUND);
        if (receipt.status === "REVERSED") return { document: receipt, reversalMovements: [], changed: false };
        const now = dependencies.clock.now();
        const planned = await planReversal(dependencies, scope, context, {
          businessId: context.businessId,
          source: { kind: "GOODS_RECEIPT", id: receipt.id },
          reason,
          membershipId: membership.id,
          now,
        });
        const next = withDomainRules(() =>
          reverseGoodsReceipt({ receipt, reversedByMembershipId: membership.id, reason, now }),
        );
        await dependencies.receipts.markReversed(scope, receipt, next);
        await writeReversal(dependencies, scope, planned);
        await dependencies.audit.recordBusinessEvent(scope, inventoryReceiptReversed, {
          ...businessAuditEnvelope(context),
          locationId: context.locationId,
          entityId: receipt.id,
          reason,
          payload: { lineCount: planned.originals.length },
        });
        return { document: next, reversalMovements: planned.plan.movements, changed: true };
      });
    },
  };
}

export function createReverseAdjustment(
  dependencies: ReversalDependencies & { readonly adjustments: InventoryAdjustmentRepository },
): ReverseAdjustment {
  const permission = inventoryPermissions.permissions["inventory:adjust"];
  return {
    async execute(locationContext, input) {
      requireUserActor(locationContext, permission);
      const context = requireLocationBound(locationContext);
      const id = idOrNotFound(() => parseInventoryAdjustmentId(input.documentId), ADJUSTMENT_NOT_FOUND);
      const reason = parseReversalReason(input.reason);
      return dependencies.unitOfWork.run(async (scope) => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const adjustment = await dependencies.adjustments.findByIdForUpdate(scope, context.businessId, id);
        if (adjustment?.locationId !== context.locationId) throw new NotFoundError(ADJUSTMENT_NOT_FOUND);
        if (adjustment.status === "REVERSED") return { document: adjustment, reversalMovements: [], changed: false };
        const now = dependencies.clock.now();
        const planned = await planReversal(dependencies, scope, context, {
          businessId: context.businessId,
          source: { kind: "ADJUSTMENT", id: adjustment.id },
          reason,
          membershipId: membership.id,
          now,
        });
        const next = withDomainRules(() =>
          reverseInventoryAdjustment({ adjustment, reversedByMembershipId: membership.id, reason, now }),
        );
        await dependencies.adjustments.markReversed(scope, adjustment, next);
        await writeReversal(dependencies, scope, planned);
        await dependencies.audit.recordBusinessEvent(scope, inventoryAdjustmentReversed, {
          ...businessAuditEnvelope(context),
          locationId: context.locationId,
          entityId: adjustment.id,
          reason,
          payload: { kind: adjustment.kind, lineCount: planned.originals.length },
        });
        return { document: next, reversalMovements: planned.plan.movements, changed: true };
      });
    },
  };
}
