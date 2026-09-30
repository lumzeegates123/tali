import type { TransactionScope, UserRegistration, UserRepository } from "@tali/application";
import type { ExternalIdentity, User } from "@tali/domain";
import { externalIdentity, parseExternalIdentityId, parseUserId, restoreUser } from "@tali/domain";
import type { ExternalIdentity as ExternalIdentityRow, User as UserRow } from "../generated/prisma/client.js";
import { transactionClient } from "../unit-of-work/transaction-scope.js";

export function toUser(row: UserRow): User {
  return restoreUser({
    id: parseUserId(row.id),
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toExternalIdentity(row: ExternalIdentityRow): ExternalIdentity {
  return externalIdentity({
    id: parseExternalIdentityId(row.id),
    userId: parseUserId(row.userId),
    provider: row.provider,
    providerSubject: row.providerSubject,
    createdAt: row.createdAt,
  });
}

/**
 * Users and external identities (global tables; ADR-005 sections 3 and 4).
 * Registration inserts both rows under a savepoint: when a concurrent
 * registration has already linked the identity key, the user row is rolled
 * back to the savepoint (the application role cannot DELETE) and the caller's
 * transaction stays usable.
 */
export function createUserRepository(): UserRepository {
  return {
    async findByExternalIdentity(scope, key) {
      const row = await transactionClient(scope).externalIdentity.findUnique({
        where: { provider_providerSubject: { provider: key.provider, providerSubject: key.providerSubject } },
        include: { user: true },
      });
      if (row === null) return undefined;
      return { user: toUser(row.user), externalIdentity: toExternalIdentity(row) };
    },

    async findById(scope, userId) {
      const row = await transactionClient(scope).user.findUnique({ where: { id: userId } });
      return row === null ? undefined : toUser(row);
    },

    async insertRegistration(scope: TransactionScope, registration: UserRegistration) {
      const { user, externalIdentity: identity } = registration;
      if (identity.userId !== user.id) throw new Error("external identity must belong to the user");
      const tx = transactionClient(scope);
      await tx.$executeRaw`SAVEPOINT tali_user_registration`;
      await tx.user.create({
        data: {
          id: user.id,
          displayName: user.displayName,
          status: user.status,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      });
      const linked = await tx.$executeRaw`
        INSERT INTO external_identities (id, user_id, provider, provider_subject, created_at)
        VALUES (${identity.id}::uuid, ${identity.userId}::uuid, ${identity.provider}, ${identity.providerSubject},
                ${identity.createdAt.toISOString()}::timestamptz)
        ON CONFLICT (provider, provider_subject) DO NOTHING`;
      if (linked === 0) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT tali_user_registration`;
        await tx.$executeRaw`RELEASE SAVEPOINT tali_user_registration`;
        return "identity-already-linked";
      }
      await tx.$executeRaw`RELEASE SAVEPOINT tali_user_registration`;
      return "inserted";
    },
  };
}
