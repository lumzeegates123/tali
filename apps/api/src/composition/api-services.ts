import {
  AuditRecorder,
  type BusinessContextResolver,
  type Clock,
  type CreateBusiness,
  createBusinessContextResolver,
  createCreateBusiness,
  createDefaultLocationCreation,
  createDefaultLocationResolver,
  createGetBusiness,
  createGetCurrentUser,
  createListLocations,
  createListMembers,
  createListMyBusinesses,
  createRegisterCurrentUser,
  createUserContextResolver,
  type DefaultLocationResolver,
  type FingerprintHasher,
  type GetBusiness,
  type GetCurrentUser,
  type IdGenerator,
  KeyedIdempotency,
  type ListLocations,
  type ListMembers,
  type ListMyBusinesses,
  type RegisterCurrentUser,
  taliAuditRegistry,
  type UserContextResolver,
} from "@tali/application";
import type { Database } from "@tali/database";

/**
 * The application-facing services the HTTP layer may call: context resolvers
 * and use cases only. Guards and controllers receive this object; they never
 * see repositories, the unit of work or the Prisma client.
 */
export interface ApiServices {
  readonly userContexts: UserContextResolver;
  readonly businessContexts: BusinessContextResolver;
  readonly defaultLocations: DefaultLocationResolver;
  readonly registerCurrentUser: RegisterCurrentUser;
  readonly getCurrentUser: GetCurrentUser;
  readonly createBusiness: CreateBusiness;
  readonly listMyBusinesses: ListMyBusinesses;
  readonly getBusiness: GetBusiness;
  readonly listLocations: ListLocations;
  readonly listMembers: ListMembers;
}

/**
 * Composes the Slice 1 use cases over the Slice 2 PostgreSQL adapters: one
 * unit of work, the PostgreSQL audit writer and user idempotency store, the
 * SHA-256 fingerprint hasher and the UUIDv7 generator. Transaction semantics
 * are exactly those of the unit of work; nothing here opens transactions.
 */
export function composeApiServices(dependencies: {
  readonly database: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hasher: FingerprintHasher;
}): ApiServices {
  const { database, clock, ids, hasher } = dependencies;
  const { unitOfWork } = database;
  const { users, businesses, memberships, locations, currencies, auditWriter, userIdempotency } = database.repositories;
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: auditWriter, clock, ids });
  const userContexts = createUserContextResolver({ unitOfWork, users });

  return Object.freeze({
    userContexts,
    businessContexts: createBusinessContextResolver({ unitOfWork, userContexts, businesses, memberships }),
    defaultLocations: createDefaultLocationResolver({ unitOfWork, locations }),
    registerCurrentUser: createRegisterCurrentUser({ unitOfWork, users, audit, ids, clock }),
    getCurrentUser: createGetCurrentUser({ unitOfWork, users }),
    createBusiness: createCreateBusiness({
      unitOfWork,
      users,
      businesses,
      memberships,
      currencies,
      defaultLocation: createDefaultLocationCreation({ locations, audit, ids }),
      idempotency: new KeyedIdempotency({ store: userIdempotency, clock, ids }),
      hasher,
      audit,
      ids,
      clock,
    }),
    listMyBusinesses: createListMyBusinesses({ unitOfWork, users, memberships }),
    getBusiness: createGetBusiness({ unitOfWork, businesses }),
    listLocations: createListLocations({ unitOfWork, locations }),
    listMembers: createListMembers({ unitOfWork, memberships }),
  });
}
