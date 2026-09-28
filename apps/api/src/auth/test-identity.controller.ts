import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { AuthenticationGuard, type AuthenticatedRequest } from "./authentication.guard.js";

/**
 * TEST/LOCAL ONLY. Proves the authentication guard boundary end to end.
 * AppModule registers this controller only when config.api.testRoutesEnabled,
 * which is derived from TALI_ENV (local or test) with no override, so it
 * cannot be enabled in a deployed environment.
 */
@Controller("__test")
@UseGuards(AuthenticationGuard)
export class TestIdentityController {
  @Get("identity")
  identity(@Req() request: AuthenticatedRequest): { provider: string; subject: string } {
    const identity = request.identity;
    if (identity === undefined) throw new Error("AuthenticationGuard did not attach an identity");
    return { provider: identity.provider, subject: identity.subject };
  }
}
