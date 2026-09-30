import type { Business, BusinessInvitation, BusinessMembership, InvitationId } from "@tali/domain";
import {
  acceptInvitation,
  createInvitation,
  createInvitedMembership,
  isBusinessActive,
  isInvitationOpen,
  isMembershipActive,
  parseBusinessId,
  parseInvitableRole,
  parseInvitationId,
  parseMembershipId,
  restoreInvitation,
  revokeInvitation,
} from "@tali/domain";
import { hasPermission } from "../../authorization/permissions.js";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { businessAuditEnvelope } from "../../audit/business-audit-envelope.js";
import type { AuthenticatedUserContext } from "../../context/authenticated-user-context.js";
import type { BusinessContext, UserActor } from "../../context/business-context.js";
import { ConflictError, NotFoundError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { idempotencyActorOf } from "../../idempotency/business-idempotency-store.js";
import { canonicalCommandEncoding } from "../../idempotency/canonical-command.js";
import type { FingerprintHasher } from "../../idempotency/fingerprint-hasher.js";
import { requireIdempotencyKey } from "../../idempotency/idempotency-key.js";
import type { IdempotentResultCodec, KeyedIdempotency } from "../../idempotency/keyed-idempotency.js";
import { instantAt, objectAt, optionalTextAt, textAt } from "../../idempotency/result-json.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { OneTimeSecret, OneTimeSecretGenerator, SecretHasher } from "../../ports/one-time-secret.js";
import { parseOneTimeSecret } from "../../ports/one-time-secret.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { UserRepository } from "../identity/index.js";
import { identityPermissions, permissionsForRole, requireActiveUser } from "../identity/index.js";
import { requireActingMembership, requireUserActor } from "./acting-membership.js";
import { invitationAccepted, invitationCreated, invitationRevoked, membershipCreated } from "./audit-actions.js";
import type { BusinessRepository, InvitationRepository, MembershipRepository } from "./ports.js";

export const CREATE_INVITATION_OPERATION = "invitation.create.v1";
export const CREATE_INVITATION_COMMAND_SCHEMA_VERSION = 1;

const INVITATION_NOT_FOUND = "Invitation not found";

/**
 * The original response carries the plaintext token once; a replay never
 * does (ADR-004 section 12). The stored idempotency result is the invitation
 * only.
 */
export type CreateInvitationOutcome =
  | { readonly invitation: BusinessInvitation; readonly replayed: false; readonly token: OneTimeSecret }
  | { readonly invitation: BusinessInvitation; readonly replayed: true };

/** `member:invite` (OWNER): a bearer invitation for one of the four invitable roles, expiring after 72 hours. */
export interface CreateInvitation {
  execute(
    context: BusinessContext,
    input: { readonly role: string; readonly idempotencyKey: string | undefined },
  ): Promise<CreateInvitationOutcome>;
}

export interface InvitationChangeResult {
  readonly invitation: BusinessInvitation;
  /** False for the successful no-op of revoking a REVOKED invitation (no audit record). */
  readonly changed: boolean;
}

/** `member:invite`: PENDING to REVOKED; REVOKED is a no-op; ACCEPTED is CONFLICT. */
export interface RevokeInvitation {
  execute(context: BusinessContext, input: { readonly invitationId: string }): Promise<InvitationChangeResult>;
}

export interface AcceptInvitationResult {
  readonly business: Business;
  readonly membership: BusinessMembership;
  /** True when this user had already accepted this invitation (the existing membership is returned). */
  readonly replayed: boolean;
}

/**
 * Any authenticated, registered, ACTIVE user holding the token (ADR-005
 * section 14). Every failure that could reveal something about the token is
 * one uniform NOT_FOUND.
 */
export interface AcceptInvitation {
  execute(context: AuthenticatedUserContext, input: { readonly token: string }): Promise<AcceptInvitationResult>;
}

/** Stores the invitation metadata only; the token is never part of the stored result. */
export const invitationResultCodec: IdempotentResultCodec<BusinessInvitation> = {
  encode(invitation) {
    return {
      invitation: {
        id: invitation.id,
        businessId: invitation.businessId,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt.toISOString(),
        createdByMembershipId: invitation.createdByMembershipId,
        createdAt: invitation.createdAt.toISOString(),
      },
    };
  },
  decode(stored) {
    const i = objectAt(objectAt(stored, "result")["invitation"], "invitation");
    if (optionalTextAt(i, "acceptedAt") !== undefined || optionalTextAt(i, "revokedAt") !== undefined) {
      throw new Error("stored invitation result has unexpected state fields");
    }
    return restoreInvitation({
      id: parseInvitationId(textAt(i, "id")),
      businessId: parseBusinessId(textAt(i, "businessId")),
      role: textAt(i, "role"),
      status: textAt(i, "status"),
      expiresAt: instantAt(i, "expiresAt"),
      createdByMembershipId: parseMembershipId(textAt(i, "createdByMembershipId")),
      createdAt: instantAt(i, "createdAt"),
    });
  },
};

export function createCreateInvitation(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly invitations: InvitationRepository;
  readonly idempotency: KeyedIdempotency;
  readonly hasher: FingerprintHasher;
  readonly secrets: OneTimeSecretGenerator;
  readonly secretHasher: SecretHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): CreateInvitation {
  const permission = identityPermissions.permissions["member:invite"];
  return {
    async execute(context, input) {
      const actor = requireUserActor(context, permission);
      const key = requireIdempotencyKey(input.idempotencyKey);
      const role = withDomainRules(() => parseInvitableRole(input.role), "role");
      const command = canonicalCommandEncoding({
        operation: CREATE_INVITATION_OPERATION,
        commandSchemaVersion: CREATE_INVITATION_COMMAND_SCHEMA_VERSION,
        command: { role },
      });
      const fingerprint = await dependencies.hasher.fingerprint(command);

      return dependencies.unitOfWork.run(async (scope): Promise<CreateInvitationOutcome> => {
        await requireActingMembership(scope, dependencies.memberships, context, permission);
        let token: OneTimeSecret | undefined;
        const outcome = await dependencies.idempotency.runBusinessScoped(scope, {
          businessId: context.businessId,
          actor: idempotencyActorOf(actor),
          key,
          command,
          fingerprint,
          resourceType: "invitation",
          codec: invitationResultCodec,
          plan: async () => {
            const invitation = createInvitation({
              id: dependencies.ids.newId("Invitation"),
              businessId: context.businessId,
              role,
              createdByMembershipId: actor.membershipId,
              now: dependencies.clock.now(),
            });
            const secret = dependencies.secrets.generate("invitation");
            const tokenDigest = dependencies.secretHasher.digest(secret);
            return {
              result: invitation,
              resourceId: invitation.id,
              apply: async () => {
                await dependencies.invitations.insert(scope, invitation, tokenDigest);
                await dependencies.audit.recordBusinessEvent(scope, invitationCreated, {
                  ...businessAuditEnvelope(context, key),
                  entityId: invitation.id,
                  payload: {
                    role: invitation.role,
                    status: invitation.status,
                    expiresAt: invitation.expiresAt.toISOString(),
                  },
                });
                token = secret;
              },
            };
          },
        });
        if (outcome.replayed) return { invitation: outcome.result, replayed: true };
        if (token === undefined) throw new Error("a new invitation was created without its token");
        return { invitation: outcome.result, replayed: false, token };
      });
    },
  };
}

function parseInvitation(value: string): InvitationId {
  try {
    return parseInvitationId(value);
  } catch {
    throw new NotFoundError(INVITATION_NOT_FOUND);
  }
}

export function createRevokeInvitation(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly memberships: MembershipRepository;
  readonly invitations: InvitationRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
}): RevokeInvitation {
  const permission = identityPermissions.permissions["member:invite"];
  return {
    async execute(context, input) {
      requireUserActor(context, permission);
      const invitationId = parseInvitation(input.invitationId);
      return dependencies.unitOfWork.run(async (scope) => {
        const actor = await requireActingMembership(scope, dependencies.memberships, context, permission);
        const invitation = await dependencies.invitations.findByIdForUpdate(scope, context.businessId, invitationId);
        if (invitation === undefined) throw new NotFoundError(INVITATION_NOT_FOUND);
        const transition = withDomainRules(() =>
          revokeInvitation({ invitation, revokedByMembershipId: actor.id, now: dependencies.clock.now() }),
        );
        if (transition.outcome === "unchanged") return { invitation, changed: false };
        await dependencies.invitations.update(scope, transition.previous, transition.invitation);
        await dependencies.audit.recordBusinessEvent(scope, invitationRevoked, {
          ...businessAuditEnvelope(context),
          entityId: invitation.id,
          payload: { role: invitation.role, status: transition.invitation.status },
        });
        return { invitation: transition.invitation, changed: true };
      });
    },
  };
}

export function createAcceptInvitation(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly users: UserRepository;
  readonly businesses: BusinessRepository;
  readonly memberships: MembershipRepository;
  readonly invitations: InvitationRepository;
  readonly secretHasher: SecretHasher;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): AcceptInvitation {
  const invite = identityPermissions.permissions["member:invite"];
  return {
    async execute(context, input) {
      const token = parseOneTimeSecret("invitation", input.token);
      if (token === undefined) throw new NotFoundError(INVITATION_NOT_FOUND);
      const tokenDigest = dependencies.secretHasher.digest(token);

      return dependencies.unitOfWork.run(async (scope): Promise<AcceptInvitationResult> => {
        requireActiveUser(await dependencies.users.findById(scope, context.userId));
        const invitation = await dependencies.invitations.findByTokenDigestForUpdate(scope, tokenDigest);
        if (invitation === undefined) throw new NotFoundError(INVITATION_NOT_FOUND);

        if (invitation.status === "ACCEPTED") {
          const accepted =
            invitation.acceptedByMembershipId === undefined
              ? undefined
              : await dependencies.memberships.findById(
                  scope,
                  invitation.businessId,
                  invitation.acceptedByMembershipId,
                );
          const business = await dependencies.businesses.findById(scope, invitation.businessId);
          if (accepted === undefined || accepted.userId !== context.userId || business === undefined) {
            throw new NotFoundError(INVITATION_NOT_FOUND);
          }
          return { business, membership: accepted, replayed: true };
        }

        const now = dependencies.clock.now();
        if (!isInvitationOpen(invitation, now)) throw new NotFoundError(INVITATION_NOT_FOUND);

        // Serializes with membership changes, so the inviter re-check holds until commit.
        const business = await dependencies.businesses.findByIdForUpdate(scope, invitation.businessId);
        if (business === undefined || !isBusinessActive(business)) throw new NotFoundError(INVITATION_NOT_FOUND);
        const inviter = await dependencies.memberships.findById(
          scope,
          invitation.businessId,
          invitation.createdByMembershipId,
        );
        if (
          inviter === undefined ||
          !isMembershipActive(inviter) ||
          !hasPermission(permissionsForRole(inviter.role), invite)
        ) {
          throw new NotFoundError(INVITATION_NOT_FOUND);
        }

        const existing = await dependencies.memberships.findByBusinessAndUser(
          scope,
          invitation.businessId,
          context.userId,
        );
        if (existing !== undefined) {
          throw new ConflictError(
            isMembershipActive(existing)
              ? "You are already a member of this business"
              : "Your membership of this business is suspended; only an owner can reactivate it",
          );
        }

        const membership = createInvitedMembership({
          id: dependencies.ids.newId("Membership"),
          businessId: invitation.businessId,
          userId: context.userId,
          role: invitation.role,
          now,
        });
        const accepted = withDomainRules(() =>
          acceptInvitation({ invitation, acceptedByMembershipId: membership.id, now }),
        );
        await dependencies.memberships.insert(scope, membership);
        await dependencies.invitations.update(scope, accepted.previous, accepted.invitation);

        const actor: UserActor = { type: "user", userId: context.userId, membershipId: membership.id };
        const envelope = {
          businessId: invitation.businessId,
          actor,
          sourceChannel: context.sourceChannel,
          correlationId: context.correlationId,
        } as const;
        await dependencies.audit.recordBusinessEvent(scope, membershipCreated, {
          ...envelope,
          entityId: membership.id,
          payload: { userId: membership.userId, role: membership.role, status: membership.status },
        });
        await dependencies.audit.recordBusinessEvent(scope, invitationAccepted, {
          ...envelope,
          entityId: invitation.id,
          payload: { role: invitation.role, status: accepted.invitation.status, membershipId: membership.id },
        });
        return { business, membership, replayed: false };
      });
    },
  };
}
