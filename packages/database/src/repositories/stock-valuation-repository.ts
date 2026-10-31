import type { StockValuationRepository } from "@tali/application";
import type { StockValuationDocument } from "@tali/domain";
import {
  Money,
  parseBusinessId,
  parseCurrencyCode,
  parseLocationId,
  parseProductVariantId,
  parseStockValuationId,
  parseStockValuationKind,
  restoreStockValuation,
  restoreTriggerMovementId,
} from "@tali/domain";
import type { StockValuation as StockValuationRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { recordingColumns, recordingProps } from "./inventory-rows.js";

function toDocument(row: StockValuationRow): StockValuationDocument {
  const currency = parseCurrencyCode(row.currency);
  return restoreStockValuation({
    id: parseStockValuationId(row.id),
    businessId: parseBusinessId(row.businessId),
    locationId: parseLocationId(row.locationId),
    variantId: parseProductVariantId(row.variantId),
    kind: parseStockValuationKind(row.kind),
    ...(row.triggerMovementId === null ? {} : { triggerMovementId: restoreTriggerMovementId(row.triggerMovementId) }),
    quantityAtValuationMinor: row.quantityAtValuationMinor,
    balanceVersionAtValuation: row.balanceVersionAtValuation,
    previousValue: Money.ofMinor(row.previousValueMinor, currency),
    newValue: Money.ofMinor(row.newValueMinor, currency),
    reason: row.reason,
    journalEntryId: row.journalEntryId ?? undefined,
    ...recordingProps(row),
  });
}

export function createStockValuationRepository(): StockValuationRepository {
  return {
    async insert(scope, document) {
      const stored = restoreStockValuation(document);
      await transactionClient(scope).stockValuation.create({
        data: {
          businessId: stored.businessId,
          id: stored.id,
          locationId: stored.locationId,
          variantId: stored.variantId,
          kind: stored.kind,
          triggerMovementId: stored.triggerMovementId ?? null,
          quantityAtValuationMinor: stored.quantityAtValuationMinor,
          balanceVersionAtValuation: stored.balanceVersionAtValuation,
          previousValueMinor: stored.previousValue.amountMinor,
          newValueMinor: stored.newValue.amountMinor,
          currency: stored.newValue.currency,
          reason: stored.reason,
          journalEntryId: stored.journalEntryId ?? null,
          ...recordingColumns(stored),
        },
      });
    },

    async findById(scope, businessId, id) {
      const row = await transactionClient(scope).stockValuation.findUnique({
        where: { businessId_id: { businessId, id } },
      });
      return row === null ? undefined : toDocument(row);
    },

    async findByTriggerMovement(scope, businessId, triggerMovementId) {
      const row = await transactionClient(scope).stockValuation.findFirst({
        where: { businessId, triggerMovementId },
      });
      return row === null ? undefined : toDocument(row);
    },
  };
}
