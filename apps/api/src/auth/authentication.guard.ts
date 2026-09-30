import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { AuthenticationError, type IdentityProvider } from "@tali/application";
import { IDENTITY_PROVIDER, LOGGER } from "../composition/tokens.js";
import type { TaliRequest } from "../http/request-context.js";
import type { Logger } from "../observability/logger.js";

/** Kept for the test-only identity route. */
export type AuthenticatedRequest = TaliRequest;

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/;

/** One message for every authentication failure, so responses never reveal why a token was refused. */
export const AUTHENTICATION_REQUIRED = "A valid bearer access token is required";

export type TokenRejectionReason = "missing_token" | "malformed_authorization" | "verification_failed";

/**
 * Authentication boundary: verifies the bearer token through the
 * IdentityProvider port and attaches the verified identity. It authenticates
 * only; users, memberships and permissions are resolved from Tali's database
 * by the next guard, never from token claims.
 *
 * Every missing, malformed, badly signed, expired or unverifiable token is
 * UNAUTHENTICATED with the same message. The log line carries a bounded
 * reason code only: never the header, the token or any claim.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  readonly #identityProvider: IdentityProvider;
  readonly #logger: Logger;

  constructor(@Inject(IDENTITY_PROVIDER) identityProvider: IdentityProvider, @Inject(LOGGER) logger: Logger) {
    this.#identityProvider = identityProvider;
    this.#logger = logger;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TaliRequest>();
    const header = request.headers.authorization;
    if (header === undefined || header === "") this.#reject("missing_token");
    const match = BEARER.exec(header);
    if (match?.[1] === undefined) this.#reject("malformed_authorization");
    try {
      request.identity = await this.#identityProvider.verifyAccessToken(match[1]);
    } catch (error) {
      // Adapters report every token they cannot verify as AuthenticationError. Anything else is
      // not a verdict on the token (an unavailable provider, a defect) and keeps its own mapping.
      if (error instanceof AuthenticationError) this.#reject("verification_failed");
      throw error;
    }
    return true;
  }

  #reject(reason: TokenRejectionReason): never {
    this.#logger.info("auth.token_rejected", { reason });
    throw new AuthenticationError(AUTHENTICATION_REQUIRED);
  }
}
