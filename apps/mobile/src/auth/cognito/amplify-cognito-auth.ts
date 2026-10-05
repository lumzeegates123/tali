import type { PublicCognitoConfig } from "@tali/config/public";
import { Amplify, createAmplifyContext, type AmplifyContext } from "aws-amplify";
import { createUserPoolsTokenProvider } from "aws-amplify/adapter-core";
import { confirmSignUp, fetchAuthSession, resendSignUpCode, signIn, signOut, signUp } from "aws-amplify/auth";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import type { AccessToken } from "../../api/tali-api-client";
import type { AccessTokenResult, AuthSession } from "../auth-session";
import type {
  CognitoAuth,
  CognitoConfirmResult,
  CognitoFailure,
  CognitoResendResult,
  CognitoRestoreResult,
  CognitoSignInResult,
  CognitoSignUpResult,
} from "../cognito-types";
import {
  createSecureCognitoStorage,
  inertCognitoStorage,
  type CognitoStorageLease,
  type SecureCognitoStorage,
} from "./secure-cognito-storage";

/*
 * The only mobile module that uses Amplify (aws-amplify 6.22.1, public
 * modular entry points only; ADR-007, docs/audits/build-1-slice-6.md).
 * - Initialization is the security gate of ADR-007 section 6.3: a Tali
 *   adapter is installed on the process-wide token provider before
 *   `Amplify.configure`, and the same provider is passed to it, so Amplify
 *   never selects its default persistent token store at any point. That
 *   adapter keeps nothing: no session runs through the process-wide context.
 * - Every session (a restoration, a sign-in, the end of a leftover session)
 *   runs in its own Amplify context whose token provider was created over that
 *   session's own storage lease. Starting the next session revokes the lease,
 *   so a late refresh, revocation or sign-out of an ended session cannot read
 *   or change the next session's stored tokens.
 * - Sign-in is USER_SRP_AUTH; the password never leaves this process in clear.
 * - Refresh is GetTokensFromRefreshToken with rotation (never
 *   REFRESH_TOKEN_AUTH); concurrent refreshes are shared.
 * - Sign-out sends RevokeToken; "everywhere" sends GlobalSignOut. The Tali
 *   namespace is cleared whatever Cognito answers, within a bounded time.
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

/** Upper bound on waiting for RevokeToken or GlobalSignOut before the local sign-out completes anyway. */
export const SIGN_OUT_TIMEOUT_MS = 10_000;

/** Maps a thrown error to a bounded reason by its name only; provider messages are never surfaced. */
function failureOf(error: unknown, overrides: Readonly<Record<string, CognitoFailure>> = {}): CognitoFailure {
  const name = error instanceof Error ? error.name : "";
  return overrides[name] ?? FAILURES[name] ?? "unknown";
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && error.name === "NetworkError";
}

export interface AmplifyCognitoAuthOptions {
  readonly storage?: SecureCognitoStorage;
  readonly signOutTimeoutMs?: number;
}

const ignore = () => undefined;

type AuthConfig = Parameters<typeof createUserPoolsTokenProvider>[0];

/** One session's private Amplify state. Only the current owner may change the Cognito namespace. */
interface Owner {
  readonly lease: CognitoStorageLease;
  readonly context: AmplifyContext;
  /** The Amplify call running for this session, which its end waits for (bounded). */
  busy?: Promise<unknown>;
}

let configured: AmplifyCognitoAuth | undefined;

export class AmplifyCognitoAuth implements CognitoAuth {
  readonly #authConfig: AuthConfig;
  readonly #storage: SecureCognitoStorage;
  readonly #signOutTimeoutMs: number;
  #owner: Owner | undefined;
  #ending: Promise<void> = Promise.resolve();

  private constructor(authConfig: AuthConfig, storage: SecureCognitoStorage, signOutTimeoutMs: number) {
    this.#authConfig = authConfig;
    this.#storage = storage;
    this.#signOutTimeoutMs = signOutTimeoutMs;
  }

  /**
   * Configures Amplify once for this JavaScript runtime and returns the only
   * object through which Cognito operations run.
   */
  static configure(config: PublicCognitoConfig, options: AmplifyCognitoAuthOptions = {}): AmplifyCognitoAuth {
    if (configured !== undefined) return configured;
    const storage = options.storage ?? createSecureCognitoStorage();
    const authConfig = {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.clientId,
        loginWith: { email: true },
        signUpVerificationMethod: "code" as const,
      },
    };
    cognitoUserPoolsTokenProvider.setAuthConfig(authConfig);
    cognitoUserPoolsTokenProvider.setKeyValueStorage(inertCognitoStorage());
    Amplify.configure({ Auth: authConfig }, { Auth: { tokenProvider: cognitoUserPoolsTokenProvider } });
    configured = new AmplifyCognitoAuth(authConfig, storage, options.signOutTimeoutMs ?? SIGN_OUT_TIMEOUT_MS);
    return configured;
  }

  async restore(): Promise<CognitoRestoreResult> {
    await this.#ending;
    const owner = this.#open();
    try {
      // Reads the persisted session through the Tali adapter, refreshing it if the access token expired.
      const { tokens } = await this.#track(owner, fetchAuthSession(owner.context));
      if (!this.#owns(owner)) return { status: "none" };
      const accessToken = tokens?.accessToken.toString();
      if (accessToken === undefined || accessToken === "") {
        await this.#release(owner);
        return { status: "none" };
      }
      return { status: "signedIn", session: this.#session(owner) };
    } catch (error) {
      if (!this.#owns(owner)) return { status: "none" };
      if (isNetworkError(error)) return { status: "unavailable" };
      await this.#release(owner);
      return { status: "none" };
    }
  }

  async forgetStoredSession(): Promise<void> {
    await this.#ending;
    return this.#end(this.#owner ?? this.#open(), false);
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
    // Whatever an earlier session left on this device (another staff member's included) goes first.
    try {
      if (this.#owner !== undefined || !(await this.#storage.isEmpty())) {
        await this.#end(this.#owner ?? this.#open(), false);
        // ADR-007 section 7.3: no sign-in until the previous session is cleared.
        if (!(await this.#storage.isEmpty())) return { status: "failed", reason: "unavailable" };
      }
    } catch {
      return { status: "failed", reason: "unavailable" };
    }
    const owner = this.#open();
    let result;
    try {
      result = await this.#track(owner, signIn(owner.context, { username: email, password }));
    } catch (error) {
      if (this.#owns(owner)) await this.#release(owner);
      return { status: "failed", reason: failureOf(error) };
    }
    if (!this.#owns(owner)) return { status: "failed", reason: "unavailable" };
    const step = result.nextStep.signInStep;
    if (step === "DONE") return { status: "signedIn", session: this.#session(owner) };
    // MFA, new-password, password-reset and other steps are not implemented: nothing of them is kept.
    await this.#release(owner);
    if (step === "CONFIRM_SIGN_UP") return { status: "confirmationRequired" };
    return { status: "unsupportedStep" };
  }

  /** Starts a session's private Amplify state; every earlier session loses its access to the namespace. */
  #open(): Owner {
    const lease = this.#storage.lease();
    const tokenProvider = createUserPoolsTokenProvider(this.#authConfig, lease);
    const owner: Owner = {
      lease,
      context: createAmplifyContext({ Auth: this.#authConfig }, { Auth: { tokenProvider } }),
    };
    this.#owner = owner;
    return owner;
  }

  #owns(owner: Owner): boolean {
    return this.#owner === owner;
  }

  #track<T>(owner: Owner, operation: Promise<T>): Promise<T> {
    owner.busy = operation;
    return operation;
  }

  /** Detaches the session from the namespace and clears what is stored, without contacting Cognito. */
  #release(owner: Owner): Promise<void> {
    if (this.#owns(owner)) this.#owner = undefined;
    owner.lease.revoke();
    this.#ending = this.#ending
      .then(async () => {
        if (!(await this.#storage.isEmpty())) await this.#storage.clear();
      })
      .catch(ignore);
    return this.#ending;
  }

  /**
   * Revocation is attempted and bounded; the Tali namespace is cleared
   * whatever happens, so no Cognito session data stays on the device. When
   * this returns, nothing the session started can reach the namespace again.
   */
  #end(owner: Owner, everywhere: boolean): Promise<void> {
    if (this.#owns(owner)) this.#owner = undefined;
    const work = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#signOutTimeoutMs);
      });
      try {
        // A refresh in flight may rotate the refresh token; revoking the rotated one is preferred.
        if (owner.busy !== undefined) await Promise.race([owner.busy.then(ignore, ignore), deadline]);
        owner.lease.freeze();
        await Promise.race([signOut(owner.context, { global: everywhere }).catch(ignore), deadline]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        owner.lease.revoke();
        await this.#storage.clear().catch(ignore);
      }
    };
    this.#ending = this.#ending.then(work, work);
    return this.#ending;
  }

  #session(owner: Owner): AuthSession {
    let ended = false;
    let inFlight: Promise<AccessTokenResult> | undefined;
    const current = () => !ended && this.#owns(owner);
    const read = async (): Promise<AccessTokenResult> => {
      let accessToken: string | undefined;
      try {
        // Amplify refreshes an expired access token here and stores the rotated refresh token through the lease.
        const { tokens } = await fetchAuthSession(owner.context);
        accessToken = tokens?.accessToken.toString();
      } catch (error) {
        if (!current()) return { ok: false, reason: "ended" };
        if (isNetworkError(error)) return { ok: false, reason: "unavailable" };
        accessToken = undefined;
      }
      if (!current()) return { ok: false, reason: "ended" };
      if (accessToken === undefined || accessToken === "") {
        // Definitive: the refresh was refused or nothing is stored. Clear what is left.
        ended = true;
        await this.#release(owner);
        return { ok: false, reason: "ended" };
      }
      return { ok: true, token: accessToken as AccessToken };
    };
    return {
      accessToken: () => {
        if (!current()) return Promise.resolve({ ok: false, reason: "ended" });
        inFlight ??= this.#track(
          owner,
          read().finally(() => {
            inFlight = undefined;
          }),
        );
        return inFlight;
      },
      end: ({ everywhere }) => {
        if (!current()) return this.#ending;
        ended = true;
        return this.#end(owner, everywhere);
      },
    };
  }
}
