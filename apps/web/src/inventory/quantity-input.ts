import { Quantity, type UnitDefinition } from "@tali/domain/kernel";
import {
  type AdjustmentLineWire,
  AdjustmentLineWireSchema,
  type DirectNonNegativeQuantityWire,
  DirectNonNegativeQuantityWireSchema,
  type StockLineWire,
  StockLineWireSchema,
  type StocktakeCountWire,
  StocktakeCountWireSchema,
} from "@tali/shared";

/**
 * Turns what a person typed into wire quantities. Decimal text is parsed
 * exactly in the item's stock unit with the kernel `Quantity` (more decimal
 * places than the unit allows is rejected, never rounded) and sent as a
 * minor-unit string; pack entries are sent as typed for the API to convert.
 * Every result is checked with the shared request schema before it is sent.
 */

export type QuantityEntry =
  | { readonly kind: "direct"; readonly text: string }
  | { readonly kind: "pack"; readonly packId: string; readonly packCount: string; readonly loose: string };

export type EntryProblem = "empty" | "format" | "notPositive" | "noPack" | "packCount" | "unit";

export type EntryResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: EntryProblem };

type Direct =
  { readonly ok: true; readonly quantityMinor: string } | { readonly ok: false; readonly problem: EntryProblem };

function parseDirect(text: string, unit: UnitDefinition | undefined, positive: boolean): Direct {
  if (unit === undefined) return { ok: false, problem: "unit" };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, problem: "empty" };
  let quantity: Quantity;
  try {
    quantity = Quantity.fromDecimalString(trimmed, unit);
  } catch {
    return { ok: false, problem: "format" };
  }
  if (quantity.isNegative()) return { ok: false, problem: "format" };
  if (positive && !quantity.isPositive()) return { ok: false, problem: "notPositive" };
  return { ok: true, quantityMinor: quantity.toMinorUnitsString() };
}

function packFields(
  entry: Extract<QuantityEntry, { kind: "pack" }>,
): EntryResult<{ packId: string; packCount: string }> {
  if (entry.packId === "") return { ok: false, problem: "noPack" };
  const packCount = entry.packCount.trim();
  if (packCount === "") return { ok: false, problem: "empty" };
  if (!/^[1-9][0-9]{0,15}$/u.test(packCount)) return { ok: false, problem: "packCount" };
  return { ok: true, value: { packId: entry.packId, packCount } };
}

function checked<T>(schema: { safeParse(value: unknown): { success: boolean } }, value: T): EntryResult<T> {
  return schema.safeParse(value).success ? { ok: true, value } : { ok: false, problem: "format" };
}

/** A positive stock-document line (opening stock, goods receipt, write-off). */
export function stockLine(
  variantId: string,
  unit: UnitDefinition | undefined,
  entry: QuantityEntry,
): EntryResult<StockLineWire> {
  if (entry.kind === "pack") {
    const pack = packFields(entry);
    return pack.ok ? checked(StockLineWireSchema, { variantId, ...pack.value }) : pack;
  }
  const direct = parseDirect(entry.text, unit, true);
  if (!direct.ok || unit === undefined) return { ok: false, problem: direct.ok ? "unit" : direct.problem };
  return checked(StockLineWireSchema, { variantId, quantityMinor: direct.quantityMinor, unit: unit.code });
}

/** An adjustment line: the direction is chosen explicitly and the magnitude is always positive. */
export function adjustmentLine(
  variantId: string,
  direction: "INCREASE" | "DECREASE",
  unit: UnitDefinition | undefined,
  entry: QuantityEntry,
): EntryResult<AdjustmentLineWire> {
  if (entry.kind === "pack") {
    const pack = packFields(entry);
    return pack.ok ? checked(AdjustmentLineWireSchema, { variantId, direction, ...pack.value }) : pack;
  }
  const direct = parseDirect(entry.text, unit, true);
  if (!direct.ok || unit === undefined) return { ok: false, problem: direct.ok ? "unit" : direct.problem };
  return checked(AdjustmentLineWireSchema, {
    variantId,
    direction,
    quantityMinor: direct.quantityMinor,
    unit: unit.code,
  });
}

/** A stocktake count of 0 or more: direct, or whole packs plus an optional loose quantity. */
export function stocktakeCount(
  unit: UnitDefinition | undefined,
  entry: QuantityEntry,
): EntryResult<StocktakeCountWire> {
  if (entry.kind === "pack") {
    const pack = packFields(entry);
    if (!pack.ok) return pack;
    if (entry.loose.trim() === "") return checked(StocktakeCountWireSchema, pack.value);
    const loose = parseDirect(entry.loose, unit, false);
    if (!loose.ok || unit === undefined) return { ok: false, problem: loose.ok ? "unit" : loose.problem };
    return checked(StocktakeCountWireSchema, {
      ...pack.value,
      loose: { quantityMinor: loose.quantityMinor, unit: unit.code },
    });
  }
  const direct = parseDirect(entry.text, unit, false);
  if (!direct.ok || unit === undefined) return { ok: false, problem: direct.ok ? "unit" : direct.problem };
  return checked(StocktakeCountWireSchema, { quantityMinor: direct.quantityMinor, unit: unit.code });
}

/** A low-stock threshold of 0 or more, in the stock unit only (no pack form). */
export function thresholdQuantity(
  unit: UnitDefinition | undefined,
  text: string,
): EntryResult<DirectNonNegativeQuantityWire> {
  const direct = parseDirect(text, unit, false);
  if (!direct.ok || unit === undefined) return { ok: false, problem: direct.ok ? "unit" : direct.problem };
  return checked(DirectNonNegativeQuantityWireSchema, { quantityMinor: direct.quantityMinor, unit: unit.code });
}

export function entryProblemText(problem: EntryProblem, unit: UnitDefinition | undefined): string {
  switch (problem) {
    case "empty":
      return "Enter a quantity.";
    case "notPositive":
      return "Enter a quantity greater than zero.";
    case "noPack":
      return "Choose a pack.";
    case "packCount":
      return "Enter a whole number of packs, for example 2.";
    case "unit":
      return "The stock unit of this item could not be loaded. Try again later.";
    case "format":
      return unit === undefined || unit.scale === 0
        ? `Enter a whole number${unit === undefined ? "" : ` of ${unit.code}`}, for example 12.`
        : `Enter ${unit.code} as a number with at most ${unit.scale} decimal places, for example 1.5.`;
  }
}
