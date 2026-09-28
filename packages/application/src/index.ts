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
export type { ApplicationErrorCode, ValidationIssue } from "./errors/application-error.js";
export {
  ApplicationError,
  AuthenticationError,
  ConflictError,
  DependencyUnavailableError,
  LocationRequiredError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "./errors/application-error.js";
export * from "./ports/index.js";
export type { SmokeCheck, SmokeCheckRequest, SmokeCheckResult } from "./system/smoke-check.js";
export { createSmokeCheck, SMOKE_CHECK_MESSAGE_TYPE } from "./system/smoke-check.js";
