import type { StocktakeLineCounts, StocktakeRepository } from "@tali/application";
import { assertStocktakeTransition, ConcurrentModificationError, STOCKTAKE_IN_PROGRESS } from "@tali/application";
import type { BusinessId, Stocktake, StocktakeId } from "@tali/domain";
import { parseBusinessId, parseLocationId, parseMembershipId, parseStocktakeId, restoreStocktake } from "@tali/domain";
import type { Stocktake as StocktakeRow } from "../generated/prisma/client.js";
import { translatingUniqueViolations } from "../errors/unique-violations.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import type { TransactionClient } from "../unit-of-work/transaction-scope.js";
import { fromDateColumn, toDateColumn } from "./inventory-rows.js";
import { keysetArgs, toPage } from "./pagination.js";

/** One DRAFT per location (ADR-008 section 12): a lost create race is the use case's own CONFLICT. */
export const STOCKTAKE_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  stocktakes_one_draft: STOCKTAKE_IN_PROGRESS,
});

function toStocktake(row: StocktakeRow): Stocktake {
  return restoreStocktake({
    businessId: parseBusinessId(row.businessId),
    id: parseStocktakeId(row.id),
    locationId: parseLocationId(row.locationId),
    status: row.status,
    version: row.version,
    ...(row.note === null ? {} : { note: row.note }),
    createdByMembershipId: parseMembershipId(row.createdByMembershipId),
    createdAt: row.createdAt,
    ...(row.postedByMembershipId === null ? {} : { postedByMembershipId: parseMembershipId(row.postedByMembershipId) }),
    ...(row.postedAt === null ? {} : { postedAt: row.postedAt }),
    ...(row.businessDate === null ? {} : { businessDate: fromDateColumn(row.businessDate) }),
    ...(row.cancelledByMembershipId === null
      ? {}
      : { cancelledByMembershipId: parseMembershipId(row.cancelledByMembershipId) }),
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt }),
  });
}

/** The columns the application role may update (column-level grant). */
function lifecycleColumns(stocktake: Stocktake) {
  return {
    status: stocktake.status,
    version: stocktake.version,
    postedAt: stocktake.postedAt ?? null,
    postedByMembershipId: stocktake.postedByMembershipId ?? null,
    businessDate: stocktake.businessDate === undefined ? null : toDateColumn(stocktake.businessDate),
    cancelledAt: stocktake.cancelledAt ?? null,
    cancelledByMembershipId: stocktake.cancelledByMembershipId ?? null,
  };
}

interface LineCountRow {
  readonly stocktake_id: string;
  readonly counted: number;
  readonly removed: number;
  readonly non_zero_variance: number;
  readonly zero_variance: number;
}

const NO_LINES: StocktakeLineCounts = Object.freeze({ counted: 0, removed: 0, nonZeroVariance: 0, zeroVariance: 0 });

/** Line counts per stocktake in one grouped query; a stocktake without lines is absent from the map. */
export async function lineCountsOf(
  client: TransactionClient,
  businessId: BusinessId,
  stocktakeIds: readonly StocktakeId[],
): Promise<ReadonlyMap<string, StocktakeLineCounts>> {
  const counts = new Map<string, StocktakeLineCounts>();
  if (stocktakeIds.length === 0) return counts;
  const rows = await client.$queryRaw<LineCountRow[]>`
    SELECT stocktake_id::text AS stocktake_id,
           (count(*) FILTER (WHERE status = 'COUNTED'))::int AS counted,
           (count(*) FILTER (WHERE status = 'REMOVED'))::int AS removed,
           (count(*) FILTER (WHERE status = 'COUNTED' AND variance_minor <> 0))::int AS non_zero_variance,
           (count(*) FILTER (WHERE status = 'COUNTED' AND variance_minor = 0))::int AS zero_variance
    FROM stocktake_lines
    WHERE business_id = ${businessId}::uuid AND stocktake_id = ANY(${[...stocktakeIds]}::uuid[])
    GROUP BY stocktake_id`;
  for (const row of rows) {
    counts.set(
      row.stocktake_id,
      Object.freeze({
        counted: row.counted,
        removed: row.removed,
        nonZeroVariance: row.non_zero_variance,
        zeroVariance: row.zero_variance,
      }),
    );
  }
  return counts;
}

export function lineCountsFor(
  counts: ReadonlyMap<string, StocktakeLineCounts>,
  stocktakeId: StocktakeId,
): StocktakeLineCounts {
  return counts.get(stocktakeId) ?? NO_LINES;
}

/**
 * Stocktake headers (tenant-owned; ADR-008 section 12). Every lookup is by
 * (business_id, id): another business's stocktake is not found. The
 * application role may update only the lifecycle columns, and every update
 * is guarded by the version read. Authorization and location checks are the
 * use cases', never inferred here.
 */
export function createStocktakeRepository(): StocktakeRepository {
  return {
    async insert(scope, stocktake) {
      if (stocktake.status !== "DRAFT" || stocktake.version !== 1) {
        throw new Error("a stocktake is inserted DRAFT at version 1");
      }
      await translatingUniqueViolations(STOCKTAKE_CONFLICTS, async () => {
        await transactionClient(scope).stocktake.create({
          data: {
            businessId: stocktake.businessId,
            id: stocktake.id,
            locationId: stocktake.locationId,
            note: stocktake.note ?? null,
            createdByMembershipId: stocktake.createdByMembershipId,
            createdAt: stocktake.createdAt,
            ...lifecycleColumns(stocktake),
          },
        });
      });
    },

    async findById(scope, businessId, id) {
      const row = await transactionClient(scope).stocktake.findUnique({
        where: { businessId_id: { businessId, id } },
      });
      return row === null ? undefined : toStocktake(row);
    },

    async findByIdForUpdate(scope, businessId, id) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM stocktakes WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.stocktake.findUnique({ where: { businessId_id: { businessId, id } } });
      return row === null ? undefined : toStocktake(row);
    },

    async update(scope, previous, next) {
      assertStocktakeTransition(previous, next);
      const { count } = await transactionClient(scope).stocktake.updateMany({
        where: { businessId: previous.businessId, id: previous.id, version: previous.version },
        data: lifecycleColumns(next),
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },

    async list(scope, businessId, locationId, query, request) {
      const client = transactionClient(scope);
      const page = keysetArgs(request);
      const rows = await client.stocktake.findMany({
        where: {
          businessId,
          locationId,
          ...(query.status === undefined ? {} : { status: query.status }),
          ...page.where,
        },
        orderBy: page.orderBy,
        take: page.take,
      });
      const shown = rows.slice(0, request.limit).map(toStocktake);
      const counts = await lineCountsOf(
        client,
        businessId,
        shown.map((stocktake) => stocktake.id),
      );
      const byId = new Map(shown.map((stocktake) => [stocktake.id as string, stocktake]));
      return toPage(
        rows,
        request,
        (row) => row.id,
        (row) => {
          const stocktake = byId.get(row.id) as Stocktake;
          return { stocktake, lineCounts: lineCountsFor(counts, stocktake.id) };
        },
      );
    },
  };
}
