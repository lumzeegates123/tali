import type { BusinessMembership } from "@tali/domain";
import { isMembershipActive } from "@tali/domain";
import type { Permission } from "../../authorization/permissions.js";
import { hasPermission } from "../../authorization/permissions.js";
import type { BusinessContext, UserActor } from "../../context/business-context.js";
import { requireContextPermission } from "../../context/business-context.js";
import { NotFoundError, PermissionDeniedError } from "../../errors/application-error.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import { permissionsForRole } from "../identity/index.js";
import type { MembershipRepository } from "./ports.js";

/** One body for every inaccessible business, matching context resolution (ADR-005 section 13). */
export const BUSINESS_NOT_FOUND = "Business not found";

/** Build 1 business mutations are performed by people acting through their membership. */
export function requireUserActor(context: BusinessContext, permission: Permission): UserActor {
  requireContextPermission(context, permission);
  if (context.actor.type !== "user") throw new PermissionDeniedError();
  return context.actor;
}

/**
 * Re-reads the acting membership inside the mutation's transaction (ADR-005
 * section 10, step 2): the request context may be stale by now. A membership
 * that was suspended, replaced or removed since the context was resolved no
 * longer gives access (404, as in context resolution); one whose role lost the
 * permission is PERMISSION_DENIED. Call it after taking any lock the use case
 * needs, so the answer holds until commit.
 */
export async function requireActingMembership(
  scope: TransactionScope,
  memberships: MembershipRepository,
  context: BusinessContext,
  permission: Permission,
): Promise<BusinessMembership> {
  const actor = requireUserActor(context, permission);
  const membership = await memberships.findByBusinessAndUser(scope, context.businessId, actor.userId);
  if (membership === undefined || membership.id !== actor.membershipId || !isMembershipActive(membership)) {
    throw new NotFoundError(BUSINESS_NOT_FOUND);
  }
  if (!hasPermission(permissionsForRole(membership.role), permission)) throw new PermissionDeniedError();
  return membership;
}
