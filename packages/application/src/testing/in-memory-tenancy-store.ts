import type {
  Business,
  BusinessId,
  BusinessLocation,
  BusinessMembership,
  CurrencyCode,
  CurrencyDefinition,
  ExternalIdentity,
  ExternalIdentityKey,
  User,
  UserId,
} from "@tali/domain";
import { isBusinessActive, isMembershipActive, sameExternalIdentityKey } from "@tali/domain";
import type {
  AccessibleBusiness,
  BusinessRepository,
  CurrencyReferenceRepository,
  MemberListing,
  MembershipRepository,
} from "../modules/business/index.js";
import type { UserRegistration, UserRepository } from "../modules/identity/index.js";
import type { LocationRepository } from "../modules/location/index.js";
import type { TransactionScope } from "../ports/unit-of-work.js";
import type { Page, PageRequest } from "../queries/pagination.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

function page<T>(items: readonly T[], idOf: (item: T) => string, request: PageRequest): Page<T> {
  const ordered = [...items].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
  const after = request.after;
  const remaining = after === undefined ? ordered : ordered.filter((item) => idOf(item) > after);
  const selected = remaining.slice(0, request.limit);
  const last = selected.at(-1);
  return {
    items: selected,
    nextCursor: remaining.length > request.limit && last !== undefined ? idOf(last) : null,
  };
}

/**
 * In-memory users, identities, businesses, locations, memberships and
 * currency reference data, implementing every Slice 1 repository port. It
 * enforces the uniqueness and ownership constraints the Slice 2 schema will
 * enforce, so use case tests fail on the same mistakes. It proves nothing
 * about database-level tenant isolation.
 */
export class InMemoryTenancyStore implements RollbackParticipant {
  readonly failures = new FailureInjection();
  readonly #unitOfWork: InMemoryUnitOfWork | undefined;
  #users = new Map<string, User>();
  #identities: ExternalIdentity[] = [];
  #businesses = new Map<string, Business>();
  #locations = new Map<string, BusinessLocation>();
  #memberships = new Map<string, BusinessMembership>();
  readonly #currencies = new Map<string, CurrencyDefinition>();

  constructor(options: { readonly unitOfWork?: InMemoryUnitOfWork } = {}) {
    this.#unitOfWork = options.unitOfWork;
    this.#unitOfWork?.enlist(this);
  }

  captureState(): () => void {
    const users = new Map(this.#users);
    const identities = [...this.#identities];
    const businesses = new Map(this.#businesses);
    const locations = new Map(this.#locations);
    const memberships = new Map(this.#memberships);
    return () => {
      this.#users = users;
      this.#identities = identities;
      this.#businesses = businesses;
      this.#locations = locations;
      this.#memberships = memberships;
    };
  }

  // Test setup: direct writes, bypassing use cases.

  addCurrency(definition: CurrencyDefinition): this {
    this.#currencies.set(definition.code, definition);
    return this;
  }

  putUser(user: User, identity?: ExternalIdentity): this {
    this.#users.set(user.id, user);
    if (identity !== undefined) this.#identities.push(identity);
    return this;
  }

  putBusiness(business: Business): this {
    this.#businesses.set(business.id, business);
    return this;
  }

  putLocation(location: BusinessLocation): this {
    this.#locations.set(location.id, location);
    return this;
  }

  putMembership(membership: BusinessMembership): this {
    this.#memberships.set(membership.id, membership);
    return this;
  }

  // Inspection.

  get users(): readonly User[] {
    return [...this.#users.values()];
  }

  get externalIdentities(): readonly ExternalIdentity[] {
    return [...this.#identities];
  }

  get businesses(): readonly Business[] {
    return [...this.#businesses.values()];
  }

  get locations(): readonly BusinessLocation[] {
    return [...this.#locations.values()];
  }

  get memberships(): readonly BusinessMembership[] {
    return [...this.#memberships.values()];
  }

  #enter(scope: TransactionScope, operation: string): void {
    this.#unitOfWork?.assertActive(scope);
    this.failures.check(operation);
  }

  readonly userRepository: UserRepository = {
    findByExternalIdentity: async (scope, key: ExternalIdentityKey) => {
      this.#enter(scope, "users.findByExternalIdentity");
      const identity = this.#identities.find((candidate) => sameExternalIdentityKey(candidate, key));
      if (identity === undefined) return undefined;
      const user = this.#users.get(identity.userId);
      if (user === undefined) throw new Error("external identity references a missing user");
      return { user, externalIdentity: identity };
    },
    findById: async (scope, userId: UserId) => {
      this.#enter(scope, "users.findById");
      return this.#users.get(userId);
    },
    insertRegistration: async (scope, registration: UserRegistration) => {
      this.#enter(scope, "users.insertRegistration");
      const { user, externalIdentity } = registration;
      if (externalIdentity.userId !== user.id) throw new Error("external identity must belong to the user");
      if (this.#identities.some((candidate) => sameExternalIdentityKey(candidate, externalIdentity))) {
        return "identity-already-linked";
      }
      if (this.#users.has(user.id) || this.#identities.some((candidate) => candidate.id === externalIdentity.id)) {
        throw new Error("duplicate primary key");
      }
      this.#users.set(user.id, user);
      this.#identities.push(externalIdentity);
      return "inserted";
    },
  };

  readonly businessRepository: BusinessRepository = {
    findById: async (scope, businessId: BusinessId) => {
      this.#enter(scope, "businesses.findById");
      return this.#businesses.get(businessId);
    },
    insert: async (scope, business) => {
      this.#enter(scope, "businesses.insert");
      if (this.#businesses.has(business.id)) throw new Error("duplicate primary key");
      if (!this.#users.has(business.createdByUserId)) throw new Error("business creator does not exist");
      if (!this.#currencies.has(business.currencyCode)) throw new Error("currency is not in the reference data");
      this.#businesses.set(business.id, business);
    },
  };

  readonly locationRepository: LocationRepository = {
    insert: async (scope, location) => {
      this.#enter(scope, "locations.insert");
      if (this.#locations.has(location.id)) throw new Error("duplicate primary key");
      if (!this.#businesses.has(location.businessId)) throw new Error("location business does not exist");
      if (
        location.isDefault &&
        [...this.#locations.values()].some((other) => other.businessId === location.businessId && other.isDefault)
      ) {
        throw new Error("a business has exactly one default location");
      }
      this.#locations.set(location.id, location);
    },
    listForBusiness: async (scope, businessId, request) => {
      this.#enter(scope, "locations.listForBusiness");
      const owned = [...this.#locations.values()].filter((location) => location.businessId === businessId);
      return page(owned, (location) => location.id, request);
    },
  };

  readonly membershipRepository: MembershipRepository = {
    findByBusinessAndUser: async (scope, businessId, userId) => {
      this.#enter(scope, "memberships.findByBusinessAndUser");
      return [...this.#memberships.values()].find(
        (membership) => membership.businessId === businessId && membership.userId === userId,
      );
    },
    insert: async (scope, membership) => {
      this.#enter(scope, "memberships.insert");
      if (this.#memberships.has(membership.id)) throw new Error("duplicate primary key");
      if (!this.#businesses.has(membership.businessId)) throw new Error("membership business does not exist");
      if (!this.#users.has(membership.userId)) throw new Error("membership user does not exist");
      if (
        [...this.#memberships.values()].some(
          (other) => other.businessId === membership.businessId && other.userId === membership.userId,
        )
      ) {
        throw new Error("a user has at most one membership per business");
      }
      this.#memberships.set(membership.id, membership);
    },
    listMembers: async (scope, businessId, request) => {
      this.#enter(scope, "memberships.listMembers");
      const listings: MemberListing[] = [];
      for (const membership of this.#memberships.values()) {
        if (membership.businessId !== businessId) continue;
        const user = this.#users.get(membership.userId);
        if (user === undefined) throw new Error("membership references a missing user");
        listings.push({ membership, displayName: user.displayName });
      }
      return page(listings, (listing) => listing.membership.id, request);
    },
    listAccessibleBusinesses: async (scope, userId, request) => {
      this.#enter(scope, "memberships.listAccessibleBusinesses");
      const accessible: AccessibleBusiness[] = [];
      for (const membership of this.#memberships.values()) {
        if (membership.userId !== userId || !isMembershipActive(membership)) continue;
        const business = this.#businesses.get(membership.businessId);
        if (business === undefined || !isBusinessActive(business)) continue;
        accessible.push({ membership, business });
      }
      return page(accessible, (entry) => entry.membership.id, request);
    },
  };

  readonly currencyRepository: CurrencyReferenceRepository = {
    findByCode: async (scope, code: CurrencyCode) => {
      this.#enter(scope, "currencies.findByCode");
      return this.#currencies.get(code);
    },
  };
}
