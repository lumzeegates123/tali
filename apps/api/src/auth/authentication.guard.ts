import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { AuthenticationError, type IdentityProvider, type VerifiedIdentity } from "@tali/application";
import type { Request } from "express";
import { IDENTITY_PROVIDER } from "../composition/tokens.js";

export interface AuthenticatedRequest extends Request {
  identity?: VerifiedIdentity;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,4096})$/;

/**
 * Authentication boundary: verifies the bearer token through the
 * IdentityProvider port and attaches the verified identity. It authenticates
 * only; business membership and permissions are resolved from Tali's database
 * in a later wave, never from token claims.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  readonly #identityProvider: IdentityProvider;

  constructor(@Inject(IDENTITY_PROVIDER) identityProvider: IdentityProvider) {
    this.#identityProvider = identityProvider;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = BEARER.exec(request.header("authorization") ?? "");
    if (match?.[1] === undefined) {
      throw new AuthenticationError("A bearer access token is required");
    }
    request.identity = await this.#identityProvider.verifyAccessToken(match[1]);
    return true;
  }
}
