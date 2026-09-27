import { z } from "zod";

/** Stable, machine-readable error code, e.g. "VALIDATION_FAILED". */
export const ErrorCodeSchema = z
  .string()
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * The consistent API error body (50-api.mdc): `{ error: { code, message, details? } }`.
 * Messages are human-readable and never contain stack traces, SQL or other
 * tenants' data.
 */
export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(1000),
    details: z.unknown().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
