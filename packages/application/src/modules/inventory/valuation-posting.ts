import type {
  InventoryMovement,
  InventoryMovementValuation,
  InventoryValuationState,
  MovementCostBasis,
  PostingPlanLineInput,
  StockValuationDocument,
  StockValuationKind,
  SystemAccountRole,
  ValuationStatus,
} from "@tali/domain";
import {
  Money,
  allocateProportionalMinor,
  createPostingPlan,
  hasEverBeenValued,
  nextValuationVersion,
  parseStockValuationId,
  restoreStockValuation,
  reversePostingPlan,
} from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import type { LocationBoundContext } from "../../context/business-context.js";
import { ConflictError } from "../../errors/application-error.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import { createLedgerPostingService } from "../ledger/posting.js";
import type { LedgerPostingDependencies, LedgerPostingService } from "../ledger/posting.js";
import type { JournalEntry, JournalSourceRef } from "../ledger/index.js";
import { inventoryValuationRecorded } from "./audit-actions.js";
import type {
  InventoryMovementValuationRepository,
  InventoryValuationRepository,
  LockedValuations,
  StockValuationRepository,
} from "./ports.js";

export interface ValuationPostingDependencies extends LedgerPostingDependencies {
  readonly valuations: InventoryValuationRepository;
  readonly movementValuations: InventoryMovementValuationRepository;
  readonly stockValuations: StockValuationRepository;
}

export function createInventoryLedgerPosting(dependencies: LedgerPostingDependencies): LedgerPostingService {
  return createLedgerPostingService(dependencies);
}

export interface LineCost {
  readonly variantId: string;
  readonly totalCost: Money | undefined;
}

export type ReversalResidualKind = "NEGATIVE_VALUE" | "ZERO_QTY_LEFTOVER";

export interface PlannedReversalResidual {
  readonly kind: ReversalResidualKind;
  readonly rawValue: Money;
}

export interface PlannedMovementValuation {
  readonly movement: InventoryMovement;
  readonly fact: Omit<InventoryMovementValuation, "journalEntryId">;
  readonly next: InventoryValuationState;
  readonly postingLines: readonly PostingPlanLineInput[];
  /** Same-transaction ORIGINAL residual; never appended to the REVERSAL journal. */
  readonly residual?: PlannedReversalResidual;
}

function moneyOf(amountMinor: bigint, currency: InventoryValuationState["value"]["currency"]): Money {
  return Money.ofMinor(amountMinor, currency);
}

function withNext(
  current: InventoryValuationState,
  props: {
    readonly status: ValuationStatus;
    readonly value: Money;
    readonly firstValuedAt: Date | undefined;
  },
): InventoryValuationState {
  return Object.freeze({
    ...current,
    status: props.status,
    value: props.value,
    firstValuedAt: props.firstValuedAt,
    version: nextValuationVersion(current),
  });
}

function inventoryLines(
  debitRole: SystemAccountRole,
  creditRole: SystemAccountRole,
  amount: Money,
  memoKind: PostingPlanLineInput["memoKind"],
): PostingPlanLineInput[] {
  if (!amount.isPositive()) return [];
  return [
    { role: debitRole, direction: "DEBIT", amount, ...(memoKind === undefined ? {} : { memoKind }) },
    {
      role: creditRole,
      direction: "CREDIT",
      amount,
      ...(memoKind === undefined ? {} : { memoKind }),
    },
  ];
}

function fact(
  movement: InventoryMovement,
  current: InventoryValuationState,
  props: {
    readonly costBasis: MovementCostBasis;
    readonly valueDeltaMinor: bigint;
    readonly statusAfter: ValuationStatus;
    readonly valueAfter: Money;
    readonly suppliedCostMinor: bigint | undefined;
  },
): Omit<InventoryMovementValuation, "journalEntryId"> {
  return Object.freeze({
    businessId: movement.businessId,
    movementId: movement.id,
    costBasis: props.costBasis,
    valueDeltaMinor: props.valueDeltaMinor,
    valueAfter: props.valueAfter,
    statusAfter: props.statusAfter,
    suppliedCostMinor: props.suppliedCostMinor,
  });
}

function openingEffect(
  movement: InventoryMovement,
  current: InventoryValuationState,
  supplied: Money | undefined,
  now: Date,
): PlannedMovementValuation {
  const suppliedMinor = supplied?.amountMinor;
  const neverValued = !hasEverBeenValued(current);
  const firstOpening = current.startedFromBalanceVersion === 0 && movement.balanceVersion === 1;
  if (neverValued && firstOpening && supplied !== undefined) {
    const next = withNext(current, { status: "VALUED", value: supplied, firstValuedAt: now });
    return {
      movement,
      next,
      fact: fact(movement, current, {
        costBasis: "SUPPLIED_COST",
        valueDeltaMinor: supplied.amountMinor,
        statusAfter: "VALUED",
        valueAfter: supplied,
        suppliedCostMinor: suppliedMinor,
      }),
      postingLines: inventoryLines("INVENTORY", "OPENING_BALANCE_EQUITY", supplied, "OPENING_VALUATION"),
    };
  }
  const next = withNext(current, {
    status: "UNVALUED",
    value: current.value,
    firstValuedAt: current.firstValuedAt,
  });
  return {
    movement,
    next,
    fact: fact(movement, current, {
      costBasis: "NOT_VALUED",
      valueDeltaMinor: 0n,
      statusAfter: "UNVALUED",
      valueAfter: current.value,
      suppliedCostMinor: suppliedMinor,
    }),
    postingLines: [],
  };
}

function receiptEffect(
  movement: InventoryMovement,
  current: InventoryValuationState,
  supplied: Money | undefined,
): PlannedMovementValuation {
  const suppliedMinor = supplied?.amountMinor;
  if (current.status === "VALUED" && supplied !== undefined) {
    const valueAfter = current.value.add(supplied);
    const next = withNext(current, {
      status: "VALUED",
      value: valueAfter,
      firstValuedAt: current.firstValuedAt,
    });
    return {
      movement,
      next,
      fact: fact(movement, current, {
        costBasis: "SUPPLIED_COST",
        valueDeltaMinor: supplied.amountMinor,
        statusAfter: "VALUED",
        valueAfter,
        suppliedCostMinor: suppliedMinor,
      }),
      postingLines: inventoryLines("INVENTORY", "GOODS_RECEIVED_NOT_INVOICED", supplied, "GOODS_RECEIPT"),
    };
  }
  const unvalued = current.status === "VALUED" && supplied === undefined;
  const next = withNext(current, {
    status: unvalued || current.status === "UNVALUED" ? "UNVALUED" : current.status,
    value: current.value,
    firstValuedAt: current.firstValuedAt,
  });
  return {
    movement,
    next,
    fact: fact(movement, current, {
      costBasis: "NOT_VALUED",
      valueDeltaMinor: 0n,
      statusAfter: next.status,
      valueAfter: current.value,
      suppliedCostMinor: suppliedMinor,
    }),
    postingLines: [],
  };
}

function quantityChangeEffect(
  movement: InventoryMovement,
  current: InventoryValuationState,
  preQuantity: bigint,
): PlannedMovementValuation {
  const delta = movement.delta.amountMinor;
  if (current.status !== "VALUED") {
    const next = withNext(current, {
      status: "UNVALUED",
      value: current.value,
      firstValuedAt: current.firstValuedAt,
    });
    return {
      movement,
      next,
      fact: fact(movement, current, {
        costBasis: "NOT_VALUED",
        valueDeltaMinor: 0n,
        statusAfter: "UNVALUED",
        valueAfter: current.value,
        suppliedCostMinor: undefined,
      }),
      postingLines: [],
    };
  }
  if (delta < 0n) {
    const removed = allocateProportionalMinor(current.value.amountMinor, -delta, preQuantity);
    const valueAfter = moneyOf(current.value.amountMinor - removed, current.value.currency);
    const next = withNext(current, {
      status: "VALUED",
      value: valueAfter,
      firstValuedAt: current.firstValuedAt,
    });
    const amount = moneyOf(removed, current.value.currency);
    return {
      movement,
      next,
      fact: fact(movement, current, {
        costBasis: "WEIGHTED_AVERAGE",
        valueDeltaMinor: -removed,
        statusAfter: "VALUED",
        valueAfter,
        suppliedCostMinor: undefined,
      }),
      postingLines: inventoryLines("INVENTORY_SHRINKAGE", "INVENTORY", amount, "INVENTORY_SHRINKAGE"),
    };
  }
  if (delta > 0n && preQuantity > 0n) {
    const added = allocateProportionalMinor(current.value.amountMinor, delta, preQuantity);
    const valueAfter = moneyOf(current.value.amountMinor + added, current.value.currency);
    const next = withNext(current, {
      status: "VALUED",
      value: valueAfter,
      firstValuedAt: current.firstValuedAt,
    });
    const amount = moneyOf(added, current.value.currency);
    return {
      movement,
      next,
      fact: fact(movement, current, {
        costBasis: "WEIGHTED_AVERAGE",
        valueDeltaMinor: added,
        statusAfter: "VALUED",
        valueAfter,
        suppliedCostMinor: undefined,
      }),
      postingLines: inventoryLines("INVENTORY", "INVENTORY_GAIN", amount, "INVENTORY_GAIN"),
    };
  }
  const next = withNext(current, {
    status: "UNVALUED",
    value: current.value,
    firstValuedAt: current.firstValuedAt,
  });
  return {
    movement,
    next,
    fact: fact(movement, current, {
      costBasis: "NOT_VALUED",
      valueDeltaMinor: 0n,
      statusAfter: "UNVALUED",
      valueAfter: current.value,
      suppliedCostMinor: undefined,
    }),
    postingLines: [],
  };
}

function reversalEffect(
  movement: InventoryMovement,
  current: InventoryValuationState,
  original: InventoryMovementValuation | undefined,
): PlannedMovementValuation {
  if (original === undefined || original.costBasis === "NOT_VALUED" || original.valueDeltaMinor === 0n) {
    const statusAfter: ValuationStatus = "UNVALUED";
    const next = withNext(current, {
      status: statusAfter,
      value: current.value,
      firstValuedAt: current.firstValuedAt,
    });
    return {
      movement,
      next,
      fact: fact(movement, current, {
        costBasis: "NOT_VALUED",
        valueDeltaMinor: 0n,
        statusAfter,
        valueAfter: current.value,
        suppliedCostMinor: original?.suppliedCostMinor,
      }),
      postingLines: [],
    };
  }
  const exactDelta = -original.valueDeltaMinor;
  const rawAfter = current.value.amountMinor + exactDelta;
  const qtyAfter = movement.balanceAfter.amountMinor;
  const rawValue = moneyOf(rawAfter, current.value.currency);
  let residual: PlannedReversalResidual | undefined;
  let finalValue = rawValue;
  if (rawAfter < 0n) {
    residual = { kind: "NEGATIVE_VALUE", rawValue };
    finalValue = moneyOf(0n, current.value.currency);
  } else if (current.status === "VALUED" && qtyAfter === 0n && rawAfter > 0n) {
    residual = { kind: "ZERO_QTY_LEFTOVER", rawValue };
    finalValue = moneyOf(0n, current.value.currency);
  }
  const next = withNext(current, {
    status: current.status,
    value: finalValue,
    firstValuedAt: current.firstValuedAt,
  });
  return {
    movement,
    next,
    fact: fact(movement, current, {
      costBasis: "REVERSAL_OF_ORIGINAL",
      valueDeltaMinor: exactDelta,
      statusAfter: current.status,
      valueAfter: rawValue,
      suppliedCostMinor: original.suppliedCostMinor,
    }),
    postingLines: [],
    ...(residual === undefined ? {} : { residual }),
  };
}

export function planMovementValuations(props: {
  readonly movements: readonly InventoryMovement[];
  readonly currentByVariant: ReadonlyMap<string, InventoryValuationState>;
  readonly preQuantityByVariant: ReadonlyMap<string, bigint>;
  readonly costsByVariant: ReadonlyMap<string, Money>;
  readonly originalFacts: ReadonlyMap<string, InventoryMovementValuation>;
  readonly now: Date;
}): readonly PlannedMovementValuation[] {
  const current = new Map(props.currentByVariant);
  const preQty = new Map(props.preQuantityByVariant);
  const planned: PlannedMovementValuation[] = [];
  for (const movement of props.movements) {
    const state = current.get(movement.variantId);
    if (state === undefined) throw new Error("every movement needs a locked valuation");
    const supplied = props.costsByVariant.get(movement.variantId);
    let row: PlannedMovementValuation;
    if (movement.reversesMovementId !== undefined) {
      row = reversalEffect(movement, state, props.originalFacts.get(movement.reversesMovementId));
    } else if (movement.type === "OPENING") {
      row = openingEffect(movement, state, supplied, props.now);
    } else if (movement.type === "PURCHASE_RECEIPT") {
      row = receiptEffect(movement, state, supplied);
    } else {
      row = quantityChangeEffect(movement, state, preQty.get(movement.variantId) ?? 0n);
    }
    planned.push(row);
    current.set(movement.variantId, row.next);
    preQty.set(movement.variantId, movement.balanceAfter.amountMinor);
  }
  return planned;
}

export function journalSourceOf(kind: InventoryMovement["source"]["kind"], id: string): JournalSourceRef {
  switch (kind) {
    case "OPENING_BATCH":
      return { kind: "opening_batch", id };
    case "GOODS_RECEIPT":
      return { kind: "goods_receipt", id };
    case "ADJUSTMENT":
      return { kind: "adjustment", id };
    case "STOCKTAKE":
      return { kind: "stocktake", id };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function postingRuleFor(kind: InventoryMovement["source"]["kind"]): string {
  switch (kind) {
    case "OPENING_BATCH":
      return "OPENING_STOCK_VALUED";
    case "GOODS_RECEIPT":
      return "GOODS_RECEIPT_VALUED";
    case "ADJUSTMENT":
      return "INVENTORY_ADJUSTMENT_VALUED";
    case "STOCKTAKE":
      return "STOCKTAKE_VALUED";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export async function persistMovementValuations(
  dependencies: ValuationPostingDependencies,
  posting: LedgerPostingService,
  scope: TransactionScope,
  context: BusinessContext,
  props: {
    readonly locked: LockedValuations;
    readonly planned: readonly PlannedMovementValuation[];
    readonly source: JournalSourceRef;
    readonly postingRule: string;
    readonly description: string;
    readonly journalLines?: readonly PostingPlanLineInput[];
    readonly entryKind?: "ORIGINAL" | "REVERSAL";
    readonly reversesEntryId?: string;
    readonly entryId?: string;
  },
): Promise<JournalEntry | undefined> {
  const lines = props.journalLines ?? props.planned.flatMap((row) => row.postingLines);
  let entry: JournalEntry | undefined;
  if (lines.length > 0) {
    const posted = await posting.post(scope, context, {
      plan: createPostingPlan(context.currency, lines),
      source: props.source,
      postingRule: props.postingRule,
      postingRuleVersion: 1,
      description: props.description,
      ...(props.entryKind === undefined ? {} : { entryKind: props.entryKind }),
      ...(props.reversesEntryId === undefined ? {} : { reversesEntryId: props.reversesEntryId }),
      ...(props.entryId === undefined ? {} : { entryId: props.entryId }),
    });
    entry = posted.entry;
  }
  const facts: InventoryMovementValuation[] = props.planned.map((row) =>
    Object.freeze({
      ...row.fact,
      journalEntryId: row.fact.valueDeltaMinor !== 0n ? entry?.id : undefined,
    }),
  );
  if (facts.length > 0) await dependencies.movementValuations.insertMany(scope, facts);
  const nextByVariant = new Map<string, InventoryValuationState>();
  for (const row of props.planned) nextByVariant.set(row.movement.variantId, row.next);
  const next = [...nextByVariant.values()];
  if (next.length > 0) await dependencies.valuations.apply(scope, props.locked, next);
  return entry;
}

export function explicitValuationKind(state: InventoryValuationState): StockValuationKind {
  return state.firstValuedAt === undefined ? "INITIAL_OPENING" : "OPERATIONAL";
}

export function explicitValuationLines(kind: StockValuationKind, difference: Money): readonly PostingPlanLineInput[] {
  if (kind === "REVERSAL_RESIDUAL") {
    throw new ConflictError("a reversal residual is not an explicit stock valuation");
  }
  if (difference.isZero()) return [];
  if (kind === "INITIAL_OPENING") {
    if (difference.isNegative()) {
      throw new ConflictError("an initial opening valuation cannot decrease recorded value");
    }
    return inventoryLines("INVENTORY", "OPENING_BALANCE_EQUITY", difference, "OPENING_VALUATION");
  }
  if (difference.isPositive()) {
    return inventoryLines("INVENTORY", "INVENTORY_GAIN", difference, "OPERATIONAL_VALUATION");
  }
  return inventoryLines("INVENTORY_SHRINKAGE", "INVENTORY", difference.abs(), "OPERATIONAL_VALUATION");
}

async function persistReversalResiduals(
  dependencies: ValuationPostingDependencies & { readonly audit: AuditRecorder },
  posting: LedgerPostingService,
  scope: TransactionScope,
  context: LocationBoundContext,
  planned: readonly PlannedMovementValuation[],
  reason: string,
): Promise<void> {
  for (const row of planned) {
    const residual = row.residual;
    if (residual === undefined) continue;
    const valuationId = dependencies.ids.newId("StockValuation");
    const journalEntryId = dependencies.ids.newId("JournalEntry");
    const amount = residual.rawValue.abs();
    const lines =
      residual.kind === "NEGATIVE_VALUE"
        ? inventoryLines("INVENTORY", "INVENTORY_GAIN", amount, "INVENTORY_GAIN")
        : inventoryLines("INVENTORY_SHRINKAGE", "INVENTORY", amount, "INVENTORY_SHRINKAGE");
    const zero = moneyOf(0n, residual.rawValue.currency);
    const document: StockValuationDocument = restoreStockValuation({
      id: parseStockValuationId(valuationId),
      businessId: context.businessId,
      locationId: context.locationId,
      variantId: row.movement.variantId,
      kind: "REVERSAL_RESIDUAL",
      triggerMovementId: row.movement.id,
      quantityAtValuationMinor: row.movement.balanceAfter.amountMinor,
      balanceVersionAtValuation: row.movement.balanceVersion,
      previousValue: residual.rawValue,
      newValue: zero,
      reason,
      journalEntryId,
      actorMembershipId: row.movement.actorMembershipId,
      sourceChannel: row.movement.sourceChannel,
      correlationId: row.movement.correlationId,
      occurredAt: row.movement.occurredAt,
      businessDate: row.movement.businessDate,
      recordedAt: row.movement.recordedAt,
      ...(row.movement.deviceId === undefined ? {} : { deviceId: row.movement.deviceId }),
    });
    await dependencies.stockValuations.insert(scope, document);
    await posting.post(scope, context, {
      plan: createPostingPlan(context.currency, lines),
      source: { kind: "valuation", id: valuationId },
      postingRule: "INVENTORY_REVERSAL_RESIDUAL",
      postingRuleVersion: 1,
      description: `reversal residual ${valuationId}`,
      entryId: journalEntryId,
    });
    await dependencies.audit.recordBusinessEvent(scope, inventoryValuationRecorded, {
      ...businessAuditEnvelope(context),
      locationId: context.locationId,
      entityId: valuationId,
      reason,
      payload: {
        valuationId,
        kind: "REVERSAL_RESIDUAL",
        variantId: row.movement.variantId,
        quantityMinor: row.movement.balanceAfter.toMinorUnitsString(),
        previousValueMinor: residual.rawValue.toMinorUnitsString(),
        newValueMinor: zero.toMinorUnitsString(),
        journalEntryId,
        triggerMovementId: row.movement.id,
      },
    });
  }
}

export async function persistReversalValuations(
  dependencies: ValuationPostingDependencies & { readonly audit: AuditRecorder },
  posting: LedgerPostingService,
  scope: TransactionScope,
  context: LocationBoundContext,
  props: {
    readonly locked: LockedValuations;
    readonly planned: readonly PlannedMovementValuation[];
    readonly source: JournalSourceRef;
    readonly postingRule: string;
    readonly description: string;
    readonly reason: string;
  },
): Promise<JournalEntry | undefined> {
  const original = await dependencies.journals.findOriginalBySource(scope, context.businessId, props.source);
  const reversalEntry =
    original === undefined
      ? await persistMovementValuations(dependencies, posting, scope, context, {
          locked: props.locked,
          planned: props.planned,
          source: props.source,
          postingRule: props.postingRule,
          description: props.description,
          journalLines: [],
        })
      : await persistMovementValuations(dependencies, posting, scope, context, {
          locked: props.locked,
          planned: props.planned,
          source: props.source,
          postingRule: props.postingRule,
          description: props.description,
          journalLines: reversePostingPlan(
            createPostingPlan(
              original.currency,
              original.lines.map((line) => ({
                role: line.systemRole,
                direction: line.direction,
                amount: line.amount,
                ...(line.memoKind === undefined ? {} : { memoKind: line.memoKind }),
              })),
            ),
          ).lines,
          entryKind: "REVERSAL",
          reversesEntryId: original.id,
        });
  await persistReversalResiduals(dependencies, posting, scope, context, props.planned, props.reason);
  return reversalEntry;
}
