import type { InventoryMovementValuationRepository } from "@tali/application";
import type { InventoryMovementValuation } from "@tali/domain";
import {
  Money,
  parseBusinessId,
  parseCurrencyCode,
  parseInventoryMovementId,
  parseMovementCostBasis,
  parseValuationStatus,
} from "@tali/domain";
import type { InventoryMovementValuation as MovementValuationRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

function toFact(row: MovementValuationRow): InventoryMovementValuation {
  const currency = parseCurrencyCode(row.currency);
  return Object.freeze({
    businessId: parseBusinessId(row.businessId),
    movementId: parseInventoryMovementId(row.movementId),
    costBasis: parseMovementCostBasis(row.costBasis),
    valueDeltaMinor: row.valueDeltaMinor,
    valueAfter: Money.ofMinor(row.valueAfterMinor, currency),
    statusAfter: parseValuationStatus(row.statusAfter),
    suppliedCostMinor: row.suppliedCostMinor ?? undefined,
    journalEntryId: row.journalEntryId ?? undefined,
  });
}

export function createInventoryMovementValuationRepository(): InventoryMovementValuationRepository {
  return {
    async insertMany(scope, rows) {
      if (rows.length === 0) return;
      await transactionClient(scope).inventoryMovementValuation.createMany({
        data: rows.map((row) => ({
          businessId: row.businessId,
          movementId: row.movementId,
          costBasis: row.costBasis,
          valueDeltaMinor: row.valueDeltaMinor,
          valueAfterMinor: row.valueAfter.amountMinor,
          currency: row.valueAfter.currency,
          statusAfter: row.statusAfter,
          suppliedCostMinor: row.suppliedCostMinor ?? null,
          journalEntryId: row.journalEntryId ?? null,
        })),
      });
    },

    async findByMovement(scope, businessId, movementId) {
      const row = await transactionClient(scope).inventoryMovementValuation.findUnique({
        where: { businessId_movementId: { businessId, movementId } },
      });
      return row === null ? undefined : toFact(row);
    },

    async listForMovements(scope, businessId, movementIds) {
      if (movementIds.length === 0) return [];
      const rows = await transactionClient(scope).inventoryMovementValuation.findMany({
        where: { businessId, movementId: { in: [...movementIds] } },
      });
      return rows.map(toFact);
    },
  };
}
