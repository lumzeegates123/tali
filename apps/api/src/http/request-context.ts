import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type {
  AuthenticatedUserContext,
  BusinessContext,
  CorrelationId,
  SourceChannel,
  VerifiedIdentity,
} from "@tali/application";
import type { Request } from "express";

/**
 * What the transport pipeline attaches to a request, in order: the
 * correlation ID (middleware), the verified identity (AuthenticationGuard),
 * then the resolved user or business context (RegisteredUserGuard or
 * BusinessContextGuard). Controllers read these through the decorators below
 * and never build a context themselves.
 */
export interface TaliRequest extends Request {
  correlationId?: CorrelationId;
  identity?: VerifiedIdentity;
  userContext?: AuthenticatedUserContext;
  businessContext?: BusinessContext;
}

/**
 * Set by the server for every HTTP request; never read from the client. The
 * API cannot tell a web from a mobile caller without trusting a client claim,
 * so every request through this API is "api".
 */
export const HTTP_SOURCE_CHANNEL: SourceChannel = "api";

/** A guard or middleware that should have run did not: a wiring bug, never a client error. */
export class RequestPipelineError extends Error {
  constructor(missing: string) {
    super(`request pipeline did not provide ${missing}`);
    this.name = "RequestPipelineError";
  }
}

function request(context: ExecutionContext): TaliRequest {
  return context.switchToHttp().getRequest<TaliRequest>();
}

export function correlationIdOf(req: TaliRequest): CorrelationId {
  if (req.correlationId === undefined) throw new RequestPipelineError("a correlation ID");
  return req.correlationId;
}

export const RequestCorrelationId = createParamDecorator((_: unknown, context: ExecutionContext) =>
  correlationIdOf(request(context)),
);

export const VerifiedRequestIdentity = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const identity = request(context).identity;
  if (identity === undefined) throw new RequestPipelineError("a verified identity");
  return identity;
});

export const UserContext = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const user = request(context).userContext;
  if (user === undefined) throw new RequestPipelineError("a user context");
  return user;
});

export const ResolvedBusinessContext = createParamDecorator((_: unknown, context: ExecutionContext) => {
  const business = request(context).businessContext;
  if (business === undefined) throw new RequestPipelineError("a business context");
  return business;
});
