import type {
  Business,
  BusinessId,
  BusinessInvitation,
  BusinessLocation,
  BusinessMembership,
  CurrencyCode,
  CurrencyDefinition,
  Device,
  ExternalIdentity,
  ExternalIdentityKey,
  User,
  UserId,
} from "@tali/domain";
import { countActiveOwners, isBusinessActive, isMembershipActive, sameExternalIdentityKey } from "@tali/domain";
import { ConcurrentModificationError } from "../errors/application-error.js";
import { assertInvitationTransition, assertMembershipTransition } from "../modules/business/ports.js";
import type {
  AccessibleBusiness,
  BusinessRepository,
  CurrencyReferenceRepository,
  InvitationRepository,
  MemberListing,
  MembershipRepository,
} from "../modules/business/index.js";
import type { DeviceRepository } from "../modules/device/index.js";
import { assertDeviceTransition } from "../modules/device/index.js";
import type { UserRegistration, UserRepository } from "../modules/identity/index.js";
import type { LocationRepository } from "../modules/location/index.js";
import type { SecretDigest } from "../ports/one-time-secret.js";
import type { TransactionScope } from "../ports/unit-of-work.js";

const hex = (digest: Uint8Array) => Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

interface StoredInvitation {
  readonly invitation: BusinessInvitation;
  readonly tokenDigest: SecretDigest;
}

interface StoredDevice {
  readonly device: Device;
  readonly credentialDigest: SecretDigest;
}
import type { Page, PageRequest } from "../queries/pagination.js";
import { FailureInjection } from "./failure-injection.js";
import type { InMemoryUnitOfWork, RollbackParticipant } from "./in-memory-unit-of-work.js";

export function page<T>(items: readonly T[], idOf: (item: T) => string, request: PageRequest): Page<T> {
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
  #invitations = new Map<string, StoredInvitation>();
  #devices = new Map<string, StoredDevice>();
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
    const invitations = new Map(this.#invitations);
    const devices = new Map(this.#devices);
    return () => {
      this.#users = users;
      this.#identities = identities;
      this.#businesses = businesses;
      this.#locations = locations;
      this.#memberships = memberships;
      this.#invitations = invitations;
      this.#devices = devices;
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

  get invitations(): readonly BusinessInvitation[] {
    return [...this.#invitations.values()].map((stored) => stored.invitation);
  }

  get devices(): readonly Device[] {
    return [...this.#devices.values()].map((stored) => stored.device);
  }

  /** Every stored secret digest, hex-encoded, for negative assertions. */
  get storedDigests(): readonly string[] {
    return [
      ...[...this.#invitations.values()].map((stored) => hex(stored.tokenDigest)),
      ...[...this.#devices.values()].map((stored) => hex(stored.credentialDigest)),
    ];
  }

  /** Replaces a stored invitation's state, as time or another request would. */
  putInvitation(invitation: BusinessInvitation): this {
    const stored = this.#invitations.get(invitation.id);
    if (stored === undefined) throw new Error("unknown invitation");
    this.#invitations.set(invitation.id, { ...stored, invitation });
    return this;
  }

  /** Replaces a stored device's state, as another request would. */
  putDevice(device: Device): this {
    const stored = this.#devices.get(device.id);
    if (stored === undefined) throw new Error("unknown device");
    this.#devices.set(device.id, { ...stored, device });
    return this;
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
    // In-memory transactions do not interleave, so the row lock is implicit; proven against PostgreSQL.
    findByIdForUpdate: async (scope, businessId: BusinessId) => {
      this.#enter(scope, "businesses.findByIdForUpdate");
      return this.#businesses.get(businessId);
    },
    insert: async (scope, business) => {
      this.#enter(scope, "businesses.insert");
      if (this.#businesses.has(business.id)) throw new Error("duplicate primary key");
      if (!this.#users.has(business.createdByUserId)) throw new Error("business creator does not exist");
      if (!this.#currencies.has(business.currencyCode)) throw new Error("currency is not in the reference data");
      this.#businesses.set(business.id, business);
    },
    update: async (scope, business) => {
      this.#enter(scope, "businesses.update");
      const stored = this.#businesses.get(business.id);
      if (stored === undefined) throw new ConcurrentModificationError();
      if (stored.currencyCode !== business.currencyCode || stored.timeZone !== business.timeZone) {
        throw new Error("a business's currency and time zone never change");
      }
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
    findActiveDefault: async (scope, businessId) => {
      this.#enter(scope, "locations.findActiveDefault");
      return [...this.#locations.values()].find(
        (location) => location.businessId === businessId && location.isDefault && location.status === "ACTIVE",
      );
    },
  };

  readonly membershipRepository: MembershipRepository = {
    findByBusinessAndUser: async (scope, businessId, userId) => {
      this.#enter(scope, "memberships.findByBusinessAndUser");
      return [...this.#memberships.values()].find(
        (membership) => membership.businessId === businessId && membership.userId === userId,
      );
    },
    findById: async (scope, businessId, membershipId) => {
      this.#enter(scope, "memberships.findById");
      const membership = this.#memberships.get(membershipId);
      return membership?.businessId === businessId ? membership : undefined;
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
    // In-memory transactions do not interleave inside the store, so the lock
    // only reports whether the business exists. Lock behaviour is proven
    // against PostgreSQL in packages/database.
    lockBusinessForMembershipChange: async (scope, businessId) => {
      this.#enter(scope, "memberships.lockBusinessForMembershipChange");
      return this.#businesses.has(businessId);
    },
    countActiveOwners: async (scope, businessId) => {
      this.#enter(scope, "memberships.countActiveOwners");
      return countActiveOwners([...this.#memberships.values()].filter((m) => m.businessId === businessId));
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "memberships.update");
      assertMembershipTransition(previous, next);
      const stored = this.#memberships.get(previous.id);
      if (stored?.businessId !== previous.businessId || stored.version !== previous.version) {
        throw new ConcurrentModificationError();
      }
      this.#memberships.set(next.id, next);
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

  #requireMemberOf(businessId: BusinessId, membershipId: string | undefined): void {
    if (membershipId === undefined) return;
    if (this.#memberships.get(membershipId)?.businessId !== businessId) {
      throw new Error("referenced membership is not in the same business");
    }
  }

  readonly invitationRepository: InvitationRepository = {
    insert: async (scope, invitation, tokenDigest) => {
      this.#enter(scope, "invitations.insert");
      if (this.#invitations.has(invitation.id)) throw new Error("duplicate primary key");
      if (tokenDigest.length !== 32) throw new Error("token digest must be 32 bytes");
      if ([...this.#invitations.values()].some((stored) => hex(stored.tokenDigest) === hex(tokenDigest))) {
        throw new Error("duplicate token digest");
      }
      if (!this.#businesses.has(invitation.businessId)) throw new Error("invitation business does not exist");
      this.#requireMemberOf(invitation.businessId, invitation.createdByMembershipId);
      this.#invitations.set(invitation.id, { invitation, tokenDigest: new Uint8Array(tokenDigest) as SecretDigest });
    },
    findByIdForUpdate: async (scope, businessId, invitationId) => {
      this.#enter(scope, "invitations.findByIdForUpdate");
      const stored = this.#invitations.get(invitationId);
      return stored?.invitation.businessId === businessId ? stored.invitation : undefined;
    },
    findByTokenDigestForUpdate: async (scope, tokenDigest) => {
      this.#enter(scope, "invitations.findByTokenDigestForUpdate");
      const wanted = hex(tokenDigest);
      return [...this.#invitations.values()].find((stored) => hex(stored.tokenDigest) === wanted)?.invitation;
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "invitations.update");
      assertInvitationTransition(previous, next);
      const stored = this.#invitations.get(previous.id);
      if (stored?.invitation.businessId !== previous.businessId || stored.invitation.status !== previous.status) {
        throw new ConcurrentModificationError();
      }
      this.#requireMemberOf(next.businessId, next.acceptedByMembershipId);
      this.#requireMemberOf(next.businessId, next.revokedByMembershipId);
      this.#invitations.set(next.id, { ...stored, invitation: next });
    },
  };

  readonly deviceRepository: DeviceRepository = {
    insert: async (scope, device, credentialDigest) => {
      this.#enter(scope, "devices.insert");
      if (this.#devices.has(device.id)) throw new Error("duplicate primary key");
      if (credentialDigest.length !== 32) throw new Error("credential digest must be 32 bytes");
      if (!this.#businesses.has(device.businessId)) throw new Error("device business does not exist");
      this.#requireMemberOf(device.businessId, device.registeredByMembershipId);
      this.#devices.set(device.id, { device, credentialDigest: new Uint8Array(credentialDigest) as SecretDigest });
    },
    findByIdForUpdate: async (scope, businessId, deviceId) => {
      this.#enter(scope, "devices.findByIdForUpdate");
      const stored = this.#devices.get(deviceId);
      return stored?.device.businessId === businessId ? stored.device : undefined;
    },
    findForVerification: async (scope, businessId, deviceId) => {
      this.#enter(scope, "devices.findForVerification");
      const stored = this.#devices.get(deviceId);
      if (stored?.device.businessId !== businessId) return undefined;
      return { device: stored.device, credentialDigest: new Uint8Array(stored.credentialDigest) as SecretDigest };
    },
    update: async (scope, previous, next) => {
      this.#enter(scope, "devices.update");
      assertDeviceTransition(previous, next);
      const stored = this.#devices.get(previous.id);
      if (stored?.device.businessId !== previous.businessId || stored.device.status !== previous.status) {
        throw new ConcurrentModificationError();
      }
      this.#requireMemberOf(next.businessId, next.revokedByMembershipId);
      this.#devices.set(next.id, { ...stored, device: next });
    },
    list: async (scope, businessId, request) => {
      this.#enter(scope, "devices.list");
      const owned = [...this.#devices.values()]
        .map((stored) => stored.device)
        .filter((device) => device.businessId === businessId);
      return page(owned, (device) => device.id, request);
    },
  };

  readonly currencyRepository: CurrencyReferenceRepository = {
    findByCode: async (scope, code: CurrencyCode) => {
      this.#enter(scope, "currencies.findByCode");
      return this.#currencies.get(code);
    },
  };
}
