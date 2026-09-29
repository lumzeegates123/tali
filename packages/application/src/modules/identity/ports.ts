import type { ExternalIdentity, ExternalIdentityKey, User, UserId } from "@tali/domain";
import type { TransactionScope } from "../../ports/unit-of-work.js";

/** A user together with the external identity that authenticates them. */
export interface UserRegistration {
  readonly user: User;
  readonly externalIdentity: ExternalIdentity;
}

/** Users and their external identities (global, not tenant-owned; ADR-005 sections 3 and 4). */
export interface UserRepository {
  /** Looks up by the identity key (provider, providerSubject); never by email or phone. */
  findByExternalIdentity(scope: TransactionScope, key: ExternalIdentityKey): Promise<UserRegistration | undefined>;
  findById(scope: TransactionScope, userId: UserId): Promise<User | undefined>;
  /**
   * Inserts the user and its external identity together. If the identity key
   * is already linked (a concurrent registration won the unique race),
   * inserts nothing and returns "identity-already-linked".
   */
  insertRegistration(
    scope: TransactionScope,
    registration: UserRegistration,
  ): Promise<"inserted" | "identity-already-linked">;
}
