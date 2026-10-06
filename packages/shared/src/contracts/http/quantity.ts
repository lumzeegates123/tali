import { z } from "zod";

const QUANTITY_MINOR_MAX = 10n ** 15n;
const QUANTITY_MINOR_PATTERN = /^-?(0|[1-9][0-9]{0,15})$/;

/**
 * A unit of measure code (ADR-008 section 4.2): 1 to 16 uppercase letters.
 * Whether the unit exists is checked server-side against reference data.
 */
export const UnitCodeWireSchema = z.string().regex(/^[A-Z]{1,16}$/, "must be 1 to 16 uppercase letters");

/**
 * A quantity in the unit's minor units as a canonical base-10 integer string
 * (ADR-008 section 4.1): optional minus sign, no leading zeros, no "-0", and an
 * absolute value of at most 10^15. Quantities are never JSON numbers.
 */
export const QuantityMinorStringSchema = z
  .string()
  .regex(QUANTITY_MINOR_PATTERN, "must be a canonical base-10 integer string of minor units")
  .refine((value) => value !== "-0", "must not be negative zero")
  .refine((value) => {
    if (!QUANTITY_MINOR_PATTERN.test(value)) return true;
    const amount = BigInt(value);
    return amount <= QUANTITY_MINOR_MAX && amount >= -QUANTITY_MINOR_MAX;
  }, "must be at most 10^15 in absolute value");

/** Wire format: `{ "quantityMinor": "1500", "unit": "KG" }` (1.500 kg). */
export const QuantityWireSchema = z.strictObject({
  quantityMinor: QuantityMinorStringSchema,
  unit: UnitCodeWireSchema,
});

export type QuantityWire = z.infer<typeof QuantityWireSchema>;
