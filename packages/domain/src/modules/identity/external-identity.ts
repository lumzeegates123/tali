import { DomainError } from "../../errors.js";
import { codePointLength, isWellFormedText } from "../../text.js";
import type { ExternalIdentityId, UserId } from "./ids.js";

/**
 * Persisted provider categories: the real execution modes only (ADR-005
 * section 3). Test adapters report one of these; there is no "fake" category.
 */
export const EXTERNAL_IDENTITY_PROVIDERS = ["COGNITO", "LOCAL"] as const;
export type ExternalIdentityProvider = (typeof EXTERNAL_IDENTITY_PROVIDERS)[number];

export function isExternalIdentityProvider(value: string): value is ExternalIdentityProvider {
  return (EXTERNAL_IDENTITY_PROVIDERS as readonly string[]).includes(value);
}

declare const providerSubjectBrand: unique symbol;

/**
 * The provider's stable subject identifier (the Cognito `sub`), never a
 * username, email or phone number. Stored exactly as issued: 1 to 255
 * characters, not normalized.
 */
export type ProviderSubject = string & { readonly [providerSubjectBrand]: true };

export const PROVIDER_SUBJECT_MAX_LENGTH = 255;

export function parseProviderSubject(value: string): ProviderSubject {
  const length = codePointLength(value);
  if (!isWellFormedText(value) || length < 1 || length > PROVIDER_SUBJECT_MAX_LENGTH) {
    throw new DomainError(
      "INVALID_VALUE",
      `provider subject must be 1 to ${PROVIDER_SUBJECT_MAX_LENGTH} characters`,
      "providerSubject",
    );
  }
  return value as ProviderSubject;
}

/** The identity key: unique per (provider, providerSubject). */
export interface ExternalIdentityKey {
  readonly provider: ExternalIdentityProvider;
  readonly providerSubject: ProviderSubject;
}

/**
 * The link between an external authentication identity and a Tali User. It
 * holds no provider tokens, refresh tokens or raw claims.
 */
export interface ExternalIdentity extends ExternalIdentityKey {
  readonly id: ExternalIdentityId;
  readonly userId: UserId;
  readonly createdAt: Date;
}

export function sameExternalIdentityKey(a: ExternalIdentityKey, b: ExternalIdentityKey): boolean {
  return a.provider === b.provider && a.providerSubject === b.providerSubject;
}

/** Validates and freezes an external identity (new or restored from storage). */
export function externalIdentity(props: {
  readonly id: ExternalIdentityId;
  readonly userId: UserId;
  readonly provider: string;
  readonly providerSubject: string;
  readonly createdAt: Date;
}): ExternalIdentity {
  if (!isExternalIdentityProvider(props.provider)) {
    throw new DomainError("INVALID_VALUE", "unsupported identity provider", "provider");
  }
  if (Number.isNaN(props.createdAt.getTime())) {
    throw new DomainError("INVALID_VALUE", "createdAt must be a valid instant", "createdAt");
  }
  return Object.freeze({
    id: props.id,
    userId: props.userId,
    provider: props.provider,
    providerSubject: parseProviderSubject(props.providerSubject),
    createdAt: new Date(props.createdAt.getTime()),
  });
}
