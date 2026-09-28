import type { CorrelationId } from "../context/business-context.js";
import { ValidationError } from "../errors/application-error.js";
import type { Clock } from "../ports/clock.js";

/** Queue message type handled by the worker's smoke handler. */
export const SMOKE_CHECK_MESSAGE_TYPE = "system.smoke-check";

export interface SmokeCheckRequest {
  readonly correlationId: CorrelationId;
  /** Free text echoed back, at most 200 characters. */
  readonly note: string;
}

export interface SmokeCheckResult {
  readonly correlationId: CorrelationId;
  readonly note: string;
  readonly checkedAt: Date;
}

/**
 * A harmless system self-check. It proves that a transport (the worker's
 * message handler) reaches the application layer through a plain contract.
 * It has no side effects, touches no tenant data and persists nothing.
 */
export interface SmokeCheck {
  execute(request: SmokeCheckRequest): Promise<SmokeCheckResult>;
}

export function createSmokeCheck(dependencies: { readonly clock: Clock }): SmokeCheck {
  return {
    async execute(request) {
      if (request.note.length > 200) {
        throw new ValidationError("note must be at most 200 characters", [{ path: ["note"], message: "too long" }]);
      }
      return { correlationId: request.correlationId, note: request.note, checkedAt: dependencies.clock.now() };
    },
  };
}
