import { hasPermission } from "../../authorization/permissions.js";
import { DomainError, KernelError, parseSaleId, type Sale, type SaleId } from "@tali/domain";
import type { LocationBoundContext } from "../../context/business-context.js";
import { requireLocationBound } from "../../context/business-context.js";
import { NotFoundError, PermissionDeniedError } from "../../errors/application-error.js";
import { toApplicationError } from "../../errors/domain-errors.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import { parsePageRequest, type Page, type PageRequest } from "../../queries/pagination.js";
import type { MembershipRepository } from "../business/index.js";
import { requireActingMembership } from "../business/index.js";
import { inventoryPermissions, salesPermissions } from "../identity/index.js";
import type { SaleRepository } from "./ports.js";
import { presentSale, type SaleView } from "./view.js";

export interface GetSale {
  execute(context: LocationBoundContext, saleId: string): Promise<SaleView>;
}

export interface ListSales {
  execute(
    context: LocationBoundContext,
    page?: { readonly limit?: number; readonly after?: string },
  ): Promise<Page<SaleView>>;
}

function readPermission(context: LocationBoundContext) {
  const read = salesPermissions.permissions["sales:read"];
  const own = salesPermissions.permissions["sales:read-own"];
  if (hasPermission(context.permissions, read)) return read;
  if (hasPermission(context.permissions, own)) return own;
  throw new PermissionDeniedError();
}

function visible(sale: Sale, context: LocationBoundContext, ownOnly: boolean): boolean {
  if (sale.businessId !== context.businessId || sale.locationId !== context.locationId) return false;
  if (!ownOnly) return true;
  return context.actor.type === "user" && sale.recordedByMembershipId === context.actor.membershipId;
}

export function createGetSale(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly sales: SaleRepository;
}): GetSale {
  return {
    async execute(locationContext, rawSaleId) {
      const context = requireLocationBound(locationContext);
      const permission = readPermission(context);
      let saleId: SaleId;
      try {
        saleId = parseSaleId(rawSaleId);
      } catch (error) {
        throw error instanceof DomainError || error instanceof KernelError
          ? toApplicationError(error, "saleId")
          : error;
      }
      return dependencies.unitOfWork.run(async (scope) => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const sale = await dependencies.sales.findById(scope, context.businessId, saleId);
        const ownOnly =
          permission === salesPermissions.permissions["sales:read-own"] &&
          !hasPermission(context.permissions, salesPermissions.permissions["sales:read"]);
        if (sale === undefined || !visible(sale, context, ownOnly)) throw new NotFoundError("Sale not found");
        const includeCost = hasPermission(context.permissions, inventoryPermissions.permissions["inventory:cost-read"]);
        return presentSale(sale, includeCost);
      });
    },
  };
}

export function createListSales(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly sales: SaleRepository;
}): ListSales {
  return {
    async execute(locationContext, page) {
      const context = requireLocationBound(locationContext);
      const permission = readPermission(context);
      const request: PageRequest = parsePageRequest(page);
      const ownOnly =
        permission === salesPermissions.permissions["sales:read-own"] &&
        !hasPermission(context.permissions, salesPermissions.permissions["sales:read"]);
      return dependencies.unitOfWork.run(async (scope) => {
        const membership = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const listed = await dependencies.sales.list(scope, context.businessId, {
          locationId: context.locationId,
          ...(ownOnly ? { recordedByMembershipId: membership.id } : {}),
          page: request,
        });
        const includeCost = hasPermission(context.permissions, inventoryPermissions.permissions["inventory:cost-read"]);
        return {
          items: listed.items.map((sale) => presentSale(sale, includeCost)),
          nextCursor: listed.nextCursor,
        };
      });
    },
  };
}
