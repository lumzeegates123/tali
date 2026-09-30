/**
 * @tali/integrations/local: local-development adapters. Composition allows
 * them only when TALI_ENV=local (ADR-005 section 16).
 */
export type { LocalAccessToken } from "./local-identity-provider.js";
export {
  LOCAL_AUDIENCE,
  LOCAL_ISSUER,
  LOCAL_SUBJECT_PATTERN,
  LOCAL_TOKEN_TTL_SECONDS,
  LocalIdentityProvider,
} from "./local-identity-provider.js";
