/**
 * Composes the Slice 1 use cases over the PostgreSQL repositories and the
 * Prisma unit of work, as the API composition root will (Slice 3). Test
 * inputs only: the fingerprint hasher is the application's deterministic fake
 * (the real SHA-256 adapter arrives in Slice 3), identities come from the fake
 * identity provider, and failures are injected by wrapping a repository in a
 * test-only decorator, never through a production switch.
 */
import {
  type AcceptInvitation,
  AuditRecorder,
  type AuthenticatedUserContext,
  type BusinessContext,
  type ChangeMemberRole,
  type CreateBusiness,
  type CreateBusinessInput,
  type CreateBusinessOutcome,
  type CreateInvitation,
  createAcceptInvitation,
  createBusinessContextResolver,
  createChangeMemberRole,
  createCreateBusiness,
  createCreateInvitation,
  createDefaultLocationCreation,
  createDeviceVerifier,
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
  type DeviceVerifier,
  KeyedIdempotency,
  type ListDevices,
  type ListLocations,
  type ListMembers,
  type ListMyBusinesses,
  parseCorrelationId,
  type ReactivateMember,
  type RegisterCurrentUser,
  type RegisterDevice,
  type RevokeDevice,
  type RevokeInvitation,
  type SuspendMember,
  taliAuditRegistry,
  type UnitOfWork,
  type UpdateBusinessName,
  type UserId,
} from "@tali/application";
import {
  FakeFingerprintHasher,
  FakeIdentityProvider,
  FakeOneTimeSecretGenerator,
  FakeSecretHasher,
  FixedClock,
  SequentialIdGenerator,
} from "@tali/application/testing";
import type { BusinessId, BusinessMembership, MembershipRole, MembershipStatus } from "@tali/domain";
import { restoreMembership } from "@tali/domain";
import { beforeEach } from "vitest";
import { createRepositories, type DatabaseRepositories } from "../../src/database.js";
import { PrismaUnitOfWork, type UnitOfWorkSettings } from "../../src/unit-of-work/prisma-unit-of-work.js";
import { useFixtureHarness } from "./harness.js";

export const TEST_CORRELATION_ID = parseCorrelationId("test-request");

export interface RegisteredUser {
  readonly userId: UserId;
  readonly context: AuthenticatedUserContext;
}

export interface Tenancy {
  readonly unitOfWork: UnitOfWork;
  readonly repositories: DatabaseRepositories;
  readonly registerCurrentUser: RegisterCurrentUser;
  readonly createBusiness: CreateBusiness;
  readonly listMyBusinesses: ListMyBusinesses;
  readonly listMembers: ListMembers;
  readonly listLocations: ListLocations;
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
  readonly deviceVerifier: DeviceVerifier;
  registeredUser(subject: string, displayName?: string): Promise<RegisteredUser>;
  create(user: RegisteredUser, input?: Partial<CreateBusinessInput>): Promise<CreateBusinessOutcome>;
  /** The server-resolved context of an ACTIVE member, as the API's BusinessContextGuard produces it. */
  contextFor(user: RegisteredUser, businessId: BusinessId): Promise<BusinessContext>;
}

/** Per-test deterministic inputs, shared by every composition in the test so identifiers never collide. */
interface World {
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly hasher: FakeFingerprintHasher;
  readonly identities: FakeIdentityProvider;
  readonly secrets: FakeOneTimeSecretGenerator;
  readonly secretHasher: FakeSecretHasher;
}

function newWorld(): World {
  const clock = new FixedClock("2026-09-29T08:00:00.000Z");
  return {
    clock,
    ids: new SequentialIdGenerator(),
    hasher: new FakeFingerprintHasher(),
    identities: new FakeIdentityProvider(clock),
    secrets: new FakeOneTimeSecretGenerator(),
    secretHasher: new FakeSecretHasher(),
  };
}

export function useTenancyHarness() {
  const base = useFixtureHarness();
  const repositories = createRepositories();
  let world = newWorld();
  beforeEach(() => {
    world = newWorld();
  });

  function unitOfWorkWith(settings: Partial<UnitOfWorkSettings> = {}): PrismaUnitOfWork {
    return new PrismaUnitOfWork(base.client, { maxWaitMs: 5_000, timeoutMs: 15_000, ...settings });
  }

  function compose(
    options: { readonly unitOfWork?: UnitOfWork; readonly decorate?: Partial<DatabaseRepositories> } = {},
  ): Tenancy {
    const uow = options.unitOfWork ?? base.unitOfWork;
    const repos: DatabaseRepositories = { ...repositories, ...options.decorate };
    const { clock, ids, hasher, identities, secrets, secretHasher } = world;
    const { businesses, memberships, invitations, devices } = repos;
    const businessIdempotency = new KeyedIdempotency({ businessStore: repos.businessIdempotency, clock, ids });
    const userContexts = createUserContextResolver({ unitOfWork: uow, users: repos.users });
    const businessContexts = createBusinessContextResolver({ unitOfWork: uow, userContexts, businesses, memberships });
    const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: repos.auditWriter, clock, ids });
    const registerCurrentUser = createRegisterCurrentUser({ unitOfWork: uow, users: repos.users, audit, ids, clock });
    const createBusiness = createCreateBusiness({
      unitOfWork: uow,
      users: repos.users,
      businesses: repos.businesses,
      memberships: repos.memberships,
      currencies: repos.currencies,
      defaultLocation: createDefaultLocationCreation({ locations: repos.locations, audit, ids }),
      idempotency: new KeyedIdempotency({ store: repos.userIdempotency, clock, ids }),
      hasher,
      audit,
      ids,
      clock,
    });
    return {
      unitOfWork: uow,
      repositories: repos,
      registerCurrentUser,
      createBusiness,
      listMyBusinesses: createListMyBusinesses({ unitOfWork: uow, users: repos.users, memberships: repos.memberships }),
      listMembers: createListMembers({ unitOfWork: uow, memberships: repos.memberships }),
      listLocations: createListLocations({ unitOfWork: uow, locations: repos.locations }),
      updateBusinessName: createUpdateBusinessName({ unitOfWork: uow, businesses, memberships, audit, clock }),
      changeMemberRole: createChangeMemberRole({ unitOfWork: uow, businesses, memberships, audit, clock }),
      suspendMember: createSuspendMember({ unitOfWork: uow, businesses, memberships, audit, clock }),
      reactivateMember: createReactivateMember({ unitOfWork: uow, businesses, memberships, audit, clock }),
      createInvitation: createCreateInvitation({
        unitOfWork: uow,
        memberships,
        invitations,
        idempotency: businessIdempotency,
        hasher,
        secrets,
        secretHasher,
        audit,
        ids,
        clock,
      }),
      revokeInvitation: createRevokeInvitation({ unitOfWork: uow, memberships, invitations, audit, clock }),
      acceptInvitation: createAcceptInvitation({
        unitOfWork: uow,
        users: repos.users,
        businesses,
        memberships,
        invitations,
        secretHasher,
        audit,
        ids,
        clock,
      }),
      registerDevice: createRegisterDevice({
        unitOfWork: uow,
        memberships,
        devices,
        idempotency: businessIdempotency,
        hasher,
        secrets,
        secretHasher,
        audit,
        ids,
        clock,
      }),
      listDevices: createListDevices({ unitOfWork: uow, devices }),
      revokeDevice: createRevokeDevice({ unitOfWork: uow, memberships, devices, audit, clock }),
      deviceVerifier: createDeviceVerifier({ unitOfWork: uow, devices, secretHasher }),
      contextFor(user, businessId) {
        return businessContexts.resolveForUser(user.context, businessId);
      },
      async registeredUser(subject, displayName = "Test User") {
        const identity = await identities.verifyAccessToken(identities.issueToken(subject));
        const { user } = await registerCurrentUser.execute({
          identity,
          displayName,
          correlationId: TEST_CORRELATION_ID,
          sourceChannel: "web",
        });
        return {
          userId: user.id,
          context: { userId: user.id, correlationId: TEST_CORRELATION_ID, sourceChannel: "web" },
        };
      },
      create(user, input = {}) {
        return createBusiness.execute(user.context, {
          name: input.name ?? "Test Shop",
          currencyCode: input.currencyCode ?? "NGN",
          timeZone: input.timeZone ?? "Africa/Lagos",
          idempotencyKey: "idempotencyKey" in input ? input.idempotencyKey : ids.newId("IdempotencyKey"),
        });
      },
    };
  }

  /** Adds a membership through the repository (Slice 1 has no invitation use case yet). */
  async function addMember(
    businessId: BusinessId,
    user: RegisteredUser,
    role: MembershipRole,
    status: MembershipStatus = "ACTIVE",
  ): Promise<BusinessMembership> {
    const now = world.clock.now();
    const membership = restoreMembership({
      id: world.ids.newId("Membership"),
      businessId,
      userId: user.userId,
      role,
      status,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await base.unitOfWork.run((scope) => repositories.memberships.insert(scope, membership));
    return membership;
  }

  return { ...base, repositories, unitOfWorkWith, compose, addMember, world: () => world };
}
