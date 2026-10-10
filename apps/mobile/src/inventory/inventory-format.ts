import { defineUnit, Quantity, type UnitDefinition } from "@tali/domain/kernel";
import type {
  InventoryMovementResponse,
  RecordAdjustmentRequest,
  RecordWriteOffRequest,
  StocktakeResponse,
  UnitResponse,
} from "@tali/shared";

/**
 * Display text for API quantities and codes. Quantities are formatted from
 * their minor-unit strings with the kernel `Quantity` and the unit definitions
 * from `GET .../catalog/units`; nothing here adds, subtracts or compares
 * stock. Balances, LOW STOCK and variances are always the API's values.
 */

interface QuantityWire {
  readonly quantityMinor: string;
  readonly unit: string;
}

export function unitDefinition(unit: UnitResponse): UnitDefinition | undefined {
  try {
    return defineUnit(unit.code, unit.kind, unit.scale);
  } catch {
    return undefined;
  }
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

export function definitionFor(units: readonly UnitResponse[], code: string): UnitDefinition | undefined {
  const unit = units.find((candidate) => candidate.code === code);
  return unit === undefined ? undefined : unitDefinition(unit);
}

/** "12.5 KG"; the minor-unit string is shown when the unit definition is unknown. */
export function formatQuantity(quantity: QuantityWire, units: readonly UnitResponse[]): string {
  const definition = definitionFor(units, quantity.unit);
  if (definition === undefined) return `${quantity.quantityMinor} minor units ${quantity.unit}`;
  try {
    return `${Quantity.fromMinorUnitsString(quantity.quantityMinor, definition.code).toDecimalString(definition)} ${definition.code}`;
  } catch {
    return `${quantity.quantityMinor} minor units ${quantity.unit}`;
  }
}

/** A movement delta with an explicit sign: "+24 PIECE", "-3 PIECE". */
export function formatDelta(quantity: QuantityWire, units: readonly UnitResponse[]): string {
  const text = formatQuantity(quantity, units);
  const definition = definitionFor(units, quantity.unit);
  if (definition === undefined) return text;
  try {
    return Quantity.fromMinorUnitsString(quantity.quantityMinor, definition.code).isPositive() ? `+${text}` : text;
  } catch {
    return text;
  }
}

export const MOVEMENT_TYPE_LABEL: Readonly<Record<InventoryMovementResponse["type"], string>> = {
  OPENING: "Opening stock",
  PURCHASE_RECEIPT: "Stock received",
  ADJUSTMENT: "Adjustment",
  WRITE_OFF: "Write-off",
  COUNT_CORRECTION: "Stocktake correction",
};

export const SOURCE_KIND_LABEL: Readonly<Record<InventoryMovementResponse["source"]["kind"], string>> = {
  OPENING_BATCH: "Opening stock",
  GOODS_RECEIPT: "Goods receipt",
  ADJUSTMENT: "Adjustment or write-off",
  STOCKTAKE: "Stocktake",
};

export const ADJUSTMENT_REASON_LABEL: Readonly<Record<RecordAdjustmentRequest["reasonCode"], string>> = {
  FOUND_STOCK: "Found stock",
  DATA_ENTRY_CORRECTION: "Data entry correction",
  OTHER: "Other",
};

export const WRITE_OFF_REASON_LABEL: Readonly<Record<RecordWriteOffRequest["reasonCode"], string>> = {
  DAMAGED: "Damaged",
  EXPIRED: "Expired",
  SPOILED: "Spoiled",
  THEFT_OR_LOSS: "Theft or loss",
  OTHER: "Other",
};

const REASON_LABEL: Readonly<Record<NonNullable<InventoryMovementResponse["reasonCode"]>, string>> = {
  ...ADJUSTMENT_REASON_LABEL,
  ...WRITE_OFF_REASON_LABEL,
};

export function reasonLabel(code: InventoryMovementResponse["reasonCode"]): string | undefined {
  return code === null ? undefined : REASON_LABEL[code];
}

export const STOCKTAKE_STATUS_LABEL: Readonly<Record<StocktakeResponse["status"], string>> = {
  DRAFT: "In progress",
  POSTED: "Posted",
  CANCELLED: "Cancelled",
};

/** Local date and time of an API instant, for display only. */
export function formatInstant(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : date.toLocaleString();
}
