/*
 * A fake Cognito user-pool endpoint for web tests (Vitest and Playwright). It
 * speaks just enough of the AWS JSON protocol for Amplify's SRP sign-in,
 * sign-up, refresh (GetTokensFromRefreshToken) and sign-out. It verifies
 * nothing: tokens are unsigned synthetic JWTs that only the client decodes.
 * No request ever leaves the test process.
 */

export const FAKE_COGNITO_REGION = "eu-west-1";
export const FAKE_COGNITO_USER_POOL_ID = "eu-west-1_SyntheticPool1";
export const FAKE_COGNITO_CLIENT_ID = "syntheticwebclient0000000001";
export const FAKE_COGNITO_HOST = `cognito-idp.${FAKE_COGNITO_REGION}.amazonaws.com`;
export const FAKE_COGNITO_SUB = "0191a1b2-0000-7000-8000-00000000c0de";
/** Opaque challenge material Cognito would return; it must never reach the UI. */
export const FAKE_CHALLENGE_SESSION = "synthetic-challenge-session-do-not-show";

export interface CognitoCall {
  readonly op: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface FakeCognitoOptions {
  /** Access and ID token lifetime; a value under Amplify's 5 s tolerance makes every read refresh. */
  accessLifetimeSeconds: number;
  /** RespondToAuthChallenge answers with this further challenge instead of tokens. */
  furtherChallenge: string | undefined;
  /** InitiateAuth fails with this Cognito error type. */
  signInError: string | undefined;
  /** GetTokensFromRefreshToken fails with this Cognito error type. */
  refreshError: string | undefined;
  /** Milliseconds GetTokensFromRefreshToken takes; lets concurrent reads overlap. */
  refreshDelayMs: number;
}

function base64Url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export class FakeCognito {
  readonly calls: CognitoCall[] = [];
  /** Hosts other than the synthetic pool's endpoint that something tried to reach. */
  readonly refusedHosts: string[] = [];
  /** Every token value issued, so tests can search storage, cookies, URLs and logs for them. */
  readonly issued = { access: [] as string[], id: [] as string[], refresh: [] as string[] };
  readonly options: FakeCognitoOptions = {
    accessLifetimeSeconds: 900,
    furtherChallenge: undefined,
    signInError: undefined,
    refreshError: undefined,
    refreshDelayMs: 0,
  };
  #sequence = 0;

  ops(): string[] {
    return this.calls.map((call) => call.op);
  }

  /** Answers one Cognito JSON request. `target` is the X-Amz-Target header value. */
  async respond(target: string, rawBody: string): Promise<{ readonly status: number; readonly body: string }> {
    const op = target.split(".").pop() ?? "";
    const body = (rawBody === "" ? {} : JSON.parse(rawBody)) as Record<string, unknown>;
    this.calls.push({ op, body });
    const ok = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });
    const fail = (type: string) => ({
      status: 400,
      body: JSON.stringify({ __type: type, message: `synthetic ${type}` }),
    });
    switch (op) {
      case "SignUp":
        return ok({
          UserConfirmed: false,
          UserSub: FAKE_COGNITO_SUB,
          CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "p***@e***" },
        });
      case "ConfirmSignUp":
        return body["ConfirmationCode"] === "123456" ? ok({}) : fail("CodeMismatchException");
      case "ResendConfirmationCode":
        return ok({ CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email" } });
      case "InitiateAuth":
        if (this.options.signInError !== undefined) return fail(this.options.signInError);
        return ok({
          ChallengeName: "PASSWORD_VERIFIER",
          ChallengeParameters: {
            SRP_B: "a".repeat(512),
            SALT: "abcdef0123456789",
            SECRET_BLOCK: btoa("synthetic-secret-block"),
            USER_ID_FOR_SRP: FAKE_COGNITO_SUB,
            USERNAME: FAKE_COGNITO_SUB,
          },
        });
      case "RespondToAuthChallenge":
        if (this.options.furtherChallenge !== undefined) {
          return ok({
            ChallengeName: this.options.furtherChallenge,
            Session: FAKE_CHALLENGE_SESSION,
            ChallengeParameters: { userAttributes: "{}", requiredAttributes: "[]" },
          });
        }
        return ok({ AuthenticationResult: { ...this.#tokens(), RefreshToken: this.#refreshToken() } });
      case "GetTokensFromRefreshToken":
        if (this.options.refreshDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.options.refreshDelayMs));
        }
        if (this.options.refreshError !== undefined) return fail(this.options.refreshError);
        return ok({ AuthenticationResult: { ...this.#tokens(), RefreshToken: this.#refreshToken() } });
      case "RevokeToken":
      case "GlobalSignOut":
        return ok({});
      default:
        return fail("UnsupportedOperationException");
    }
  }

  /** A fetch that answers only the synthetic pool's endpoint and refuses everything else. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== FAKE_COGNITO_HOST) {
      this.refusedHosts.push(url.host);
      throw new TypeError("unexpected request");
    }
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const answer = await this.respond(headers.get("x-amz-target") ?? "", body);
    return new Response(answer.body, {
      status: answer.status,
      headers: { "content-type": "application/x-amz-json-1.1" },
    });
  };

  #tokens() {
    const now = Math.floor(Date.now() / 1000);
    this.#sequence += 1;
    const claims = {
      sub: FAKE_COGNITO_SUB,
      iss: `https://${FAKE_COGNITO_HOST}/${FAKE_COGNITO_USER_POOL_ID}`,
      iat: now,
      auth_time: now,
      exp: now + this.options.accessLifetimeSeconds,
      jti: `synthetic-jti-${String(this.#sequence)}`,
      origin_jti: "synthetic-origin-jti",
      username: FAKE_COGNITO_SUB,
    };
    const header = base64Url({ alg: "RS256", kid: "synthetic-kid" });
    const access = `${header}.${base64Url({ ...claims, token_use: "access", client_id: FAKE_COGNITO_CLIENT_ID })}.c2lnbmF0dXJl`;
    const id = `${header}.${base64Url({ ...claims, token_use: "id", aud: FAKE_COGNITO_CLIENT_ID, email: "pilot.owner@example.test" })}.c2lnbmF0dXJl`;
    this.issued.access.push(access);
    this.issued.id.push(id);
    return { AccessToken: access, IdToken: id, ExpiresIn: this.options.accessLifetimeSeconds, TokenType: "Bearer" };
  }

  #refreshToken(): string {
    const token = `synthetic-refresh-${String(this.issued.refresh.length)}-${"r".repeat(24)}`;
    this.issued.refresh.push(token);
    return token;
  }
}
