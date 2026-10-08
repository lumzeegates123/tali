/**
 * @tali/application: framework-free use cases, authorization and ports.
 * Server-only; clients never import this package.
 */
export type { Permission, PermissionCatalogue, PermissionSet } from "./authorization/permissions.js";
export {
  definePermissionCatalogue,
  hasPermission,
  isPermissionName,
  permissionSet,
  requirePermission,
} from "./authorization/permissions.js";
export type {
  Actor,
  BusinessContext,
  BusinessId,
  CorrelationId,
  DeviceId,
  IntegrationActor,
  LocationBoundContext,
  LocationId,
  MembershipId,
  SourceChannel,
  SystemActor,
  UserActor,
  UserId,
} from "./context/business-context.js";
export {
  isLocationBound,
  parseCorrelationId,
  requireContextPermission,
  requireLocationBound,
} from "./context/business-context.js";
export type { AuthenticatedUserContext } from "./context/authenticated-user-context.js";
export type { ApplicationErrorCode, ValidationIssue } from "./errors/application-error.js";
export {
  ApplicationError,
  AuthenticationError,
  ConcurrentModificationError,
  ConflictError,
  DependencyUnavailableError,
  DeviceNotTrustedError,
  IdempotencyInProgressError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReusedError,
  InsufficientStockError,
  LocationRequiredError,
  NotFoundError,
  PermissionDeniedError,
  UserDisabledError,
  UserNotRegisteredError,
  ValidationError,
  VersionConflictError,
} from "./errors/application-error.js";
export { toApplicationError, withDomainRules } from "./errors/domain-errors.js";
export type { AuditActionDefinition, AuditEntityType, AuditRegistry, AuditStream } from "./audit/audit-action.js";
export { defineAuditAction, defineAuditRegistry } from "./audit/audit-action.js";
export type { AuditField, AuditFields, AuditPayload, AuditPayloadOf } from "./audit/audit-payload.js";
export {
  AUDIT_PAYLOAD_MAX_BYTES,
  AuditPayloadError,
  auditField,
  validateAuditFields,
  validateAuditPayload,
} from "./audit/audit-payload.js";
export type { BusinessAuditEvent, PlatformAuditEvent } from "./audit/audit-recorder.js";
export type { BusinessAuditEnvelope } from "./audit/business-audit-envelope.js";
export { businessAuditEnvelope } from "./audit/business-audit-envelope.js";
export { AUDIT_REASON_MAX_LENGTH, AuditRecorder } from "./audit/audit-recorder.js";
export type {
  AuditRecordId,
  AuditWriter,
  BusinessAuditRecord,
  PlatformAuditRecord,
  PlatformUserActor,
} from "./audit/audit-writer.js";
export { taliAuditRegistry } from "./audit/tali-audit-registry.js";
export type {
  CanonicalCommand,
  CanonicalObject,
  CanonicalValue,
  CommandObject,
  CommandValue,
} from "./idempotency/canonical-command.js";
export {
  CANONICAL_FINGERPRINT_VERSION,
  CanonicalEncodingError,
  canonicalCommandEncoding,
  canonicalCommandsEqual,
  canonicalEnum,
  canonicalSet,
  canonicalValuesEqual,
} from "./idempotency/canonical-command.js";
export type { CommandFingerprint, FingerprintHasher } from "./idempotency/fingerprint-hasher.js";
export { sameFingerprint } from "./idempotency/fingerprint-hasher.js";
export type { IdempotencyKey } from "./idempotency/idempotency-key.js";
export { requireIdempotencyKey } from "./idempotency/idempotency-key.js";
export type { IdempotentResultCodec, KeyedOutcome, PlannedMutation } from "./idempotency/keyed-idempotency.js";
export { KeyedIdempotency, MIN_IDEMPOTENCY_RETENTION_DAYS } from "./idempotency/keyed-idempotency.js";
export type {
  IdempotencyRecordId,
  UserIdempotencyRecord,
  UserIdempotencyStore,
} from "./idempotency/user-idempotency-store.js";
export type {
  BusinessIdempotencyRecord,
  BusinessIdempotencyStore,
  IdempotencyActor,
} from "./idempotency/business-idempotency-store.js";
export { idempotencyActorOf } from "./idempotency/business-idempotency-store.js";
export * from "./modules/business/index.js";
export * from "./modules/catalog/index.js";
export * from "./modules/device/index.js";
export * from "./modules/identity/index.js";
export * from "./modules/inventory/index.js";
export * from "./modules/location/index.js";
export * from "./ports/index.js";
export type { Page, PageRequest } from "./queries/pagination.js";
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageRequest } from "./queries/pagination.js";
export type { SmokeCheck, SmokeCheckRequest, SmokeCheckResult } from "./system/smoke-check.js";
export { createSmokeCheck, SMOKE_CHECK_MESSAGE_TYPE } from "./system/smoke-check.js";
