import type { FixedWindowRateLimiter } from "../auth/fixed-window-rate-limiter.js";

/**
 * What the local sign-in route needs: a token issuer (the process's
 * LocalIdentityProvider, seen through this narrow interface) and its
 * in-process limiter. Composed only when TALI_ENV=local.
 */
export interface LocalSignIn {
  readonly issuer: {
    issueAccessToken(subject: string): Promise<{ readonly accessToken: string; readonly expiresAt: Date }>;
  };
  readonly limiter: FixedWindowRateLimiter;
}
