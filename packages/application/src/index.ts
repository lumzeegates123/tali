/**
 * @tali/application: framework-free use cases, authorization and ports.
 * Server-only; clients never import this package.
 */
export type { Permission, PermissionCatalogue, PermissionSet } from "./authorization/permissions";
export {
  definePermissionCatalogue,
  hasPermission,
  isPermissionName,
  permissionSet,
  requirePermission,
} from "./authorization/permissions";
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
} from "./context/business-context";
export {
  isLocationBound,
  parseCorrelationId,
  requireContextPermission,
  requireLocationBound,
} from "./context/business-context";
export type { ApplicationErrorCode, ValidationIssue } from "./errors/application-error";
export {
  ApplicationError,
  AuthenticationError,
  ConflictError,
  DependencyUnavailableError,
  LocationRequiredError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "./errors/application-error";
export * from "./ports/index";
