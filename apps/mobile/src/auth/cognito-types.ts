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

/** The session persisted on this device (ADR-007), if any, at app start. */
export type CognitoRestoreResult =
  | { readonly status: "signedIn"; readonly session: AuthSession }
  /** Nothing usable is stored; anything stored has been cleared. */
  | { readonly status: "none" }
  /** A stored session exists but Cognito could not be reached to refresh it; it is kept. */
  | { readonly status: "unavailable" };

export interface CognitoAuth {
  restore(): Promise<CognitoRestoreResult>;
  signUp(email: string, password: string): Promise<CognitoSignUpResult>;
  confirmSignUp(email: string, code: string): Promise<CognitoConfirmResult>;
  resendSignUpCode(email: string): Promise<CognitoResendResult>;
  signIn(email: string, password: string): Promise<CognitoSignInResult>;
  /** Ends a stored session that could not be restored: revocation attempted, local state cleared. */
  forgetStoredSession(): Promise<void>;
}
