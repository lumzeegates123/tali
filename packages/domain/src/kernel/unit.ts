import { KernelError } from "./errors.js";

declare const unitCodeBrand: unique symbol;

/**
 * A unit-of-measure code such as "PIECE" or "KG" (ADR-008 section 4.2). The
 * kernel validates the format only; which units exist is decided by the unit
 * reference data held by the server.
 */
export type UnitCode = string & { readonly [unitCodeBrand]: true };

const UNIT_CODE_PATTERN = /^[A-Z]{1,16}$/;

export const UNIT_KINDS = ["COUNT", "MASS", "VOLUME"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Unit scales range from 0 to 3 (ADR-008 section 4.2). */
export const MAX_UNIT_SCALE = 3;

export function isUnitCode(value: string): value is UnitCode {
  return UNIT_CODE_PATTERN.test(value);
}

export function parseUnitCode(value: string): UnitCode {
  if (!isUnitCode(value)) {
    throw new KernelError("INVALID_UNIT_CODE", `"${value}" is not a unit code (1 to 16 uppercase letters)`);
  }
  return value;
}

/**
 * Unit reference data needed for decimal parsing and formatting. The scale
 * always comes from reference data; the kernel never assumes one. Units are
 * never converted into each other, not even within one kind (KG is not G).
 */
export interface UnitDefinition {
  readonly code: UnitCode;
  readonly kind: UnitKind;
  readonly scale: number;
}

export function defineUnit(code: string, kind: UnitKind, scale: number): UnitDefinition {
  if (!(UNIT_KINDS as readonly string[]).includes(kind)) {
    throw new KernelError("INVALID_UNIT_DEFINITION", "unknown unit kind");
  }
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_UNIT_SCALE) {
    throw new KernelError(
      "INVALID_UNIT_DEFINITION",
      `unit scale must be an integer from 0 to ${MAX_UNIT_SCALE}, received ${scale}`,
    );
  }
  return Object.freeze({ code: parseUnitCode(code), kind, scale });
}
