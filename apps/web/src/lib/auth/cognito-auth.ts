import type { PublicCognitoConfig } from "@tali/config/public";
import type { CognitoAuth } from "./cognito-types";

export type {
  CognitoAuth,
  CognitoConfirmResult,
  CognitoFailure,
  CognitoResendResult,
  CognitoSignInResult,
  CognitoSignUpResult,
} from "./cognito-types";

/**
 * Cognito email + password sign-in in this app's own UI (ADR-003 section
 * 14.3). This module names no SDK: the Amplify implementation lives in
 * `./cognito/` and is loaded on first use, so local-mode builds never fetch it.
 * The password is passed straight to the SRP implementation and never kept,
 * logged or sent to the Tali API.
 */
export function lazyCognitoAuth(config: PublicCognitoConfig): CognitoAuth {
  let loaded: Promise<CognitoAuth> | undefined;
  const auth = () =>
    (loaded ??= import("./cognito/amplify-cognito-auth").then(({ AmplifyCognitoAuth }) =>
      AmplifyCognitoAuth.configure(config),
    ));
  return {
    signUp: async (email, password) => (await auth()).signUp(email, password),
    confirmSignUp: async (email, code) => (await auth()).confirmSignUp(email, code),
    resendSignUpCode: async (email) => (await auth()).resendSignUpCode(email),
    signIn: async (email, password) => (await auth()).signIn(email, password),
  };
}
