import type { ExternalIdentityKey, User } from "@tali/domain";
import { DomainError, isUserActive, parseProviderSubject } from "@tali/domain";
import type { AuthenticatedUserContext } from "../../context/authenticated-user-context.js";
import type { CorrelationId, SourceChannel } from "../../context/business-context.js";
import { AuthenticationError, UserDisabledError, UserNotRegisteredError } from "../../errors/application-error.js";
import type { VerifiedIdentity } from "../../ports/identity-provider.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { UserRepository } from "./ports.js";

/** The persisted identity key of a verified identity. An unusable subject fails authentication. */
export function identityKeyOf(identity: VerifiedIdentity): ExternalIdentityKey {
  try {
    return { provider: identity.provider, providerSubject: parseProviderSubject(identity.subject) };
  } catch (error) {
    if (error instanceof DomainError) throw new AuthenticationError("Unsupported identity subject");
    throw error;
  }
}

/** A registered user must be ACTIVE on every request (ADR-005 section 4). */
export function requireActiveUser(user: User | undefined): User {
  if (user === undefined) throw new UserNotRegisteredError();
  if (!isUserActive(user)) throw new UserDisabledError();
  return user;
}

export interface RequestMetadata {
  readonly correlationId: CorrelationId;
  readonly sourceChannel: SourceChannel;
}

export interface UserContextResolver {
  /**
   * Verified identity to Tali user (ADR-005 section 12, step 2): no linked
   * user gives USER_NOT_REGISTERED, a DISABLED user gives USER_DISABLED.
   */
  resolve(identity: VerifiedIdentity, request: RequestMetadata): Promise<AuthenticatedUserContext>;
}

export function createUserContextResolver(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly users: UserRepository;
}): UserContextResolver {
  return {
    async resolve(identity, request) {
      const key = identityKeyOf(identity);
      const registration = await dependencies.unitOfWork.run((scope) =>
        dependencies.users.findByExternalIdentity(scope, key),
      );
      const user = requireActiveUser(registration?.user);
      return { userId: user.id, correlationId: request.correlationId, sourceChannel: request.sourceChannel };
    },
  };
}
