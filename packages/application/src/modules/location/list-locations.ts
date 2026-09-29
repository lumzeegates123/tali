import type { BusinessLocation } from "@tali/domain";
import type { BusinessContext } from "../../context/business-context.js";
import { requireContextPermission } from "../../context/business-context.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { Page } from "../../queries/pagination.js";
import { parsePageRequest } from "../../queries/pagination.js";
import { identityPermissions } from "../identity/index.js";
import type { LocationRepository } from "./ports.js";

/** Lists the context business's locations (`location:read`). */
export interface ListLocations {
  execute(
    context: BusinessContext,
    page?: { readonly limit?: number; readonly after?: string },
  ): Promise<Page<BusinessLocation>>;
}

export function createListLocations(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly locations: LocationRepository;
}): ListLocations {
  return {
    async execute(context, page) {
      requireContextPermission(context, identityPermissions.permissions["location:read"]);
      const request = parsePageRequest(page);
      return dependencies.unitOfWork.run((scope) =>
        dependencies.locations.listForBusiness(scope, context.businessId, request),
      );
    },
  };
}
