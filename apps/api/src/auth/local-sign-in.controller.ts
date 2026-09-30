import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post, Query, Req, Res } from "@nestjs/common";
import {
  EmptyQuerySchema,
  LocalSignInRequestSchema,
  type LocalSignInResponse,
  LocalSignInResponseSchema,
} from "@tali/shared";
import type { Request, Response } from "express";
import type { LocalSignIn } from "../composition/local-sign-in.js";
import { LOCAL_SIGN_IN } from "../composition/tokens.js";
import { parseRequest } from "../http/validation.js";

/**
 * LOCAL DEVELOPMENT ONLY (ADR-005 section 16). AppModule mounts this
 * controller only when TALI_ENV=local and the local identity provider is
 * composed; in every other environment the route does not exist (404).
 *
 * It issues a 1-hour access token for a local subject and nothing else: it
 * creates no user, business or membership, so the caller still registers and
 * is authorized through the normal path. The request is not a business
 * mutation and writes no audit record. The token is never logged.
 */
@Controller("__local")
export class LocalSignInController {
  readonly #localSignIn: LocalSignIn;

  constructor(@Inject(LOCAL_SIGN_IN) localSignIn: LocalSignIn) {
    this.#localSignIn = localSignIn;
  }

  @Post("sign-in")
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Req() request: Request,
    @Body() body: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocalSignInResponse> {
    if (!this.#localSignIn.limiter.tryConsume(request.ip ?? "unknown")) {
      throw new HttpException("Too many sign-in attempts; try again later", HttpStatus.TOO_MANY_REQUESTS);
    }
    parseRequest(EmptyQuerySchema, query, "query");
    const { subject } = parseRequest(LocalSignInRequestSchema, body, "body");
    const { accessToken, expiresAt } = await this.#localSignIn.issuer.issueAccessToken(subject);
    response.setHeader("Cache-Control", "no-store");
    return LocalSignInResponseSchema.parse({ accessToken, tokenType: "Bearer", expiresAt: expiresAt.toISOString() });
  }
}
