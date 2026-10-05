import type { PublicCognitoConfig } from "@tali/config/public";
import { Amplify } from "aws-amplify";
import { confirmSignUp, fetchAuthSession, resendSignUpCode, signIn, signOut, signUp } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import type { AccessToken } from "../../api-client/tali-api-client";
import type { AccessTokenResult, AuthSession } from "../auth-session";
import type {
  CognitoAuth,
  CognitoConfirmResult,
  CognitoFailure,
  CognitoResendResult,
  CognitoSignInResult,
  CognitoSignUpResult,
} from "../cognito-types";
import { MemoryKeyValueStorage } from "./memory-key-value-storage";

/*
 * The only module that uses Amplify (aws-amplify 6.22.1, public modular entry
 * points only; Build 1 Slice 6 dependency audit). Verified behaviour:
 * - sign-in is USER_SRP_AUTH; the password never leaves this process in clear;
 * - refresh is GetTokensFromRefreshToken with rotation (never
 *   REFRESH_TOKEN_AUTH), and concurrent refreshes are shared;
 * - sign-out sends RevokeToken; "everywhere" sends GlobalSignOut;
 * - tokens are held by MemoryKeyValueStorage only.
 * Amplify keeps its own transient SRP/challenge workflow state in browser
 * session storage while a sign-in is in progress; this code never reads,
 * parses or removes it (docs/audits/build-1-slice-6.md).
 */

const FAILURES: Readonly<Record<string, CognitoFailure>> = {
  NotAuthorizedException: "invalidCredentials",
  UserNotFoundException: "invalidCredentials",
  EmptySignInUsername: "invalidCredentials",
  EmptySignInPassword: "invalidCredentials",
  UsernameExistsException: "accountExists",
  AliasExistsException: "accountExists",
  InvalidPasswordException: "passwordRejected",
  EmptySignUpPassword: "passwordRejected",
  EmptySignUpUsername: "invalidEmail",
  CodeMismatchException: "invalidCode",
  EmptyConfirmSignUpCode: "invalidCode",
  ExpiredCodeException: "expiredCode",
  LimitExceededException: "tooManyAttempts",
  TooManyRequestsException: "tooManyAttempts",
  TooManyFailedAttemptsException: "tooManyAttempts",
  CodeDeliveryFailureException: "unavailable",
  NetworkError: "unavailable",
};

/** Maps a thrown error to a bounded reason by its name only; provider messages are never surfaced. */
function failureOf(error: unknown, overrides: Readonly<Record<string, CognitoFailure>> = {}): CognitoFailure {
  const name = error instanceof Error ? error.name : "";
  return overrides[name] ?? FAILURES[name] ?? "unknown";
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && error.name === "NetworkError";
}

let configured: AmplifyCognitoAuth | undefined;

export class AmplifyCognitoAuth implements CognitoAuth {
  /** Identifies the newest session; an older session's end() never signs out a newer one. */
  #generation = 0;
  #ending: Promise<void> = Promise.resolve();

  private constructor() {}

  /**
   * Configures Amplify once for this page. The in-memory token store must be
   * installed after `Amplify.configure`, which otherwise selects persistent
   * browser storage.
   */
  static configure(config: PublicCognitoConfig): AmplifyCognitoAuth {
    if (configured !== undefined) return configured;
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.clientId,
          loginWith: { email: true },
          signUpVerificationMethod: "code",
        },
      },
    });
    cognitoUserPoolsTokenProvider.setKeyValueStorage(new MemoryKeyValueStorage());
    configured = new AmplifyCognitoAuth();
    return configured;
  }

  async signUp(email: string, password: string): Promise<CognitoSignUpResult> {
    try {
      const result = await signUp({ username: email, password, options: { userAttributes: { email } } });
      return result.nextStep.signUpStep === "CONFIRM_SIGN_UP"
        ? { status: "confirmationRequired" }
        : { status: "complete" };
    } catch (error) {
      return { status: "failed", reason: failureOf(error, { InvalidParameterException: "invalidEmail" }) };
    }
  }

  async confirmSignUp(email: string, code: string): Promise<CognitoConfirmResult> {
    try {
      await confirmSignUp({ username: email, confirmationCode: code });
      return { status: "confirmed" };
    } catch (error) {
      return { status: "failed", reason: failureOf(error, { NotAuthorizedException: "unknown" }) };
    }
  }

  async resendSignUpCode(email: string): Promise<CognitoResendResult> {
    try {
      await resendSignUpCode({ username: email });
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", reason: failureOf(error, { NotAuthorizedException: "unknown" }) };
    }
  }

  async signIn(email: string, password: string): Promise<CognitoSignInResult> {
    await this.#ending;
    let result;
    try {
      result = await signIn({ username: email, password });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "UserAlreadyAuthenticatedException") {
        return { status: "failed", reason: failureOf(error) };
      }
      // A previous session's tokens are still held: clear them, then sign in once more.
      await signOut();
      try {
        result = await signIn({ username: email, password });
      } catch (retryError) {
        return { status: "failed", reason: failureOf(retryError) };
      }
    }
    const step = result.nextStep.signInStep;
    if (step === "DONE") {
      this.#generation += 1;
      return { status: "signedIn", session: this.#session(this.#generation) };
    }
    if (step === "CONFIRM_SIGN_UP") return { status: "confirmationRequired" };
    // MFA, new-password, password-reset and other steps are not implemented by this client.
    return { status: "unsupportedStep" };
  }

  #session(generation: number): AuthSession {
    let ended = false;
    let inFlight: Promise<AccessTokenResult> | undefined;
    const current = () => !ended && generation === this.#generation;
    const read = async (): Promise<AccessTokenResult> => {
      try {
        // Amplify refreshes an expired access token here (GetTokensFromRefreshToken) and stores the rotated refresh token.
        const { tokens } = await fetchAuthSession();
        if (!current()) return { ok: false, reason: "ended" };
        const accessToken = tokens?.accessToken.toString();
        return accessToken === undefined || accessToken === ""
          ? { ok: false, reason: "ended" }
          : { ok: true, token: accessToken as AccessToken };
      } catch (error) {
        return { ok: false, reason: isNetworkError(error) ? "unavailable" : "ended" };
      }
    };
    return {
      accessToken: () => {
        if (!current()) return Promise.resolve({ ok: false, reason: "ended" });
        inFlight ??= read().finally(() => {
          inFlight = undefined;
        });
        return inFlight;
      },
      end: ({ everywhere }) => {
        if (!current()) return this.#ending;
        ended = true;
        // signOut clears the in-memory tokens even when RevokeToken or GlobalSignOut cannot reach Cognito.
        this.#ending = signOut({ global: everywhere }).catch(() => undefined);
        return this.#ending;
      },
    };
  }
}
