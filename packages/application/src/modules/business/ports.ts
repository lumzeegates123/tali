import type {
  Business,
  BusinessId,
  BusinessMembership,
  CurrencyCode,
  CurrencyDefinition,
  DisplayName,
  UserId,
} from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { Page, PageRequest } from "../../queries/pagination.js";

export interface BusinessRepository {
  /** Callers pass only a business ID from a resolved context or a membership they have already loaded. */
  findById(scope: TransactionScope, businessId: BusinessId): Promise<Business | undefined>;
  insert(scope: TransactionScope, business: Business): Promise<void>;
}

/** A member of a business with the display name to show for them. */
export interface MemberListing {
  readonly membership: BusinessMembership;
  readonly displayName: DisplayName;
}

/** A business the user can currently access, with the membership that grants access. */
export interface AccessibleBusiness {
  readonly membership: BusinessMembership;
  readonly business: Business;
}

export interface MembershipRepository {
  /** The membership of one user in one business, whatever its status. */
  findByBusinessAndUser(
    scope: TransactionScope,
    businessId: BusinessId,
    userId: UserId,
  ): Promise<BusinessMembership | undefined>;
  insert(scope: TransactionScope, membership: BusinessMembership): Promise<void>;
  /**
   * Takes the business row lock (SELECT ... FOR UPDATE on `businesses`) that
   * serializes every change able to reduce the business's active owners,
   * held until the transaction ends (ADR-005 section 10). Call it before
   * re-reading the acting and target memberships and counting owners.
   * Returns false when the business does not exist.
   */
  lockBusinessForMembershipChange(scope: TransactionScope, businessId: BusinessId): Promise<boolean>;
  /** ACTIVE OWNER memberships of the business. Meaningful for the owner invariant only under the business lock. */
  countActiveOwners(scope: TransactionScope, businessId: BusinessId): Promise<number>;
  /**
   * Persists a transition of `previous` to `next` (same ID and business,
   * version incremented by one). Throws ConcurrentModificationError when the
   * stored version is no longer `previous.version`.
   */
  update(scope: TransactionScope, previous: BusinessMembership, next: BusinessMembership): Promise<void>;
  /** All memberships of the business (ACTIVE and SUSPENDED), ordered by membership ID. */
  listMembers(scope: TransactionScope, businessId: BusinessId, page: PageRequest): Promise<Page<MemberListing>>;
  /** Only ACTIVE memberships in ACTIVE businesses, ordered by membership ID. */
  listAccessibleBusinesses(
    scope: TransactionScope,
    userId: UserId,
    page: PageRequest,
  ): Promise<Page<AccessibleBusiness>>;
}

/**
 * Precondition of MembershipRepository.update, shared by every adapter: the
 * transition keeps the identity (ID, business, user and creation time) and
 * advances the version by exactly one. A violation is a programming error.
 */
export function assertMembershipTransition(previous: BusinessMembership, next: BusinessMembership): void {
  if (
    next.id !== previous.id ||
    next.businessId !== previous.businessId ||
    next.userId !== previous.userId ||
    next.createdAt.getTime() !== previous.createdAt.getTime() ||
    next.version !== previous.version + 1
  ) {
    throw new Error("a membership update must keep its identity and advance the version by one");
  }
}

/** The approved currency reference data (global, read-only; ADR-005 section 5). */
export interface CurrencyReferenceRepository {
  findByCode(scope: TransactionScope, code: CurrencyCode): Promise<CurrencyDefinition | undefined>;
}
