import type { StocktakeId, StocktakeStatus } from "@tali/domain";
import { parseStocktakeId, parseStocktakeStatus } from "@tali/domain";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireContextPermission, requireLocationBound } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { TransactionScope, UnitOfWork } from "../../ports/unit-of-work.js";
import type { Page } from "../../queries/pagination.js";
import { parsePageRequest } from "../../queries/pagination.js";
import { inventoryPermissions } from "../identity/index.js";
import { idOrNotFound, STOCKTAKE_NOT_FOUND } from "./inventory-common.js";
import type { StocktakeLineRepository, StocktakeRepository } from "./ports.js";
import type { StocktakeLineView, StocktakeView } from "./stocktake-views.js";
import { stocktakeLineView, stocktakeView, stocktakeVisibilityFor } from "./stocktake-views.js";

export interface ListStocktakesInput {
  readonly status?: string;
  readonly limit?: number;
  readonly after?: string;
}

export interface ListStocktakeLinesInput {
  readonly stocktakeId: string;
  readonly limit?: number;
  readonly after?: string;
}

/**
 * `inventory:count` (OWNER, MANAGER, STOCK_KEEPER). Stocktakes at the
 * context's location, ordered by ID; FULL for `inventory:count-post`, BLIND
 * otherwise.
 */
export interface ListStocktakes {
  execute(context: LocationBoundContext, input?: ListStocktakesInput): Promise<Page<StocktakeView>>;
}

/** `inventory:count`. One stocktake at the context's location; any other is NOT_FOUND. */
export interface GetStocktake {
  execute(context: LocationBoundContext, input: { readonly stocktakeId: string }): Promise<StocktakeView>;
}

/** `inventory:count`. A stocktake's COUNTED and REMOVED lines, ordered by variant ID. */
export interface ListStocktakeLines {
  execute(context: LocationBoundContext, input: ListStocktakeLinesInput): Promise<Page<StocktakeLineView>>;
}

export interface StocktakeQueryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly stocktakes: StocktakeRepository;
  readonly stocktakeLines: StocktakeLineRepository;
}

const countPermission = inventoryPermissions.permissions["inventory:count"];

function queryContext(context: LocationBoundContext): LocationBoundContext {
  requireContextPermission(context, countPermission);
  return requireLocationBound(context);
}

function pageRequest(input: { readonly limit?: number; readonly after?: string } | undefined) {
  return parsePageRequest({
    ...(input?.limit === undefined ? {} : { limit: input.limit }),
    ...(input?.after === undefined ? {} : { after: input.after }),
  });
}

async function stocktakeAt(
  dependencies: StocktakeQueryDependencies,
  scope: TransactionScope,
  context: LocationBoundContext,
  id: StocktakeId,
) {
  const stocktake = await dependencies.stocktakes.findById(scope, context.businessId, id);
  if (stocktake?.locationId !== context.locationId) throw new NotFoundError(STOCKTAKE_NOT_FOUND);
  return stocktake;
}

export function createListStocktakes(dependencies: StocktakeQueryDependencies): ListStocktakes {
  return {
    async execute(locationContext, input) {
      const context = queryContext(locationContext);
      const visibility = stocktakeVisibilityFor(context.permissions);
      const status: StocktakeStatus | undefined =
        input?.status === undefined
          ? undefined
          : withDomainRules(() => parseStocktakeStatus(input.status as string), "status");
      const request = pageRequest(input);
      return dependencies.unitOfWork.run(async (scope) => {
        const page = await dependencies.stocktakes.list(
          scope,
          context.businessId,
          context.locationId,
          status === undefined ? {} : { status },
          request,
        );
        return {
          items: page.items.map((summary) => stocktakeView(summary.stocktake, summary.lineCounts, visibility)),
          nextCursor: page.nextCursor,
        };
      });
    },
  };
}

export function createGetStocktake(dependencies: StocktakeQueryDependencies): GetStocktake {
  return {
    async execute(locationContext, input) {
      const context = queryContext(locationContext);
      const visibility = stocktakeVisibilityFor(context.permissions);
      const id = idOrNotFound(() => parseStocktakeId(input.stocktakeId), STOCKTAKE_NOT_FOUND);
      return dependencies.unitOfWork.run(async (scope) => {
        const stocktake = await stocktakeAt(dependencies, scope, context, id);
        const counts = await dependencies.stocktakeLines.countByStatus(scope, context.businessId, stocktake.id);
        return stocktakeView(stocktake, counts, visibility);
      });
    },
  };
}

export function createListStocktakeLines(dependencies: StocktakeQueryDependencies): ListStocktakeLines {
  return {
    async execute(locationContext, input) {
      const context = queryContext(locationContext);
      const visibility = stocktakeVisibilityFor(context.permissions);
      const id = idOrNotFound(() => parseStocktakeId(input.stocktakeId), STOCKTAKE_NOT_FOUND);
      const request = pageRequest(input);
      return dependencies.unitOfWork.run(async (scope) => {
        const stocktake = await stocktakeAt(dependencies, scope, context, id);
        const page = await dependencies.stocktakeLines.listPage(scope, context.businessId, stocktake.id, request);
        return {
          items: page.items.map((line) => stocktakeLineView(stocktake, line, visibility)),
          nextCursor: page.nextCursor,
        };
      });
    },
  };
}
