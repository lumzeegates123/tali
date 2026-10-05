import type { PublicCognitoConfig } from "@tali/config/public";
import type * as AmplifyModule from "./cognito/amplify-cognito-auth";
import type { CognitoAuth } from "./cognito-types";

export type {
  CognitoAuth,
  CognitoConfirmResult,
  CognitoFailure,
  CognitoResendResult,
  CognitoRestoreResult,
  CognitoSignInResult,
  CognitoSignUpResult,
} from "./cognito-types";

/**
 * Cognito email + password sign-in in this app's own UI (ADR-003 section
 * 14.3, ADR-007). This module names no SDK: the Amplify implementation lives
 * in `./cognito/` and is loaded and configured, secure storage first, on the
 * first operation, so local-mode builds never execute Amplify. The password
 * is passed straight to the SRP implementation and never kept, logged or
 * sent to the Tali API.
 */
export function lazyCognitoAuth(config: PublicCognitoConfig): CognitoAuth {
  let loaded: Promise<CognitoAuth> | undefined;
  const auth = () =>
    (loaded ??= Promise.resolve().then(() => {
      // Metro bundles this module either way; requiring it here defers its evaluation to first use.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AmplifyCognitoAuth } = require("./cognito/amplify-cognito-auth") as typeof AmplifyModule;
      return AmplifyCognitoAuth.configure(config);
    }));
  return {
    restore: async () => (await auth()).restore(),
    signUp: async (email, password) => (await auth()).signUp(email, password),
    confirmSignUp: async (email, code) => (await auth()).confirmSignUp(email, code),
    resendSignUpCode: async (email) => (await auth()).resendSignUpCode(email),
    signIn: async (email, password) => (await auth()).signIn(email, password),
    forgetStoredSession: async () => (await auth()).forgetStoredSession(),
  };
}
