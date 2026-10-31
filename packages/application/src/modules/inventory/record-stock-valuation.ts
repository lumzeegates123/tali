import type { CurrencyCode, InventoryValuationState, StockValuationDocument } from "@tali/domain";
import {
  Money,
  createPostingPlan,
  parseCurrencyCode,
  parseProductVariantId,
  parseStockValuationId,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { ConflictError, NotFoundError, ValuationStaleError, ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership, requireUserActor } from "../business/index.js";
import type { ProductRepository } from "../catalog/index.js";
import { PRODUCT_NOT_FOUND } from "../catalog/index.js";
import { inventoryPermissions } from "../identity/index.js";
import { createLedgerPostingService } from "../ledger/posting.js";
import { inventoryValuationRecorded } from "./audit-actions.js";
import type { StockBalanceRepository, StockValuationRepository } from "./ports.js";
import { planRecording } from "./stock-document.js";
import type { ValuationPostingDependencies } from "./valuation-posting.js";
import { explicitValuationKind, explicitValuationLines } from "./valuation-posting.js";

export const RECORD_STOCK_VALUATION_OPERATION = "inventory.stock_valuation.record.v1";

export interface RecordStockValuationInput {
  readonly variantId: string;
  readonly expectedBalanceVersion: number;
  readonly newTotalValue: { readonly amountMinor: string; readonly currency: string };
  readonly reason: string;
  readonly idempotencyKey: string | undefined;
}

export interface RecordStockValuationResult {
  readonly valuationId: string;
  readonly kind: "INITIAL_OPENING" | "OPERATIONAL";
  readonly replayed: boolean;
}

export interface RecordStockValuation {
  execute(context: LocationBoundContext, input: RecordStockValuationInput): Promise<RecordStockValuationResult>;
}

function parseNewValue(input: RecordStockValuationInput, currency: CurrencyCode): Money {
  const money = withDomainRules(
    () => Money.fromMinorUnitsString(input.newTotalValue.amountMinor, parseCurrencyCode(input.newTotalValue.currency)),
    "newTotalValue",
  );
  if (money.isNegative()) {
    throw new ValidationError("new total value cannot be negative", [
      { path: ["newTotalValue"], message: "must be >= 0" },
    ]);
  }
  if (money.currency !== currency) {
    throw new ValidationError("new total value currency must match the business currency", [
      { path: ["newTotalValue", "currency"], message: "CURRENCY_MISMATCH" },
    ]);
  }
  return money;
}

export function nextProjection(current: InventoryValuationState, newValue: Money, now: Date): InventoryValuationState {
  return Object.freeze({
    ...current,
    status: "VALUED" as const,
    value: newValue,
    firstValuedAt: current.firstValuedAt ?? now,
    version: current.version + 1,
  });
}

export function createRecordStockValuation(
  dependencies: ValuationPostingDependencies & {
    readonly unitOfWork: UnitOfWork;
    readonly memberships: MembershipRepository;
    readonly products: ProductRepository;
    readonly balances: StockBalanceRepository;
    readonly stockValuations: StockValuationRepository;
    readonly audit: AuditRecorder;
    readonly idempotency: KeyedIdempotency;
    readonly hasher: FingerprintHasher;
  },
): RecordStockValuation {
  const permission = inventoryPermissions.permissions["inventory:value"];
  const posting = createLedgerPostingService(dependencies);
  return {
    async execute(locationContext, input) {
      const actor = requireUserActor(locationContext, permission);
      const context = requireLocationBound(locationContext);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const variantId = withDomainRules(() => parseProductVariantId(input.variantId), "variantId");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (reason.length < 1 || reason.length > 500) {
        throw new ValidationError("a valuation reason of 1 to 500 characters is required", [
          { path: ["reason"], message: "required" },
        ]);
      }
      if (!Number.isSafeInteger(input.expectedBalanceVersion) || input.expectedBalanceVersion < 0) {
        throw new ValidationError("expectedBalanceVersion is invalid", [
          { path: ["expectedBalanceVersion"], message: "invalid" },
        ]);
      }
      const newValue = parseNewValue(input, context.currency);
      return dependencies.unitOfWork.run(async (scope) => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const command = canonicalCommandEncoding({
          operation: RECORD_STOCK_VALUATION_OPERATION,
          commandSchemaVersion: 1,
          command: {
            locationId: context.locationId,
            variantId,
            expectedBalanceVersion: input.expectedBalanceVersion,
            newTotalValue: input.newTotalValue,
            reason,
          },
        });
        const fingerprint = await dependencies.hasher.fingerprint(command);
        const codec = {
          encode: (value: RecordStockValuationResult) => ({ valuationId: value.valuationId }),
          decode: (stored: unknown) => {
            const row = stored as { readonly valuationId: string };
            return { valuationId: row.valuationId, kind: "OPERATIONAL" as const, replayed: true };
          },
        };
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "stock_valuation",
          codec,
          plan: () => {
            const id = dependencies.ids.newId("StockValuation");
            return Promise.resolve({
              result: { valuationId: id, kind: "OPERATIONAL" as const, replayed: false },
              resourceId: id,
              apply: async () => {
                const variants = await dependencies.products.lockVariantsForShare(
                  scope,
                  context.businessId,
                  new Set([variantId]),
                );
                const variant = variants.get(variantId);
                if (variant?.businessId !== context.businessId) throw new NotFoundError(PRODUCT_NOT_FOUND);
                if (!variant.trackInventory) throw new ConflictError("This product does not track inventory");
                const lockedBalances = await dependencies.balances.lockForUpdate(
                  scope,
                  context.businessId,
                  context.locationId,
                  new Set([variantId]),
                );
                const balance = lockedBalances.balances[0];
                if (balance === undefined) throw new Error("the stock item must be locked");
                if (balance.version !== input.expectedBalanceVersion) throw new ValuationStaleError();
                const locked = await dependencies.valuations.lockForUpdate(scope, lockedBalances, new Set([variantId]));
                const current = locked.valuations[0];
                if (current === undefined) throw new Error("the valuation row must be locked");
                if (current.status === "VALUED") {
                  throw new ConflictError("only an UNVALUED item can be valued");
                }
                const kind = explicitValuationKind(current);
                const recording = planRecording(dependencies.clock, context, membership.id);
                const next = nextProjection(current, newValue, recording.occurredAt);
                const difference = newValue.subtract(current.value);
                const lines = explicitValuationLines(kind, difference);
                const journalEntryId = lines.length > 0 ? dependencies.ids.newId("JournalEntry") : undefined;
                const document: StockValuationDocument = {
                  id: parseStockValuationId(id),
                  businessId: context.businessId,
                  locationId: context.locationId,
                  variantId,
                  kind,
                  quantityAtValuationMinor: balance.quantity.amountMinor,
                  balanceVersionAtValuation: balance.version,
                  previousValue: current.value,
                  newValue,
                  reason,
                  journalEntryId,
                  actorMembershipId: recording.actorMembershipId,
                  sourceChannel: recording.sourceChannel,
                  correlationId: recording.correlationId,
                  occurredAt: recording.occurredAt,
                  businessDate: recording.businessDate,
                  recordedAt: recording.recordedAt,
                  ...(recording.deviceId === undefined ? {} : { deviceId: recording.deviceId }),
                };
                await dependencies.stockValuations.insert(scope, document);
                if (lines.length > 0 && journalEntryId !== undefined) {
                  await posting.post(scope, context, {
                    plan: createPostingPlan(context.currency, lines),
                    source: { kind: "valuation", id },
                    postingRule: kind === "INITIAL_OPENING" ? "INITIAL_OPENING_VALUATION" : "OPERATIONAL_VALUATION",
                    postingRuleVersion: 1,
                    description: `stock valuation ${id}`,
                    entryId: journalEntryId,
                  });
                }
                await dependencies.valuations.apply(scope, locked, [next]);
                await dependencies.audit.recordBusinessEvent(scope, inventoryValuationRecorded, {
                  ...businessAuditEnvelope(context, key),
                  locationId: context.locationId,
                  entityId: id,
                  reason,
                  payload: {
                    valuationId: id,
                    kind,
                    variantId,
                    quantityMinor: balance.quantity.toMinorUnitsString(),
                    previousValueMinor: current.value.toMinorUnitsString(),
                    newValueMinor: newValue.toMinorUnitsString(),
                    ...(journalEntryId === undefined ? {} : { journalEntryId }),
                  },
                });
              },
            });
          },
        });
        const stored = await dependencies.stockValuations.findById(
          scope,
          context.businessId,
          parseStockValuationId(outcome.result.valuationId),
        );
        if (stored === undefined) throw new Error("a recorded stock valuation must exist");
        if (stored.kind === "REVERSAL_RESIDUAL") {
          throw new Error("an explicit stock valuation cannot be a reversal residual");
        }
        return { valuationId: stored.id, kind: stored.kind, replayed: outcome.replayed };
      });
    },
  };
}
