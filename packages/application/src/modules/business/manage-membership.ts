import type {
  BusinessMembership,
  MembershipChangeReason,
  MembershipId,
  MembershipRole,
  MembershipTransition,
  OwnerInvariantState,
} from "@tali/domain";
import {
  changeMembershipRole,
  isBusinessActive,
  isMembershipRole,
  parseMembershipChangeReason,
  parseMembershipId,
  reactivateMembership,
  suspendMembership,
} from "@tali/domain";
import type { AuditActionDefinition } from "../../audit/audit-action.js";
import type { AuditFields, AuditPayloadOf } from "../../audit/audit-payload.js";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { BusinessContext } from "../../context/business-context.js";
import { NotFoundError, ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { Clock } from "../../ports/clock.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import { identityPermissions } from "../identity/index.js";
import { BUSINESS_NOT_FOUND, requireActingMembership, requireUserActor } from "./acting-membership.js";
import { membershipReactivated, membershipRoleChanged, membershipSuspended } from "./audit-actions.js";
import type { BusinessRepository, MembershipRepository } from "./ports.js";

const MEMBER_NOT_FOUND = "Member not found";

export interface MembershipChangeResult {
  readonly membership: BusinessMembership;
  /** False for the successful no-op of requesting the current state (no audit record). */
  readonly changed: boolean;
}

interface MembershipChangeInput {
  readonly membershipId: string;
  readonly reason: string;
}

export interface ChangeMemberRole {
  execute(
    context: BusinessContext,
    input: MembershipChangeInput & { readonly role: string },
  ): Promise<MembershipChangeResult>;
}

export interface SuspendMember {
  execute(context: BusinessContext, input: MembershipChangeInput): Promise<MembershipChangeResult>;
}

export interface ReactivateMember {
  execute(context: BusinessContext, input: MembershipChangeInput): Promise<MembershipChangeResult>;
}

interface Dependencies {
  readonly unitOfWork: UnitOfWork;
  readonly businesses: BusinessRepository;
  readonly memberships: MembershipRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}

interface Decision {
  readonly target: BusinessMembership;
  readonly actor: BusinessMembership;
  readonly reason: MembershipChangeReason;
  readonly owners: OwnerInvariantState;
  readonly now: Date;
}

function parseTarget(value: string): MembershipId {
  try {
    return parseMembershipId(value);
  } catch {
    throw new NotFoundError(MEMBER_NOT_FOUND);
  }
}

/**
 * The owner-invariant protocol of ADR-005 section 10, shared by every
 * membership change: in one transaction take the business row lock, re-read
 * the acting and target memberships under it, count the active owners, apply
 * the pure domain decision, then write the change and its audit record. A
 * no-op writes nothing.
 */
async function changeMembership<Fields extends AuditFields>(
  dependencies: Dependencies,
  context: BusinessContext,
  input: MembershipChangeInput,
  change: {
    readonly decide: (decision: Decision) => MembershipTransition;
    readonly action: AuditActionDefinition<"business", Fields>;
    readonly payload: (changed: BusinessMembership, previous: BusinessMembership) => AuditPayloadOf<Fields>;
  },
): Promise<MembershipChangeResult> {
  const permission = identityPermissions.permissions["member:manage"];
  requireUserActor(context, permission);
  const reason = withDomainRules(() => parseMembershipChangeReason(input.reason), "reason");
  const targetId = parseTarget(input.membershipId);

  return dependencies.unitOfWork.run(async (scope) => {
    const business = await dependencies.businesses.findByIdForUpdate(scope, context.businessId);
    if (business === undefined || !isBusinessActive(business)) throw new NotFoundError(BUSINESS_NOT_FOUND);
    const actor = await requireActingMembership(scope, dependencies.memberships, context, permission);
    const target = await dependencies.memberships.findById(scope, context.businessId, targetId);
    if (target === undefined) throw new NotFoundError(MEMBER_NOT_FOUND);
    const owners = { activeOwnerCount: await dependencies.memberships.countActiveOwners(scope, context.businessId) };

    const transition = withDomainRules(() =>
      change.decide({ target, actor, reason, owners, now: dependencies.clock.now() }),
    );
    if (transition.outcome === "unchanged") return { membership: transition.membership, changed: false };

    await dependencies.memberships.update(scope, transition.previous, transition.membership);
    await dependencies.audit.recordBusinessEvent(scope, change.action, {
      ...businessAuditEnvelope(context),
      entityId: transition.membership.id,
      reason,
      payload: change.payload(transition.membership, transition.previous),
    });
    return { membership: transition.membership, changed: true };
  });
}

/** `member:manage`. Granting or removing OWNER needs an ACTIVE OWNER actor; the last active owner stays. */
export function createChangeMemberRole(dependencies: Dependencies): ChangeMemberRole {
  return {
    async execute(context, input) {
      if (!isMembershipRole(input.role)) {
        throw new ValidationError("role is not a membership role", [{ path: ["role"], message: "invalid role" }]);
      }
      const role: MembershipRole = input.role;
      return changeMembership(dependencies, context, input, {
        decide: (decision) => changeMembershipRole({ ...decision, role }),
        action: membershipRoleChanged,
        payload: (changed, previous) => ({ userId: changed.userId, previousRole: previous.role, role: changed.role }),
      });
    },
  };
}

/** `member:manage`. ACTIVE to SUSPENDED; the last active owner cannot be suspended. */
export function createSuspendMember(dependencies: Dependencies): SuspendMember {
  return {
    async execute(context, input) {
      return changeMembership(dependencies, context, input, {
        decide: (decision) => suspendMembership(decision),
        action: membershipSuspended,
        payload: (changed) => ({ userId: changed.userId, role: changed.role, status: changed.status }),
      });
    },
  };
}

/**
 * `member:manage`. SUSPENDED to ACTIVE: the only way back in (an invitation
 * never reactivates). A suspended member can never reach this use case for
 * themselves: context resolution already refuses them.
 */
export function createReactivateMember(dependencies: Dependencies): ReactivateMember {
  return {
    async execute(context, input) {
      return changeMembership(dependencies, context, input, {
        decide: ({ target, actor, reason, now }) => reactivateMembership({ target, actor, reason, now }),
        action: membershipReactivated,
        payload: (changed) => ({ userId: changed.userId, role: changed.role, status: changed.status }),
      });
    },
  };
}
