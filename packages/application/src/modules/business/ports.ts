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
  /** All memberships of the business (ACTIVE and SUSPENDED), ordered by membership ID. */
  listMembers(scope: TransactionScope, businessId: BusinessId, page: PageRequest): Promise<Page<MemberListing>>;
  /** Only ACTIVE memberships in ACTIVE businesses, ordered by membership ID. */
  listAccessibleBusinesses(
    scope: TransactionScope,
    userId: UserId,
    page: PageRequest,
  ): Promise<Page<AccessibleBusiness>>;
}

/** The approved currency reference data (global, read-only; ADR-005 section 5). */
export interface CurrencyReferenceRepository {
  findByCode(scope: TransactionScope, code: CurrencyCode): Promise<CurrencyDefinition | undefined>;
}
