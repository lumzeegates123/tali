import type { AccessToken } from "../api-client/tali-api-client";

/**
 * Why no access token could be produced:
 * - `ended`: the session can no longer be used (refresh refused or revoked); sign in again;
 * - `unavailable`: the identity provider could not be reached; the session may still be usable.
 */
export type AccessTokenResult =
  { readonly ok: true; readonly token: AccessToken } | { readonly ok: false; readonly reason: "ended" | "unavailable" };

/**
 * An authenticated session as the session store sees it. Tokens stay inside
 * the implementation's memory; callers ask for a current access token per API
 * call and never keep it. Implementations are provider-specific (local
 * development, Cognito); the store is not.
 */
export interface AuthSession {
  /** A current access token, refreshed when needed. Concurrent callers share one refresh. */
  accessToken(): Promise<AccessTokenResult>;
  /**
   * Forgets every local token. Remote revocation (Cognito RevokeToken, or
   * GlobalSignOut when `everywhere`) is attempted but never blocks or undoes
   * the local sign-out. Calling it again does nothing.
   */
  end(options: { readonly everywhere: boolean }): Promise<void>;
}

/** The local development session: one access token from `POST /__local/sign-in`, no refresh. */
export function staticAuthSession(token: AccessToken): AuthSession {
  let current: AccessToken | undefined = token;
  return {
    accessToken: async () => (current === undefined ? { ok: false, reason: "ended" } : { ok: true, token: current }),
    end: async () => {
      current = undefined;
    },
  };
}
