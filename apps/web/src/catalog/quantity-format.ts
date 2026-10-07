import { defineUnit, Quantity, type UnitDefinition } from "@tali/domain/kernel";
import { PackFactorMinorWireSchema, type UnitResponse } from "@tali/shared";

/**
 * Exact pack-factor conversion with the kernel `Quantity` and the unit
 * definition returned by `GET .../catalog/units`. `factorMinor` stays a
 * string end to end.
 */

export function unitDefinition(unit: UnitResponse): UnitDefinition | undefined {
  try {
    return defineUnit(unit.code, unit.kind, unit.scale);
  } catch {
    return undefined;
  }
}

export type FactorInputResult =
  | { readonly ok: true; readonly factorMinor: string }
  | { readonly ok: false; readonly reason: "empty" | "format" | "notPositive" };

/** Parses "quantity per pack" typed in the stock unit, e.g. "24" pieces or "0.5" KG. */
export function parseFactorInput(input: string, unit: UnitDefinition): FactorInputResult {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  let quantity: Quantity;
  try {
    quantity = Quantity.fromDecimalString(text, unit);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (!quantity.isPositive()) return { ok: false, reason: "notPositive" };
  const factorMinor = quantity.toMinorUnitsString();
  return PackFactorMinorWireSchema.safeParse(factorMinor).success
    ? { ok: true, factorMinor }
    : { ok: false, reason: "format" };
}

export function factorInputHint(unit: UnitDefinition): string {
  return unit.scale === 0
    ? `Whole ${unit.code} per pack, for example 24.`
    : `${unit.code} per pack, for example 0.5, with at most ${unit.scale} decimal places.`;
}

/** Display text for a pack factor, e.g. "24 PIECE"; the minor-unit string is shown when the unit is unknown. */
export function formatFactor(factorMinor: string, unit: UnitDefinition | undefined, stockUnit: string): string {
  if (unit === undefined || unit.code !== stockUnit) return `${factorMinor} minor units ${stockUnit}`;
  try {
    return `${Quantity.fromMinorUnitsString(factorMinor, unit.code).toDecimalString(unit)} ${unit.code}`;
  } catch {
    return `${factorMinor} minor units ${stockUnit}`;
  }
}
