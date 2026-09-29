import type {
  Business,
  BusinessId,
  BusinessMembership,
  BusinessStatus,
  CurrencyDefinition,
  MembershipRole,
  MembershipStatus,
  User,
  UserId,
  UserStatus,
} from "@tali/domain";
import { restoreBusiness, restoreMembership, restoreUser } from "@tali/domain";
import { AuditRecorder } from "../audit/audit-recorder.js";
import { taliAuditRegistry } from "../audit/tali-audit-registry.js";
import type { AuthenticatedUserContext } from "../context/authenticated-user-context.js";
import { parseCorrelationId } from "../context/business-context.js";
import { KeyedIdempotency } from "../idempotency/keyed-idempotency.js";
import type {
  BusinessContextResolver,
  CreateBusiness,
  CreateBusinessInput,
  CreateBusinessResult,
  GetBusiness,
  ListMembers,
  ListMyBusinesses,
} from "../modules/business/index.js";
import type { VerifiedIdentity } from "../ports/identity-provider.js";
import {
  createBusinessContextResolver,
  createCreateBusiness,
  createGetBusiness,
  createListMembers,
  createListMyBusinesses,
} from "../modules/business/index.js";
import type { GetCurrentUser, RegisterCurrentUser, UserContextResolver } from "../modules/identity/index.js";
import {
  createGetCurrentUser,
  createRegisterCurrentUser,
  createUserContextResolver,
} from "../modules/identity/index.js";
import type { ListLocations } from "../modules/location/index.js";
import { createDefaultLocationCreation, createListLocations } from "../modules/location/index.js";
import { FakeFingerprintHasher } from "./fake-fingerprint-hasher.js";
import { FakeIdentityProvider } from "./fake-identity-provider.js";
import { FixedClock } from "./fixed-clock.js";
import { InMemoryAuditWriter } from "./in-memory-audit-writer.js";
import { InMemoryTenancyStore } from "./in-memory-tenancy-store.js";
import { InMemoryUnitOfWork } from "./in-memory-unit-of-work.js";
import { InMemoryUserIdempotencyStore } from "./in-memory-user-idempotency-store.js";
import { SequentialIdGenerator } from "./sequential-id-generator.js";

/** Every Slice 1 use case composed over deterministic in-memory fakes. */
export interface TenancyHarness {
  readonly clock: FixedClock;
  readonly ids: SequentialIdGenerator;
  readonly unitOfWork: InMemoryUnitOfWork;
  readonly store: InMemoryTenancyStore;
  readonly auditWriter: InMemoryAuditWriter;
  readonly idempotencyStore: InMemoryUserIdempotencyStore;
  readonly hasher: FakeFingerprintHasher;
  readonly identityProvider: FakeIdentityProvider;
  readonly userContexts: UserContextResolver;
  readonly businessContexts: BusinessContextResolver;
  readonly registerCurrentUser: RegisterCurrentUser;
  readonly getCurrentUser: GetCurrentUser;
  readonly createBusiness: CreateBusiness;
  readonly listMyBusinesses: ListMyBusinesses;
  readonly getBusiness: GetBusiness;
  readonly listLocations: ListLocations;
  readonly listMembers: ListMembers;
  /** Verified identity for a provider subject, as the transport guard would produce. */
  identityFor(subject: string): Promise<VerifiedIdentity>;
  /** Registers a user through RegisterCurrentUser and returns its resolved context. */
  registeredUser(subject: string, displayName?: string): Promise<RegisteredTestUser>;
  /** Creates a business through CreateBusiness with a fresh idempotency key. */
  businessOwnedBy(
    user: RegisteredTestUser,
    input?: Partial<Omit<CreateBusinessInput, "idempotencyKey">>,
  ): Promise<CreateBusinessResult>;
  /** Adds a membership directly (Slice 1 has no invitation use case). */
  addMember(
    businessId: BusinessId,
    user: RegisteredTestUser,
    role: MembershipRole,
    status?: MembershipStatus,
  ): BusinessMembership;
  /** Replaces a stored record with a changed status, as later slices' use cases would. */
  setUserStatus(user: RegisteredTestUser, status: UserStatus): void;
  setBusinessStatus(businessId: BusinessId, status: BusinessStatus): void;
  setMembershipStatus(membership: BusinessMembership, status: MembershipStatus): void;
}

export interface RegisteredTestUser {
  readonly identity: VerifiedIdentity;
  readonly context: AuthenticatedUserContext;
  readonly userId: UserId;
}

const TEST_CORRELATION_ID = parseCorrelationId("test-request");

export function createTenancyHarness(options: {
  readonly currencies: readonly CurrencyDefinition[];
  readonly start?: string;
}): TenancyHarness {
  const clock = new FixedClock(options.start ?? "2026-09-29T08:00:00.000Z");
  const ids = new SequentialIdGenerator();
  const unitOfWork = new InMemoryUnitOfWork();
  const store = new InMemoryTenancyStore({ unitOfWork });
  for (const currency of options.currencies) store.addCurrency(currency);
  const auditWriter = new InMemoryAuditWriter({ unitOfWork });
  const idempotencyStore = new InMemoryUserIdempotencyStore({ unitOfWork });
  const hasher = new FakeFingerprintHasher();
  const identityProvider = new FakeIdentityProvider(clock);
  const audit = new AuditRecorder({ registry: taliAuditRegistry, writer: auditWriter, clock, ids });
  const users = store.userRepository;
  const businesses = store.businessRepository;
  const memberships = store.membershipRepository;
  const locations = store.locationRepository;
  const userContexts = createUserContextResolver({ unitOfWork, users });
  const registerCurrentUser = createRegisterCurrentUser({ unitOfWork, users, audit, ids, clock });
  const createBusiness = createCreateBusiness({
    unitOfWork,
    users,
    businesses,
    memberships,
    currencies: store.currencyRepository,
    defaultLocation: createDefaultLocationCreation({ locations, audit, ids }),
    idempotency: new KeyedIdempotency({ store: idempotencyStore, clock, ids }),
    hasher,
    audit,
    ids,
    clock,
  });
  const firstCurrency = options.currencies[0];

  const identityFor = (subject: string) => identityProvider.verifyAccessToken(identityProvider.issueToken(subject));

  const requireUser = (userId: UserId): User => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (user === undefined) throw new Error("unknown test user");
    return user;
  };

  const requireBusiness = (businessId: BusinessId): Business => {
    const business = store.businesses.find((candidate) => candidate.id === businessId);
    if (business === undefined) throw new Error("unknown test business");
    return business;
  };

  return {
    identityFor,
    async registeredUser(subject, displayName = "Test User") {
      const identity = await identityFor(subject);
      const { user } = await registerCurrentUser.execute({
        identity,
        displayName,
        correlationId: TEST_CORRELATION_ID,
        sourceChannel: "web",
      });
      return {
        identity,
        userId: user.id,
        context: { userId: user.id, correlationId: TEST_CORRELATION_ID, sourceChannel: "web" },
      };
    },
    async businessOwnedBy(user, input = {}) {
      if (firstCurrency === undefined) throw new Error("the harness needs at least one currency");
      const outcome = await createBusiness.execute(user.context, {
        name: input.name ?? "Test Shop",
        currencyCode: input.currencyCode ?? firstCurrency.code,
        timeZone: input.timeZone ?? "Etc/UTC",
        idempotencyKey: ids.newId("IdempotencyKey"),
      });
      return outcome.result;
    },
    addMember(businessId, user, role, status = "ACTIVE") {
      const now = clock.now();
      const membership = restoreMembership({
        id: ids.newId("Membership"),
        businessId,
        userId: user.userId,
        role,
        status,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      store.putMembership(membership);
      return membership;
    },
    setUserStatus(user, status) {
      store.putUser(restoreUser({ ...requireUser(user.userId), status }));
    },
    setBusinessStatus(businessId, status) {
      store.putBusiness(restoreBusiness({ ...requireBusiness(businessId), status }));
    },
    setMembershipStatus(membership, status) {
      store.putMembership(restoreMembership({ ...membership, status }));
    },
    clock,
    ids,
    unitOfWork,
    store,
    auditWriter,
    idempotencyStore,
    hasher,
    identityProvider,
    userContexts,
    businessContexts: createBusinessContextResolver({ unitOfWork, userContexts, businesses, memberships }),
    registerCurrentUser,
    getCurrentUser: createGetCurrentUser({ unitOfWork, users }),
    createBusiness,
    listMyBusinesses: createListMyBusinesses({ unitOfWork, users, memberships }),
    getBusiness: createGetBusiness({ unitOfWork, businesses }),
    listLocations: createListLocations({ unitOfWork, locations }),
    listMembers: createListMembers({ unitOfWork, memberships }),
  };
}
