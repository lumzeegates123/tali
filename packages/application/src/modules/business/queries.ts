import type { Business } from "@tali/domain";
import type { AuthenticatedUserContext } from "../../context/authenticated-user-context.js";
import type { BusinessContext } from "../../context/business-context.js";
import { requireContextPermission } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { Page } from "../../queries/pagination.js";
import { parsePageRequest } from "../../queries/pagination.js";
import type { UserRepository } from "../identity/index.js";
import { identityPermissions, requireActiveUser } from "../identity/index.js";
import type { AccessibleBusiness, BusinessRepository, MemberListing, MembershipRepository } from "./ports.js";

type PageInput = { readonly limit?: number; readonly after?: string };

/** The businesses the caller can currently access: ACTIVE memberships of ACTIVE businesses only. */
export interface ListMyBusinesses {
  execute(context: AuthenticatedUserContext, page?: PageInput): Promise<Page<AccessibleBusiness>>;
}

export function createListMyBusinesses(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly users: UserRepository;
  readonly memberships: MembershipRepository;
}): ListMyBusinesses {
  return {
    async execute(context, page) {
      const request = parsePageRequest(page);
      return dependencies.unitOfWork.run(async (scope) => {
        requireActiveUser(await dependencies.users.findById(scope, context.userId));
        return dependencies.memberships.listAccessibleBusinesses(scope, context.userId, request);
      });
    },
  };
}

/** The context business (`business:read`). */
export interface GetBusiness {
  execute(context: BusinessContext): Promise<Business>;
}

export function createGetBusiness(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly businesses: BusinessRepository;
}): GetBusiness {
  return {
    async execute(context) {
      requireContextPermission(context, identityPermissions.permissions["business:read"]);
      const business = await dependencies.unitOfWork.run((scope) =>
        dependencies.businesses.findById(scope, context.businessId),
      );
      if (business === undefined) throw new NotFoundError("Business not found");
      return business;
    },
  };
}

/** The context business's members, ACTIVE and SUSPENDED (`member:read`). */
export interface ListMembers {
  execute(context: BusinessContext, page?: PageInput): Promise<Page<MemberListing>>;
}

export function createListMembers(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
}): ListMembers {
  return {
    async execute(context, page) {
      requireContextPermission(context, identityPermissions.permissions["member:read"]);
      const request = parsePageRequest(page);
      return dependencies.unitOfWork.run((scope) =>
        dependencies.memberships.listMembers(scope, context.businessId, request),
      );
    },
  };
}
