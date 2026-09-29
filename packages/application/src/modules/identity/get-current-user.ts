import type { User } from "@tali/domain";
import type { AuthenticatedUserContext } from "../../context/authenticated-user-context.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { UserRepository } from "./ports.js";
import { requireActiveUser } from "./user-context-resolver.js";

/** The caller's own profile. Re-reads the user, so a user disabled since resolution is rejected. */
export interface GetCurrentUser {
  execute(context: AuthenticatedUserContext): Promise<User>;
}

export function createGetCurrentUser(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly users: UserRepository;
}): GetCurrentUser {
  return {
    async execute(context) {
      const user = await dependencies.unitOfWork.run((scope) => dependencies.users.findById(scope, context.userId));
      return requireActiveUser(user);
    },
  };
}
