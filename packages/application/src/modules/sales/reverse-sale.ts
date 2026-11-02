import { hasPermission } from "../../authorization/permissions.js";
import {
  DomainError,
  KernelError,
  SALE_POSTED_RULE,
  SALE_POSTED_VERSION,
  parseSaleId,
  parseSaleReversalReason,
  planSaleStockReversal,
  reversePostingPlan,
  reverseSale,
  salePostedPlan,
  type SaleId,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { ConflictError, NotFoundError, ValidationError } from "../../errors/application-error.js";
import { toApplicationError } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import { objectAt, textAt } from "../../idempotency/result-json.js";
import type { JsonValue } from "../../ports/queue-provider.js";
import type { Clock } from "../../ports/clock.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import { inventoryPermissions, salesPermissions } from "../identity/index.js";
import { createLedgerPostingService, type LedgerPostingDependencies } from "../ledger/posting.js";
import { saleReversed } from "./audit-actions.js";
import type { SaleRepository, SalesInventoryPort } from "./ports.js";
import { presentSale, type SaleView } from "./view.js";

export const REVERSE_SALE_OPERATION = "sales.sale.reverse.v1";

export interface ReverseSaleInput {
  readonly saleId: string;
  readonly reason: string;
  readonly tenderUnwoundConfirmed: boolean;
  readonly idempotencyKey: string | undefined;
}

export interface ReverseSaleResult {
  readonly sale: SaleView;
  readonly replayed: boolean;
}

export interface ReverseSale {
  execute(context: LocationBoundContext, input: ReverseSaleInput): Promise<ReverseSaleResult>;
}

const pointerCodec = {
  encode(value: { readonly saleId: string }): JsonValue {
    return { saleId: value.saleId };
  },
  decode(stored: JsonValue): { readonly saleId: string } {
    return { saleId: textAt(objectAt(stored, "reversal result"), "saleId") };
  },
};

export function createReverseSale(
  dependencies: LedgerPostingDependencies & {
    readonly unitOfWork: UnitOfWork;
    readonly memberships: MembershipRepository;
    readonly sales: SaleRepository;
    readonly inventory: SalesInventoryPort;
    readonly idempotency: KeyedIdempotency;
    readonly hasher: FingerprintHasher;
    readonly audit: AuditRecorder;
    readonly clock: Clock;
  },
): ReverseSale {
  const permission = salesPermissions.permissions["sales:reverse"];
  const posting = createLedgerPostingService(dependencies);
  return {
    async execute(locationContext, input) {
      const actor = requireUserActor(locationContext, permission);
      const context = requireLocationBound(locationContext);
      let saleId: SaleId;
      try {
        saleId = parseSaleId(input.saleId);
      } catch (error) {
        throw error instanceof DomainError || error instanceof KernelError
          ? toApplicationError(error, "saleId")
          : error;
      }
      const key = requireIdempotencyKey(input.idempotencyKey);
      if (!input.tenderUnwoundConfirmed) {
        throw new ValidationError("tenderUnwoundConfirmed must be true", [
          { path: ["tenderUnwoundConfirmed"], message: "must be true" },
        ]);
      }
      let reason: string;
      try {
        reason = parseSaleReversalReason(input.reason);
      } catch (error) {
        throw error instanceof DomainError ? toApplicationError(error, "reason") : error;
      }
      return dependencies.unitOfWork.run(async (scope) => {
        const command = canonicalCommandEncoding({
          operation: REVERSE_SALE_OPERATION,
          commandSchemaVersion: 1,
          command: { locationId: context.locationId, saleId, reason, tenderUnwoundConfirmed: true },
        });
        const fingerprint = await dependencies.hasher.fingerprint(command);
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "sale_reversal",
          codec: pointerCodec,
          plan: () =>
            Promise.resolve({
              result: { saleId },
              resourceId: saleId,
              apply: async () => {
                const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
                const current = await dependencies.sales.findByIdForUpdate(scope, context.businessId, saleId);
                if (current === undefined || current.locationId !== context.locationId)
                  throw new NotFoundError("Sale not found");
                if (current.status === "REVERSED" || current.journalEntryId === undefined) {
                  throw new ConflictError("This sale is already reversed");
                }
                const variantIds = [...new Set(current.stockEffects.map((effect) => effect.variantId))];
                const positions = await dependencies.inventory.lockForSale(
                  scope,
                  context.businessId,
                  context.locationId,
                  variantIds,
                );
                const reversalPlan = planSaleStockReversal(
                  current.stockEffects,
                  new Map(positions.map((position) => [position.variantId, position])),
                );
                await dependencies.inventory.applyReversalPlan(
                  scope,
                  context.businessId,
                  context.locationId,
                  context.currency,
                  reversalPlan,
                );
                const reversedAt = dependencies.clock.now();
                const posted = await posting.post(scope, context, {
                  plan: reversePostingPlan(salePostedPlan(current)),
                  source: { kind: "sale", id: current.id },
                  entryKind: "REVERSAL",
                  reversesEntryId: current.journalEntryId,
                  postingRule: SALE_POSTED_RULE,
                  postingRuleVersion: SALE_POSTED_VERSION,
                  description: `Reversal ${current.receiptNumber}`,
                  occurredAt: reversedAt,
                });
                const reversed = reverseSale(current, {
                  reversedAt,
                  reversedByMembershipId: membership.id,
                  reason,
                  reversalJournalEntryId: posted.entry.id,
                  tenderUnwoundConfirmed: true,
                });
                await dependencies.sales.markReversed(scope, reversed);
                await dependencies.audit.recordBusinessEvent(scope, saleReversed, {
                  ...businessAuditEnvelope(context, key),
                  locationId: context.locationId,
                  entityId: current.id,
                  reason,
                  payload: {
                    receiptNumber: current.receiptNumber,
                    reversalJournalEntryId: posted.entry.id,
                    tenderUnwoundConfirmed: true,
                  },
                });
              },
            }),
        });
        const stored = await dependencies.sales.findById(scope, context.businessId, saleId);
        if (stored === undefined || stored.locationId !== context.locationId) throw new NotFoundError("Sale not found");
        if (outcome.result.saleId !== saleId) throw new NotFoundError("Sale not found");
        const includeCost = hasPermission(context.permissions, inventoryPermissions.permissions["inventory:cost-read"]);
        return { sale: presentSale(stored, includeCost), replayed: outcome.replayed };
      });
    },
  };
}
