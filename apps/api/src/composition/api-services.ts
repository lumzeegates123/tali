import {
  type AcceptInvitation,
  AuditRecorder,
  type BusinessContextResolver,
  type ChangeMemberRole,
  type Clock,
  type CreateBusiness,
  type CreateInvitation,
  createAcceptInvitation,
  createBusinessContextResolver,
  createChangeMemberRole,
  createCreateBusiness,
  createCreateInvitation,
  createDefaultLocationCreation,
  createDefaultLocationResolver,
  createDeviceVerifier,
  createGetBusiness,
  createGetCurrentUser,
  createListDevices,
  createListLocations,
  createListMembers,
  createListMyBusinesses,
  createReactivateMember,
  createRegisterCurrentUser,
  createRegisterDevice,
  createRevokeDevice,
  createRevokeInvitation,
  createSuspendMember,
  createUpdateBusinessName,
  createUserContextResolver,
  type DefaultLocationResolver,
  type DeviceVerifier,
  type FingerprintHasher,
  type GetBusiness,
  type GetCurrentUser,
  type IdGenerator,
  KeyedIdempotency,
  type ListDevices,
  type ListLocations,
  type ListMembers,
  type ListMyBusinesses,
  type OneTimeSecretGenerator,
  type ReactivateMember,
  type RegisterCurrentUser,
  type RegisterDevice,
  type RevokeDevice,
  type RevokeInvitation,
  type SecretHasher,
  type SuspendMember,
  taliAuditRegistry,
  type UpdateBusinessName,
  type UserContextResolver,
} from "@tali/application";
import type { Database } from "@tali/database";

/**
 * The application-facing services the HTTP layer may call: context resolvers,
 * the device verifier and use cases only. Guards and controllers receive this
 * object; they never see repositories, the unit of work or the Prisma client.
 */
export interface ApiServices {
  readonly userContexts: UserContextResolver;
  readonly businessContexts: BusinessContextResolver;
  readonly deviceVerifier: DeviceVerifier;
  readonly defaultLocations: DefaultLocationResolver;
  readonly registerCurrentUser: RegisterCurrentUser;
  readonly getCurrentUser: GetCurrentUser;
  readonly createBusiness: CreateBusiness;
  readonly listMyBusinesses: ListMyBusinesses;
  readonly getBusiness: GetBusiness;
  readonly listLocations: ListLocations;
  readonly listMembers: ListMembers;
  readonly updateBusinessName: UpdateBusinessName;
  readonly changeMemberRole: ChangeMemberRole;
  readonly suspendMember: SuspendMember;
  readonly reactivateMember: ReactivateMember;
  readonly createInvitation: CreateInvitation;
  readonly revokeInvitation: RevokeInvitation;
  readonly acceptInvitation: AcceptInvitation;
  readonly registerDevice: RegisterDevice;
  readonly listDevices: ListDevices;
  readonly revokeDevice: RevokeDevice;
}

/**
 * Composes the Build 1 use cases over the PostgreSQL adapters: one unit of
 * work, the PostgreSQL audit writer and idempotency stores, the SHA-256
 * fingerprint hasher, the UUIDv7 generator and the node:crypto one-time
 * secret adapters. Transaction semantics are exactly those of the unit of
 * work; nothing here opens transactions.
 */
export function composeApiServices(dependencies: {
  readonly database: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hasher: FingerprintHasher;
  readonly secrets: OneTimeSecretGenerator;
  readonly secretHasher: SecretHasher;
}): ApiServices {
  const { database, clock, ids, hasher, secrets, secretHasher } = dependencies;
  const { unitOfWork } = database;
  const {
    users,
    businesses,
    memberships,
    locations,
    currencies,
    invitations,
    devices,
    auditWriter,
    userIdempotency,
    businessIdempotency,
  } = database.repositories;
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: auditWriter, clock, ids });
  const userContexts = createUserContextResolver({ unitOfWork, users });
  const businessScoped = new KeyedIdempotency({ businessStore: businessIdempotency, clock, ids });

  return Object.freeze({
    userContexts,
    businessContexts: createBusinessContextResolver({ unitOfWork, userContexts, businesses, memberships }),
    deviceVerifier: createDeviceVerifier({ unitOfWork, devices, secretHasher }),
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
    updateBusinessName: createUpdateBusinessName({ unitOfWork, businesses, memberships, audit, clock }),
    changeMemberRole: createChangeMemberRole({ unitOfWork, businesses, memberships, audit, clock }),
    suspendMember: createSuspendMember({ unitOfWork, businesses, memberships, audit, clock }),
    reactivateMember: createReactivateMember({ unitOfWork, businesses, memberships, audit, clock }),
    createInvitation: createCreateInvitation({
      unitOfWork,
      memberships,
      invitations,
      idempotency: businessScoped,
      hasher,
      secrets,
      secretHasher,
      audit,
      ids,
      clock,
    }),
    revokeInvitation: createRevokeInvitation({ unitOfWork, memberships, invitations, audit, clock }),
    acceptInvitation: createAcceptInvitation({
      unitOfWork,
      users,
      businesses,
      memberships,
      invitations,
      secretHasher,
      audit,
      ids,
      clock,
    }),
    registerDevice: createRegisterDevice({
      unitOfWork,
      memberships,
      devices,
      idempotency: businessScoped,
      hasher,
      secrets,
      secretHasher,
      audit,
      ids,
      clock,
    }),
    listDevices: createListDevices({ unitOfWork, devices }),
    revokeDevice: createRevokeDevice({ unitOfWork, memberships, devices, audit, clock }),
  });
}
