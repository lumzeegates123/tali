import type { InvitationRepository } from "@tali/application";
import { assertInvitationTransition, ConcurrentModificationError } from "@tali/application";
import type { BusinessInvitation } from "@tali/domain";
import { parseBusinessId, parseInvitationId, parseMembershipId, restoreInvitation } from "@tali/domain";
import type { BusinessInvitation as InvitationRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

/** The row without its token digest: the digest never leaves this adapter. */
type InvitationFields = Omit<InvitationRow, "tokenHash">;

const INVITATION_FIELDS = {
  businessId: true,
  id: true,
  role: true,
  status: true,
  expiresAt: true,
  createdByMembershipId: true,
  createdAt: true,
  acceptedByMembershipId: true,
  acceptedAt: true,
  revokedByMembershipId: true,
  revokedAt: true,
} as const;

function toInvitation(row: InvitationFields): BusinessInvitation {
  return restoreInvitation({
    id: parseInvitationId(row.id),
    businessId: parseBusinessId(row.businessId),
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt,
    createdByMembershipId: parseMembershipId(row.createdByMembershipId),
    createdAt: row.createdAt,
    acceptedByMembershipId:
      row.acceptedByMembershipId === null ? undefined : parseMembershipId(row.acceptedByMembershipId),
    acceptedAt: row.acceptedAt ?? undefined,
    revokedByMembershipId:
      row.revokedByMembershipId === null ? undefined : parseMembershipId(row.revokedByMembershipId),
    revokedAt: row.revokedAt ?? undefined,
  });
}

/**
 * Business invitations (tenant-owned; ADR-005 section 14). Only the SHA-256
 * token digest is stored. Row locks are SELECT ... FOR UPDATE through
 * parameterized raw queries, then the row is read with its business.
 */
export function createInvitationRepository(): InvitationRepository {
  return {
    async insert(scope, invitation, tokenDigest) {
      await transactionClient(scope).businessInvitation.create({
        data: {
          businessId: invitation.businessId,
          id: invitation.id,
          tokenHash: new Uint8Array(tokenDigest),
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          createdByMembershipId: invitation.createdByMembershipId,
          createdAt: invitation.createdAt,
        },
      });
    },

    async findByIdForUpdate(scope, businessId, invitationId) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM business_invitations
        WHERE business_id = ${businessId}::uuid AND id = ${invitationId}::uuid FOR UPDATE`;
      if (locked.length !== 1) return undefined;
      const row = await client.businessInvitation.findUnique({
        where: { businessId_id: { businessId, id: invitationId } },
        select: INVITATION_FIELDS,
      });
      return row === null ? undefined : toInvitation(row);
    },

    async findByTokenDigestForUpdate(scope, tokenDigest) {
      const client = transactionClient(scope);
      const locked = await client.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM business_invitations WHERE token_hash = ${new Uint8Array(tokenDigest)} FOR UPDATE`;
      const lockedId = locked[0]?.id;
      if (locked.length !== 1 || lockedId === undefined) return undefined;
      const row = await client.businessInvitation.findUnique({ where: { id: lockedId }, select: INVITATION_FIELDS });
      return row === null ? undefined : toInvitation(row);
    },

    async update(scope, previous, next) {
      assertInvitationTransition(previous, next);
      const { count } = await transactionClient(scope).businessInvitation.updateMany({
        where: { businessId: previous.businessId, id: previous.id, status: previous.status },
        data: {
          status: next.status,
          acceptedByMembershipId: next.acceptedByMembershipId ?? null,
          acceptedAt: next.acceptedAt ?? null,
          revokedByMembershipId: next.revokedByMembershipId ?? null,
          revokedAt: next.revokedAt ?? null,
        },
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },
  };
}
