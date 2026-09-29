import { DomainError, KernelError } from "@tali/domain";
import type { ApplicationError } from "./application-error.js";
import { ConflictError, PermissionDeniedError, ValidationError } from "./application-error.js";

/** Maps a domain rule violation to its ApplicationError (ADR-005 section 13.1). */
export function toApplicationError(error: DomainError | KernelError, field?: string): ApplicationError {
  if (error instanceof KernelError) {
    return new ValidationError(error.message, field === undefined ? [] : [{ path: [field], message: error.message }]);
  }
  switch (error.code) {
    case "INVALID_VALUE": {
      const path = field ?? error.field;
      return new ValidationError(error.message, path === undefined ? [] : [{ path: [path], message: error.message }]);
    }
    case "INVALID_TRANSITION":
    case "LAST_ACTIVE_OWNER":
      return new ConflictError(error.message);
    case "OWNER_REQUIRED":
      return new PermissionDeniedError(error.message);
  }
}

/** Runs a domain parse or rule, rethrowing domain and kernel errors as application errors. */
export function withDomainRules<T>(action: () => T, field?: string): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DomainError || error instanceof KernelError) {
      throw toApplicationError(error, field);
    }
    throw error;
  }
}
