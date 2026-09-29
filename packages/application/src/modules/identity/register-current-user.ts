import type { User } from "@tali/domain";
import { externalIdentity, isUserActive, parseDisplayName, registerUser } from "@tali/domain";
import type { AuditRecorder } from "../../audit/audit-recorder.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import { UserDisabledError } from "../../errors/application-error.js";
import type { Clock } from "../../ports/clock.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import type { VerifiedIdentity } from "../../ports/identity-provider.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import { identityLinked, userRegistered } from "./audit-actions.js";
import type { UserRepository } from "./ports.js";
import type { RequestMetadata } from "./user-context-resolver.js";
import { identityKeyOf } from "./user-context-resolver.js";

export interface RegisterCurrentUserInput extends RequestMetadata {
  readonly identity: VerifiedIdentity;
  readonly displayName: string;
}

export interface RegisterCurrentUserResult {
  readonly user: User;
  /** False when the identity was already registered: a successful no-op with no audit record. */
  readonly registered: boolean;
}

/**
 * Explicit registration (ADR-005 section 11), naturally idempotent through
 * the unique (provider, providerSubject): a repeat call, or a duplicate that
 * loses the unique race, returns the existing user unchanged. A DISABLED
 * user is never reported as registered successfully.
 */
export interface RegisterCurrentUser {
  execute(input: RegisterCurrentUserInput): Promise<RegisterCurrentUserResult>;
}

export function createRegisterCurrentUser(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly users: UserRepository;
  readonly audit: AuditRecorder;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}): RegisterCurrentUser {
  const existingResult = (user: User): RegisterCurrentUserResult => {
    if (!isUserActive(user)) throw new UserDisabledError();
    return { user, registered: false };
  };

  return {
    async execute(input) {
      const key = identityKeyOf(input.identity);
      const displayName = withDomainRules(() => parseDisplayName(input.displayName), "displayName");

      return dependencies.unitOfWork.run(async (scope) => {
        const existing = await dependencies.users.findByExternalIdentity(scope, key);
        if (existing !== undefined) return existingResult(existing.user);

        const now = dependencies.clock.now();
        const user = registerUser({ id: dependencies.ids.newId("User"), displayName, now });
        const identity = externalIdentity({
          id: dependencies.ids.newId("ExternalIdentity"),
          userId: user.id,
          provider: key.provider,
          providerSubject: key.providerSubject,
          createdAt: now,
        });

        if ((await dependencies.users.insertRegistration(scope, { user, externalIdentity: identity })) !== "inserted") {
          const winner = await dependencies.users.findByExternalIdentity(scope, key);
          if (winner === undefined) throw new Error("identity reported as linked but not found");
          return existingResult(winner.user);
        }

        const common = {
          subjectUserId: user.id,
          actor: { type: "user", userId: user.id },
          sourceChannel: input.sourceChannel,
          correlationId: input.correlationId,
        } as const;
        await dependencies.audit.recordPlatformEvent(scope, userRegistered, {
          ...common,
          entityId: user.id,
          payload: { status: "ACTIVE" },
        });
        await dependencies.audit.recordPlatformEvent(scope, identityLinked, {
          ...common,
          entityId: identity.id,
          payload: { userId: user.id, provider: identity.provider },
        });
        return { user, registered: true };
      });
    },
  };
}
