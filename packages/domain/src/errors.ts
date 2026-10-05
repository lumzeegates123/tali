/**
 * Violations of domain rules outside the kernel. The application layer maps
 * each code to its ApplicationError (ADR-005 section 13.1); domain code never
 * chooses transport statuses.
 */
export type DomainErrorCode =
  /** A value breaks its field contract (length, format, allowed values). */
  | "INVALID_VALUE"
  /** A transition that is not allowed from the current state. */
  | "INVALID_TRANSITION"
  /** The change would leave the business without an ACTIVE OWNER. */
  | "LAST_ACTIVE_OWNER"
  /** Granting or removing OWNER by an actor that is not an ACTIVE OWNER. */
  | "OWNER_REQUIRED"
  /** The caller's expectedVersion is not the record's current version (ADR-008 section 9). */
  | "VERSION_CONFLICT";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  /** The field at fault, for INVALID_VALUE. */
  readonly field: string | undefined;

  constructor(code: DomainErrorCode, message: string, field?: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.field = field;
  }
}
