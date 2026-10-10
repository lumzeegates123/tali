import type { StocktakeLineRepository } from "@tali/application";
import { assertStocktakeLineTransition, ConcurrentModificationError } from "@tali/application";
import type { StocktakeLine } from "@tali/domain";
import {
  parseBusinessId,
  parseMembershipId,
  parseProductVariantId,
  parseStocktakeId,
  parseUnitCode,
  Quantity,
  restoreStocktakeLine,
} from "@tali/domain";
import type { StocktakeLine as StocktakeLineRow } from "../generated/prisma/client.js";
import { uniqueViolationConstraint } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { lineCountsFor, lineCountsOf } from "./stocktake-repository.js";

/** Quantities are stored in minor units of the stock unit recorded on the line at count time. */
function toLine(row: StocktakeLineRow): StocktakeLine {
  const unit = parseUnitCode(row.stockUnitCode);
  return restoreStocktakeLine({
    businessId: parseBusinessId(row.businessId),
    stocktakeId: parseStocktakeId(row.stocktakeId),
    variantId: parseProductVariantId(row.variantId),
    status: row.status,
    countedQuantity: Quantity.ofMinor(row.countedQuantityMinor, unit),
    stockUnitAtCount: unit,
    expectedAtCount: Quantity.ofMinor(row.expectedAtCountMinor, unit),
    balanceVersionAtCount: row.balanceVersionAtCount,
    version: row.version,
    countedByMembershipId: parseMembershipId(row.countedByMembershipId),
    countedAt: row.countedAt,
    ...(row.varianceMinor === null ? {} : { variance: Quantity.ofMinor(row.varianceMinor, unit) }),
  });
}

/** The count fields a recount or removal writes; the variance is written only by posting. */
function countColumns(line: StocktakeLine) {
  return {
    status: line.status,
    countedQuantityMinor: line.countedQuantity.amountMinor,
    stockUnitCode: line.stockUnitAtCount,
    expectedAtCountMinor: line.expectedAtCount.amountMinor,
    balanceVersionAtCount: line.balanceVersionAtCount,
    version: line.version,
    countedByMembershipId: line.countedByMembershipId,
    countedAt: line.countedAt,
  };
}

/**
 * Stocktake lines (tenant-owned; ADR-008 section 12), keyed by (business_id,
 * stocktake_id, variant_id). Every read and write is scoped by business.
 * Lines are never deleted or upserted: a removed line is status REMOVED, and
 * an insert that meets an existing line lost a race the header lock should
 * have prevented, so it is a concurrent modification.
 */
export function createStocktakeLineRepository(): StocktakeLineRepository {
  return {
    async find(scope, businessId, stocktakeId, variantId) {
      const row = await transactionClient(scope).stocktakeLine.findUnique({
        where: { businessId_stocktakeId_variantId: { businessId, stocktakeId, variantId } },
      });
      return row === null ? undefined : toLine(row);
    },

    async insert(scope, line) {
      if (line.version !== 1 || line.status !== "COUNTED" || line.variance !== undefined) {
        throw new Error("a stocktake line is inserted COUNTED at version 1 without a variance");
      }
      try {
        await transactionClient(scope).stocktakeLine.create({
          data: {
            businessId: line.businessId,
            stocktakeId: line.stocktakeId,
            variantId: line.variantId,
            ...countColumns(line),
          },
        });
      } catch (error) {
        if (uniqueViolationConstraint(error) === "stocktake_lines_pkey") {
          throw new ConcurrentModificationError(undefined, { cause: error });
        }
        throw error;
      }
    },

    async update(scope, previous, next) {
      assertStocktakeLineTransition(previous, next);
      const { count } = await transactionClient(scope).stocktakeLine.updateMany({
        where: {
          businessId: previous.businessId,
          stocktakeId: previous.stocktakeId,
          variantId: previous.variantId,
          version: previous.version,
        },
        data: countColumns(next),
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },

    async listCounted(scope, businessId, stocktakeId) {
      const rows = await transactionClient(scope).stocktakeLine.findMany({
        where: { businessId, stocktakeId, status: "COUNTED" },
        orderBy: { variantId: "asc" },
      });
      return rows.map(toLine);
    },

    async listPage(scope, businessId, stocktakeId, request) {
      const rows = await transactionClient(scope).stocktakeLine.findMany({
        where: {
          businessId,
          stocktakeId,
          ...(request.after === undefined ? {} : { variantId: { gt: request.after } }),
        },
        orderBy: { variantId: "asc" },
        take: request.limit + 1,
      });
      const selected = rows.slice(0, request.limit);
      const last = selected.at(-1);
      return {
        items: selected.map(toLine),
        nextCursor: rows.length > request.limit && last !== undefined ? last.variantId : null,
      };
    },

    async countForStocktake(scope, businessId, stocktakeId) {
      return transactionClient(scope).stocktakeLine.count({ where: { businessId, stocktakeId } });
    },

    async countByStatus(scope, businessId, stocktakeId) {
      const counts = await lineCountsOf(transactionClient(scope), businessId, [stocktakeId]);
      return lineCountsFor(counts, stocktakeId);
    },

    async applyPostingVariances(scope, businessId, stocktakeId, variances) {
      const ordered = [...variances].sort((a, b) =>
        a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
      );
      if (new Set(ordered.map((row) => row.variantId)).size !== ordered.length) {
        throw new Error("a posting variance is written once per line");
      }
      const client = transactionClient(scope);
      for (const row of ordered) {
        const { count } = await client.stocktakeLine.updateMany({
          where: {
            businessId,
            stocktakeId,
            variantId: row.variantId,
            status: "COUNTED",
            version: row.lineVersion,
            stockUnitCode: row.variance.unit,
            varianceMinor: null,
          },
          data: { varianceMinor: row.variance.amountMinor },
        });
        if (count !== 1) throw new ConcurrentModificationError();
      }
    },
  };
}
