import {
  ConcurrentModificationError,
  type InventoryMovementRepository,
  type InventoryMovementValuationRepository,
  type InventoryValuationRepository,
  type SalesInventoryPort,
  type StockBalanceRepository,
  type TransactionScope,
} from "@tali/application";
import type {
  BusinessId,
  CurrencyCode,
  InventoryMovement,
  InventoryMovementId,
  InventoryMovementValuation,
  InventoryRecording,
  JournalEntryId,
  LocationId,
  ProductVariantId,
  SaleId,
  SaleStockPosition,
  ValuationStatus,
} from "@tali/domain";
import { Money, Quantity, parseUnitCode, restoreMovement } from "@tali/domain";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

/** One planned SALE movement, original or reversal, in the shape both plans share. */
interface PlannedStep {
  readonly movementId: InventoryMovementId;
  readonly variantId: ProductVariantId;
  readonly quantityDeltaMinor: bigint;
  readonly quantityAfterMinor: bigint;
  readonly balanceVersionRead: number;
  readonly nextBalanceVersion: number;
  readonly valuationVersionRead: number;
  readonly nextValuationVersion: number;
  readonly valueDeltaMinor: bigint;
  readonly nextValueMinor: bigint;
  readonly nextValuationStatus: ValuationStatus;
  readonly costBasis: InventoryMovementValuation["costBasis"];
  readonly journalEntryId: JournalEntryId | undefined;
  readonly reversesMovementId?: InventoryMovementId;
}

interface StepWrite {
  readonly businessId: BusinessId;
  readonly locationId: LocationId;
  readonly currency: CurrencyCode;
  readonly saleId: SaleId;
  readonly recording: InventoryRecording;
  readonly reasonNote?: string;
  readonly steps: readonly PlannedStep[];
}

/**
 * The PostgreSQL sales stock boundary (ADR-011 section 14; ADR-009 section
 * 28). `lockForSale` reuses the balance and valuation locks: balances FOR
 * UPDATE in ascending variant id (created at version 0 when absent), then
 * valuations FOR UPDATE in ascending variant id (created UNVALUED when
 * absent). It keeps no lock state: the apply methods write the movements and
 * facts of an already-decided plan, then move each projection from the
 * version the plan read to the version it planned, and any other stored
 * version is a ConcurrentModificationError. Nothing here computes a quantity,
 * a cost or a status.
 */
export function createSalesInventoryPort(dependencies: {
  readonly balances: StockBalanceRepository;
  readonly valuations: InventoryValuationRepository;
  readonly movements: InventoryMovementRepository;
  readonly movementValuations: InventoryMovementValuationRepository;
}): SalesInventoryPort {
  async function apply(scope: TransactionScope, write: StepWrite): Promise<void> {
    if (write.steps.length === 0) return;
    const client = transactionClient(scope);
    const variantIds = [...new Set(write.steps.map((step) => step.variantId))].sort();
    const units = await client.$queryRaw<{ id: string; stock_unit_code: string }[]>`
      SELECT id::text AS id, stock_unit_code FROM product_variants
      WHERE business_id = ${write.businessId}::uuid AND id = ANY(${variantIds}::uuid[])`;
    const unitOf = new Map(units.map((row) => [row.id, parseUnitCode(row.stock_unit_code)]));

    const chains = new Map<ProductVariantId, PlannedStep[]>();
    for (const step of write.steps) {
      const chain = chains.get(step.variantId) ?? [];
      const previous = chain.at(-1);
      if (
        previous !== undefined &&
        (step.balanceVersionRead !== previous.nextBalanceVersion ||
          step.valuationVersionRead !== previous.nextValuationVersion)
      ) {
        throw new Error("a sale stock plan must chain the versions of a repeated variant");
      }
      if (
        step.nextBalanceVersion !== step.balanceVersionRead + 1 ||
        step.nextValuationVersion !== step.valuationVersionRead + 1
      ) {
        throw new Error("a sale stock step moves each projection by exactly one version");
      }
      chains.set(step.variantId, [...chain, step]);
    }

    const movements: InventoryMovement[] = write.steps.map((step) => {
      const unit = unitOf.get(step.variantId);
      if (unit === undefined) throw new Error("a sale stock step names a variant of another business");
      return restoreMovement({
        id: step.movementId,
        businessId: write.businessId,
        locationId: write.locationId,
        variantId: step.variantId,
        type: "SALE",
        delta: Quantity.ofMinor(step.quantityDeltaMinor, unit),
        balanceAfter: Quantity.ofMinor(step.quantityAfterMinor, unit),
        balanceVersion: step.nextBalanceVersion,
        source: { kind: "SALE", id: write.saleId },
        ...(step.reversesMovementId === undefined ? {} : { reversesMovementId: step.reversesMovementId }),
        ...(write.reasonNote === undefined ? {} : { reasonNote: write.reasonNote }),
        ...write.recording,
      });
    });
    await dependencies.movements.insertMany(scope, movements);
    await dependencies.movementValuations.insertMany(
      scope,
      write.steps.map((step) => {
        if (step.costBasis === "NOT_VALUED" ? step.valueDeltaMinor !== 0n : step.journalEntryId === undefined) {
          throw new Error("a sale valuation fact must match its cost basis");
        }
        return Object.freeze({
          businessId: write.businessId,
          movementId: step.movementId,
          costBasis: step.costBasis,
          valueDeltaMinor: step.valueDeltaMinor,
          valueAfter: Money.ofMinor(step.nextValueMinor, write.currency),
          statusAfter: step.nextValuationStatus,
          suppliedCostMinor: undefined,
          journalEntryId: step.journalEntryId,
        });
      }),
    );

    for (const variantId of variantIds) {
      const chain = chains.get(variantId) ?? [];
      const first = chain[0];
      const last = chain.at(-1);
      if (first === undefined || last === undefined) continue;
      const balances = await client.$executeRaw`
        UPDATE inventory_balances
        SET quantity_minor = ${last.quantityAfterMinor}::bigint, version = ${last.nextBalanceVersion}::int,
            last_movement_id = ${last.movementId}::uuid, updated_at = statement_timestamp()
        WHERE business_id = ${write.businessId}::uuid AND location_id = ${write.locationId}::uuid
          AND variant_id = ${variantId}::uuid AND version = ${first.balanceVersionRead}::int`;
      if (balances !== 1) throw new ConcurrentModificationError();
      const valuations = await client.$executeRaw`
        UPDATE inventory_valuations
        SET value_minor = ${last.nextValueMinor}::bigint, version = ${last.nextValuationVersion}::int,
            updated_at = statement_timestamp()
        WHERE business_id = ${write.businessId}::uuid AND location_id = ${write.locationId}::uuid
          AND variant_id = ${variantId}::uuid AND version = ${first.valuationVersionRead}::int
          AND status = ${last.nextValuationStatus}`;
      if (valuations !== 1) throw new ConcurrentModificationError();
    }
  }

  return {
    async lockForSale(scope, businessId, locationId, variantIds) {
      const requested = new Set(variantIds);
      const balances = await dependencies.balances.lockForUpdate(scope, businessId, locationId, requested);
      const valuations = await dependencies.valuations.lockForUpdate(scope, balances, requested);
      return [...requested].sort().map((variantId): SaleStockPosition => {
        const balance = balances.balances.find((row) => row.variantId === variantId);
        const valuation = valuations.valuations.find((row) => row.variantId === variantId);
        if (balance === undefined || valuation === undefined) throw new Error("every requested stock item is locked");
        return Object.freeze({
          variantId,
          quantityMinor: balance.quantity.amountMinor,
          balanceVersion: balance.version,
          valuationStatus: valuation.status,
          valueMinor: valuation.value.amountMinor,
          valuationVersion: valuation.version,
        });
      });
    },

    async applySalePlan(scope, write) {
      await apply(scope, {
        businessId: write.businessId,
        locationId: write.locationId,
        currency: write.currency,
        saleId: write.saleId,
        recording: write.recording,
        steps: write.effects.map((effect) => ({
          movementId: effect.movementId,
          variantId: effect.variantId,
          quantityDeltaMinor: effect.quantityDeltaMinor,
          quantityAfterMinor: effect.quantityAfterMinor,
          balanceVersionRead: effect.balanceVersionRead,
          nextBalanceVersion: effect.nextBalanceVersion,
          valuationVersionRead: effect.valuationVersionRead,
          nextValuationVersion: effect.nextValuationVersion,
          valueDeltaMinor: effect.valueDeltaMinor,
          nextValueMinor: effect.nextValueMinor,
          nextValuationStatus: effect.nextValuationStatus,
          costBasis: effect.costStatus === "VALUED" ? "WEIGHTED_AVERAGE" : "NOT_VALUED",
          journalEntryId: effect.costStatus === "VALUED" ? write.journalEntryId : undefined,
        })),
      });
    },

    async applyReversalPlan(scope, write) {
      await apply(scope, {
        businessId: write.businessId,
        locationId: write.locationId,
        currency: write.currency,
        saleId: write.saleId,
        recording: write.recording,
        reasonNote: write.reason,
        steps: write.reversals.map(({ movementId, originalCostStatus, plan }) => ({
          movementId,
          variantId: plan.variantId,
          quantityDeltaMinor: plan.quantityDeltaMinor,
          quantityAfterMinor: plan.quantityAfterMinor,
          balanceVersionRead: plan.balanceVersionRead,
          nextBalanceVersion: plan.nextBalanceVersion,
          valuationVersionRead: plan.valuationVersionRead,
          nextValuationVersion: plan.nextValuationVersion,
          valueDeltaMinor: plan.valueDeltaMinor,
          nextValueMinor: plan.nextValueMinor,
          nextValuationStatus: plan.nextValuationStatus,
          costBasis: originalCostStatus === "VALUED" ? "REVERSAL_OF_ORIGINAL" : "NOT_VALUED",
          journalEntryId: originalCostStatus === "VALUED" ? write.journalEntryId : undefined,
          reversesMovementId: plan.originalMovementId,
        })),
      });
    },
  };
}
