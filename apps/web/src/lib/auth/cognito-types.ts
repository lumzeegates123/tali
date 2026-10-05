import type { AuthSession } from "./auth-session";

/**
 * The Cognito sign-in contract between the UI and the Amplify implementation
 * (`./cognito/`). It names no SDK.
 */

/** Bounded, user-safe failure reasons. Provider messages and codes are never shown. */
export type CognitoFailure =
  | "invalidCredentials"
  | "accountExists"
  | "passwordRejected"
  | "invalidEmail"
  | "invalidCode"
  | "expiredCode"
  | "tooManyAttempts"
  | "unavailable"
  | "unknown";

export type CognitoSignUpResult =
  | { readonly status: "confirmationRequired" }
  | { readonly status: "complete" }
  | { readonly status: "failed"; readonly reason: CognitoFailure };

export type CognitoConfirmResult =
  { readonly status: "confirmed" } | { readonly status: "failed"; readonly reason: CognitoFailure };

export type CognitoResendResult =
  { readonly status: "sent" } | { readonly status: "failed"; readonly reason: CognitoFailure };

export type CognitoSignInResult =
  | { readonly status: "signedIn"; readonly session: AuthSession }
  /** The account exists but its email is not confirmed yet. */
  | { readonly status: "confirmationRequired" }
  /**
   * Cognito asked for a further step this client does not implement (for
   * example a new password or MFA). Nothing about the step is exposed.
   */
  | { readonly status: "unsupportedStep" }
  | { readonly status: "failed"; readonly reason: CognitoFailure };

export interface CognitoAuth {
  signUp(email: string, password: string): Promise<CognitoSignUpResult>;
  confirmSignUp(email: string, code: string): Promise<CognitoConfirmResult>;
  resendSignUpCode(email: string): Promise<CognitoResendResult>;
  signIn(email: string, password: string): Promise<CognitoSignInResult>;
}
