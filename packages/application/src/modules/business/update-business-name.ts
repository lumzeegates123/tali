import type { Business } from "@tali/domain";
import { isBusinessActive, parseBusinessName, renameBusiness } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import { NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { Clock } from "../../ports/clock.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import { identityPermissions } from "../identity/index.js";
import { BUSINESS_NOT_FOUND, requireActingMembership, requireUserActor } from "./acting-membership.js";
import { businessRenamed } from "./audit-actions.js";
import type { BusinessRepository, MembershipRepository } from "./ports.js";

export interface UpdateBusinessNameResult {
  readonly business: Business;
  /** False for the successful no-op of setting the current name (no audit record). */
  readonly changed: boolean;
}

/**
 * Sets the context business's name (`business:update`; plan 003 section 5).
 * Naturally idempotent: setting the current name is a no-op without audit
 * (ADR-004 section 7). Takes the business row lock and re-reads the acting
 * membership under it.
 */
export interface UpdateBusinessName {
  execute(context: BusinessContext, input: { readonly name: string }): Promise<UpdateBusinessNameResult>;
}

export function createUpdateBusinessName(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly businesses: BusinessRepository;
  readonly memberships: MembershipRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): UpdateBusinessName {
  const permission = identityPermissions.permissions["business:update"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const name = withDomainRules(() => parseBusinessName(input.name), "name");
      return dependencies.unitOfWork.run(async (scope) => {
        const business = await dependencies.businesses.findByIdForUpdate(scope, context.businessId);
        if (business === undefined || !isBusinessActive(business)) throw new NotFoundError(BUSINESS_NOT_FOUND);
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        const renamed = renameBusiness(business, name, dependencies.clock.now());
        if (!renamed.changed) return { business, changed: false };
        await dependencies.businesses.update(scope, renamed.business);
        await dependencies.audit.recordBusinessEvent(scope, businessRenamed, {
          ...businessAuditEnvelope(context),
          entityId: business.id,
          payload: { changedField: "name" },
        });
        return { business: renamed.business, changed: true };
      });
    },
  };
}
