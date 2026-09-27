import { z } from "zod";

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MINOR_UNITS_PATTERN = /^-?(0|[1-9][0-9]{0,18})$/;

/**
 * Minor units as a base-10 integer string (ADR-002 section 13), bounded to the
 * PostgreSQL BIGINT range. Money is never a JSON number.
 */
export const MinorUnitsStringSchema = z
  .string()
  .regex(MINOR_UNITS_PATTERN, "must be a base-10 integer string of minor units")
  .refine((value) => value !== "-0", "must not be negative zero")
  .refine((value) => {
    if (!MINOR_UNITS_PATTERN.test(value)) return true;
    const amount = BigInt(value);
    return amount >= INT64_MIN && amount <= INT64_MAX;
  }, "must fit in a signed 64-bit integer");

/** ISO 4217 alphabetic code; support for a given currency is validated server-side against reference data. */
export const CurrencyCodeWireSchema = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 alphabetic currency code");

/** Wire format: `{ "amountMinor": "125050", "currency": "NGN" }`. */
export const MoneyWireSchema = z.strictObject({
  amountMinor: MinorUnitsStringSchema,
  currency: CurrencyCodeWireSchema,
});

export type MoneyWire = z.infer<typeof MoneyWireSchema>;
