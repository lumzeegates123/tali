/**
 * Foundational application errors. Transports map `code` to a response (for
 * example the HTTP error envelope); messages must not leak other tenants' data.
 */
export type ApplicationErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "LOCATION_REQUIRED"
  | "DEPENDENCY_UNAVAILABLE";

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends ApplicationError {
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, issues: readonly ValidationIssue[] = []) {
    super("VALIDATION_FAILED", message);
    this.issues = issues;
  }
}

/** Also used for records owned by another business, so their existence is never revealed. */
export class NotFoundError extends ApplicationError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message);
  }
}

export class AuthenticationError extends ApplicationError {
  constructor(message = "Authentication required", options?: { cause?: unknown }) {
    super("UNAUTHENTICATED", message, options);
  }
}

export class PermissionDeniedError extends ApplicationError {
  constructor(message = "Permission denied") {
    super("PERMISSION_DENIED", message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}

export class LocationRequiredError extends ApplicationError {
  constructor(message = "A resolved location is required for this operation") {
    super("LOCATION_REQUIRED", message);
  }
}

export class DependencyUnavailableError extends ApplicationError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("DEPENDENCY_UNAVAILABLE", message, options);
  }
}
