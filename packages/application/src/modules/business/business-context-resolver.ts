import type { BusinessId } from "@tali/domain";
import { isBusinessActive, isMembershipActive, parseBusinessId } from "@tali/domain";
import type { AuthenticatedUserContext } from "../../context/authenticated-user-context.js";
import type { BusinessContext } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import type { VerifiedIdentity } from "../../ports/identity-provider.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { RequestMetadata, UserContextResolver } from "../identity/index.js";
import { permissionsForRole } from "../identity/index.js";
import type { BusinessRepository, MembershipRepository } from "./ports.js";

/** One body for every inaccessible business, so existence is never revealed (ADR-005 section 13). */
const BUSINESS_NOT_FOUND = "Business not found";

/**
 * Framework-free BusinessContext resolution (ADR-005 section 12, steps 2 to 6
 * and 9; plan 003 section 13.5). Role, business, membership and location
 * claims from the caller are never trusted: the business ID is a claim
 * checked against Tali's own records. The transport guard, correlation and
 * device headers and default-location resolution belong to Slice 3.
 */
export interface BusinessContextResolver {
  /** Verified identity to BusinessContext. */
  resolve(
    request: RequestMetadata & { readonly identity: VerifiedIdentity; readonly businessId: string },
  ): Promise<BusinessContext>;
  /** For a user already resolved in this request. */
  resolveForUser(user: AuthenticatedUserContext, businessId: string): Promise<BusinessContext>;
}

export function createBusinessContextResolver(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly userContexts: UserContextResolver;
  readonly businesses: BusinessRepository;
  readonly memberships: MembershipRepository;
}): BusinessContextResolver {
  const resolveForUser = async (user: AuthenticatedUserContext, rawBusinessId: string): Promise<BusinessContext> => {
    let businessId: BusinessId;
    try {
      businessId = parseBusinessId(rawBusinessId);
    } catch {
      throw new NotFoundError(BUSINESS_NOT_FOUND);
    }
    const found = await dependencies.unitOfWork.run(async (scope) => {
      const membership = await dependencies.memberships.findByBusinessAndUser(scope, businessId, user.userId);
      if (membership === undefined || !isMembershipActive(membership)) return undefined;
      const business = await dependencies.businesses.findById(scope, businessId);
      if (business === undefined || !isBusinessActive(business)) return undefined;
      return { membership, business };
    });
    if (found === undefined) throw new NotFoundError(BUSINESS_NOT_FOUND);
    const { membership, business } = found;
    return Object.freeze({
      businessId: business.id,
      actor: Object.freeze({ type: "user", userId: user.userId, membershipId: membership.id }),
      permissions: permissionsForRole(membership.role),
      sourceChannel: user.sourceChannel,
      correlationId: user.correlationId,
      currency: business.currencyCode,
      timeZone: business.timeZone,
    });
  };

  return {
    async resolve(request) {
      const user = await dependencies.userContexts.resolve(request.identity, request);
      return resolveForUser(user, request.businessId);
    },
    resolveForUser,
  };
}
