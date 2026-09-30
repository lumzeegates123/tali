import { z } from "zod";

/**
 * `POST /__local/sign-in`: local development only (TALI_ENV=local and
 * IDENTITY_PROVIDER=local; ADR-005 section 16). It asserts an identity and
 * nothing else: no user, business or membership is created.
 */
export const LocalSignInRequestSchema = z.strictObject({
  subject: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be 1 to 64 letters, digits, '.', '_' or '-'"),
});

export type LocalSignInRequest = z.infer<typeof LocalSignInRequestSchema>;

export const LocalSignInResponseSchema = z.strictObject({
  accessToken: z.string().min(1).max(4096),
  tokenType: z.literal("Bearer"),
  expiresAt: z.iso.datetime(),
});

export type LocalSignInResponse = z.infer<typeof LocalSignInResponseSchema>;
