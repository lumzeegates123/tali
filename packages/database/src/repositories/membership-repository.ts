import type { MembershipRepository } from "@tali/application";
import { assertMembershipTransition, ConcurrentModificationError } from "@tali/application";
import type { BusinessMembership } from "@tali/domain";
import { parseBusinessId, parseMembershipId, parseUserId, restoreMembership } from "@tali/domain";
import type { BusinessMembership as MembershipRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";
import { toBusiness } from "./business-repository.js";
import { keysetArgs, toPage } from "./pagination.js";
import { toUser } from "./user-repository.js";

function toMembership(row: MembershipRow): BusinessMembership {
  return restoreMembership({
    id: parseMembershipId(row.id),
    businessId: parseBusinessId(row.businessId),
    userId: parseUserId(row.userId),
    role: row.role,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * Business memberships (tenant-owned; ADR-005 sections 9 and 10). Every
 * method except listAccessibleBusinesses takes the business; that one is the
 * user's own cross-business listing and returns only ACTIVE memberships of
 * ACTIVE businesses.
 */
export function createMembershipRepository(): MembershipRepository {
  return {
    async findByBusinessAndUser(scope, businessId, userId) {
      const row = await transactionClient(scope).businessMembership.findUnique({
        where: { businessId_userId: { businessId, userId } },
      });
      return row === null ? undefined : toMembership(row);
    },

    async insert(scope, membership) {
      await transactionClient(scope).businessMembership.create({
        data: {
          businessId: membership.businessId,
          id: membership.id,
          userId: membership.userId,
          role: membership.role,
          status: membership.status,
          version: membership.version,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,
        },
      });
    },

    async lockBusinessForMembershipChange(scope, businessId) {
      const rows = await transactionClient(scope).$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE`;
      return rows.length === 1;
    },

    async countActiveOwners(scope, businessId) {
      return transactionClient(scope).businessMembership.count({
        where: { businessId, role: "OWNER", status: "ACTIVE" },
      });
    },

    async update(scope, previous, next) {
      assertMembershipTransition(previous, next);
      const { count } = await transactionClient(scope).businessMembership.updateMany({
        where: { businessId: previous.businessId, id: previous.id, version: previous.version },
        data: { role: next.role, status: next.status, version: next.version, updatedAt: next.updatedAt },
      });
      if (count !== 1) throw new ConcurrentModificationError();
    },

    async listMembers(scope, businessId, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).businessMembership.findMany({
        where: { businessId, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
        include: { user: true },
      });
      return toPage(
        rows,
        request,
        (row) => row.id,
        (row) => ({ membership: toMembership(row), displayName: toUser(row.user).displayName }),
      );
    },

    async listAccessibleBusinesses(scope, userId, request) {
      const page = keysetArgs(request);
      const rows = await transactionClient(scope).businessMembership.findMany({
        where: { userId, status: "ACTIVE", business: { status: "ACTIVE" }, ...page.where },
        orderBy: page.orderBy,
        take: page.take,
        include: { business: true },
      });
      return toPage(
        rows,
        request,
        (row) => row.id,
        (row) => ({ membership: toMembership(row), business: toBusiness(row.business) }),
      );
    },
  };
}
