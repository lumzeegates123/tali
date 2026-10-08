/**
 * Foundational application errors. Transports map `code` to a response (for
 * example the HTTP error envelope); messages must not leak other tenants' data.
 * Build 1 codes follow ADR-005 section 13.1 (and ADR-004 section 11);
 * VERSION_CONFLICT and INSUFFICIENT_STOCK are added by ADR-008 sections 10 and 20.
 */
export type ApplicationErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "LOCATION_REQUIRED"
  | "DEPENDENCY_UNAVAILABLE"
  | "USER_NOT_REGISTERED"
  | "USER_DISABLED"
  | "DEVICE_NOT_TRUSTED"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "CONCURRENT_MODIFICATION"
  | "VERSION_CONFLICT"
  | "INSUFFICIENT_STOCK";

/** Whether a client may retry the same request unchanged (ADR-004 section 11; ADR-005 section 13.1). */
const RETRYABLE: Readonly<Record<ApplicationErrorCode, boolean>> = {
  VALIDATION_FAILED: false,
  NOT_FOUND: false,
  UNAUTHENTICATED: false,
  PERMISSION_DENIED: false,
  CONFLICT: false,
  LOCATION_REQUIRED: false,
  DEPENDENCY_UNAVAILABLE: true,
  USER_NOT_REGISTERED: false,
  USER_DISABLED: false,
  DEVICE_NOT_TRUSTED: false,
  IDEMPOTENCY_KEY_REQUIRED: false,
  IDEMPOTENCY_KEY_REUSED: false,
  IDEMPOTENCY_IN_PROGRESS: true,
  CONCURRENT_MODIFICATION: true,
  VERSION_CONFLICT: false,
  INSUFFICIENT_STOCK: false,
};

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

  get retryable(): boolean {
    return RETRYABLE[this.code];
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

/** A verified identity with no linked Tali user (ADR-005 section 11). */
export class UserNotRegisteredError extends ApplicationError {
  constructor(message = "No Tali user is registered for this identity") {
    super("USER_NOT_REGISTERED", message);
  }
}

/** The authenticated user is DISABLED (ADR-005 section 4). */
export class UserDisabledError extends ApplicationError {
  constructor(message = "This user is disabled") {
    super("USER_DISABLED", message);
  }
}

/**
 * Device headers were present but did not verify (ADR-005 sections 13.1 and
 * 15.3). One message for every cause: missing half, malformed, unknown,
 * foreign, revoked or mismatched. The client must register the device again.
 */
export class DeviceNotTrustedError extends ApplicationError {
  constructor(message = "This device is not trusted for this business") {
    super("DEVICE_NOT_TRUSTED", message);
  }
}

/** A keyed operation was called without an idempotency key (ADR-004 section 4.1). */
export class IdempotencyKeyRequiredError extends ApplicationError {
  constructor(message = "An idempotency key is required for this operation") {
    super("IDEMPOTENCY_KEY_REQUIRED", message);
  }
}

/** The key was reused with a materially different command; the stored result is never revealed (ADR-004 section 4.3). */
export class IdempotencyKeyReusedError extends ApplicationError {
  constructor(message = "This idempotency key was already used for a different request") {
    super("IDEMPOTENCY_KEY_REUSED", message);
  }
}

/**
 * Another request with the same idempotency key was still in progress when
 * the lock wait timed out. Retryable with the same key (ADR-004 sections 4.3 and 11).
 */
export class IdempotencyInProgressError extends ApplicationError {
  constructor(message = "A request with this idempotency key is still in progress", options?: { cause?: unknown }) {
    super("IDEMPOTENCY_IN_PROGRESS", message, options);
  }
}

/**
 * A concurrent change prevented the transaction from completing: serialization
 * retries were exhausted, a lock wait timed out, or an optimistic version
 * check failed. Nothing was committed; retryable (ADR-004 section 11).
 */
export class ConcurrentModificationError extends ApplicationError {
  constructor(message = "The resource was modified concurrently; retry the request", options?: { cause?: unknown }) {
    super("CONCURRENT_MODIFICATION", message, options);
  }
}

/**
 * The caller's expectedVersion is not the record's current version: someone
 * else changed it since the caller read it (ADR-008 sections 9 and 20). Not
 * retryable unchanged; the client re-reads and decides again.
 */
export class VersionConflictError extends ApplicationError {
  constructor(message = "The record has changed since it was read; reload and try again") {
    super("VERSION_CONFLICT", message);
  }
}

/**
 * A manual stock decrease (adjustment, write-off or reversal) would take
 * on-hand stock below zero (ADR-008 section 10). Nothing was written. Not
 * retryable unchanged: the stock must change first.
 */
export class InsufficientStockError extends ApplicationError {
  constructor(message = "There is not enough stock on hand for this change") {
    super("INSUFFICIENT_STOCK", message);
  }
}
