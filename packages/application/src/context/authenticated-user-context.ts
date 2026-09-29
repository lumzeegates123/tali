import type { UserId } from "@tali/domain";
import type { CorrelationId, SourceChannel } from "./business-context.js";

/**
 * Context for use cases that run before or outside a business (ADR-005
 * section 12): a registered, ACTIVE user resolved server-side from a verified
 * identity. It carries no business, role or permission.
 */
export interface AuthenticatedUserContext {
  readonly userId: UserId;
  readonly correlationId: CorrelationId;
  readonly sourceChannel: SourceChannel;
}
