import type {
  GoodsReceiptReference,
  InventoryNote,
  InventoryReasonNote,
  ProductPackId,
  ProductVariantId,
  UnitCode,
  UnitDefinition,
} from "@tali/domain";
import {
  MAX_INVENTORY_DOCUMENT_LINES,
  MAX_QUANTITY_MINOR,
  parseGoodsReceiptReference,
  parseInventoryNote,
  parseInventoryReasonNote,
  parseProductPackId,
  parseProductVariantId,
  parseUnitCode,
  Quantity,
} from "@tali/domain";
import { NotFoundError, ValidationError } from "../../errors/application-error.js";
import { withDomainRules } from "../../errors/domain-errors.js";
import type { CommandValue } from "../../idempotency/canonical-command.js";
import { canonicalEnum } from "../../idempotency/canonical-command.js";
import type { TransactionScope } from "../../ports/unit-of-work.js";
import type { UnitReferenceRepository } from "../catalog/index.js";
import { PACK_NOT_FOUND, PRODUCT_NOT_FOUND } from "../catalog/index.js";

export const GOODS_RECEIPT_NOT_FOUND = "Goods receipt not found";
export const ADJUSTMENT_NOT_FOUND = "Adjustment not found";

/**
 * One document line as received. Exactly one quantity form is required:
 * - `quantityMinor` (a positive base-10 integer string of minor units) with `unit`;
 * - `decimal` (an exact decimal string in stock units, e.g. "1.5") with `unit`;
 * - `packId` with `packCount` (a positive base-10 integer string of whole packs).
 * The unit must be the variant's stock unit; there is no unit conversion.
 */
export interface StockLineInput {
  readonly variantId: string;
  readonly quantityMinor?: string;
  readonly decimal?: string;
  readonly unit?: string;
  readonly packId?: string;
  readonly packCount?: string;
}

export const STOCK_LINE_DIRECTIONS = ["INCREASE", "DECREASE"] as const;
export type StockLineDirection = (typeof STOCK_LINE_DIRECTIONS)[number];

/** An adjustment line: an explicit direction and a positive magnitude (plan decision D3). */
export interface AdjustmentLineInput extends StockLineInput {
  readonly direction: StockLineDirection;
}

/** A line quantity after normalization: an exact stock-unit amount, or whole packs resolved later. */
export type LineQuantity =
  | { readonly form: "direct"; readonly quantityMinor: bigint; readonly unit: UnitCode }
  | { readonly form: "pack"; readonly packId: ProductPackId; readonly packCount: bigint };

export interface NormalizedStockLine {
  readonly variantId: ProductVariantId;
  readonly quantity: LineQuantity;
  readonly direction?: StockLineDirection;
}

type SyntaxQuantity = LineQuantity | { readonly form: "decimal"; readonly decimal: string; readonly unit: UnitCode };

/** A line whose syntax is valid; decimal quantities still need their unit definition. */
export interface StockLineSyntax {
  readonly index: number;
  readonly variantId: ProductVariantId;
  readonly quantity: SyntaxQuantity;
  readonly direction?: StockLineDirection;
}

function invalid(path: readonly (string | number)[], message: string): ValidationError {
  return new ValidationError(message, [{ path, message }]);
}

const SIGNED_INTEGER = /^-?(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** A positive amount of minor units, at most 10^15 (ADR-008 section 4.3). */
function parsePositiveMinor(value: unknown, path: readonly (string | number)[]): bigint {
  if (typeof value !== "string" || !SIGNED_INTEGER.test(value)) {
    throw invalid(path, "quantityMinor must be a base-10 integer string of minor units");
  }
  const amount = BigInt(value);
  if (amount <= 0n) throw invalid(path, "quantityMinor must be greater than zero");
  if (amount > MAX_QUANTITY_MINOR) throw invalid(path, "quantityMinor is out of range");
  return amount;
}

function parsePackCount(value: unknown, path: readonly (string | number)[]): bigint {
  if (typeof value !== "string" || !POSITIVE_INTEGER.test(value) || BigInt(value) > MAX_QUANTITY_MINOR) {
    throw invalid(path, "packCount must be a positive base-10 integer string of whole packs");
  }
  return BigInt(value);
}

function parseUnit(value: unknown, path: readonly (string | number)[]): UnitCode {
  if (typeof value !== "string") throw invalid(path, "unit is required with quantityMinor or decimal");
  try {
    return parseUnitCode(value);
  } catch {
    throw invalid(path, "unit is not a unit code");
  }
}

function idOrNotFound<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch {
    throw new NotFoundError(message);
  }
}

function parseLineQuantity(line: StockLineInput, index: number): SyntaxQuantity {
  const at = (field: string) => ["lines", index, field];
  const minor = line.quantityMinor !== undefined;
  const decimal = line.decimal !== undefined;
  const pack = line.packId !== undefined || line.packCount !== undefined;
  if (Number(minor) + Number(decimal) + Number(pack) !== 1) {
    throw invalid(
      ["lines", index],
      "a line needs exactly one quantity form: quantityMinor with unit, decimal with unit, or packId with packCount",
    );
  }
  if (pack) {
    if (line.unit !== undefined) throw invalid(at("unit"), "a pack line takes no unit");
    if (line.packId === undefined) throw invalid(at("packId"), "packId is required with packCount");
    const packCount = parsePackCount(line.packCount, at("packCount"));
    const packId = idOrNotFound(() => parseProductPackId(line.packId as string), PACK_NOT_FOUND);
    return { form: "pack", packId, packCount };
  }
  const unit = parseUnit(line.unit, at("unit"));
  if (minor)
    return { form: "direct", quantityMinor: parsePositiveMinor(line.quantityMinor, at("quantityMinor")), unit };
  if (typeof line.decimal !== "string") throw invalid(at("decimal"), "decimal must be a decimal string");
  return { form: "decimal", decimal: line.decimal, unit };
}

/**
 * Syntax checks that need no state (outside the transaction): 1 to 200 lines,
 * well-formed IDs (a malformed ID is NOT_FOUND, like a foreign one), one
 * quantity form per line, positive magnitudes, and one line per variant
 * (duplicates are rejected, never merged; plan decision D2).
 */
export function parseStockLines(lines: unknown, options: { readonly directions: boolean }): readonly StockLineSyntax[] {
  if (!Array.isArray(lines)) throw invalid(["lines"], "lines must be a list");
  const list = lines as readonly unknown[];
  if (list.length < 1 || list.length > MAX_INVENTORY_DOCUMENT_LINES) {
    throw invalid(["lines"], `a document has 1 to ${MAX_INVENTORY_DOCUMENT_LINES} lines`);
  }
  const parsed = list.map((raw, index): StockLineSyntax => {
    if (typeof raw !== "object" || raw === null) throw invalid(["lines", index], "a line must be an object");
    const line = raw as AdjustmentLineInput;
    const variantId = idOrNotFound(() => parseProductVariantId(line.variantId), PRODUCT_NOT_FOUND);
    const quantity = parseLineQuantity(line, index);
    if (!options.directions) {
      if ((line as { readonly direction?: unknown }).direction !== undefined) {
        throw invalid(["lines", index, "direction"], "this document takes no direction");
      }
      return { index, variantId, quantity };
    }
    if (!(STOCK_LINE_DIRECTIONS as readonly unknown[]).includes(line.direction)) {
      throw invalid(["lines", index, "direction"], "direction must be INCREASE or DECREASE");
    }
    return { index, variantId, quantity, direction: line.direction };
  });
  if (new Set(parsed.map((line) => line.variantId)).size !== parsed.length) {
    throw invalid(["lines"], "a document has one line per product");
  }
  return parsed;
}

async function unitDefinition(
  scope: TransactionScope,
  units: UnitReferenceRepository,
  code: UnitCode,
  index: number,
): Promise<UnitDefinition> {
  const definition = await units.findByCode(scope, code);
  if (definition === undefined) throw invalid(["lines", index, "unit"], "unit is not a known unit of measure");
  return definition;
}

/**
 * Normalizes decimal quantities to exact minor units with their unit's scale
 * (plan decision D4; more digits than the scale allows are rejected, never
 * rounded) and orders the lines by variant ID ascending (D19). Unit
 * definitions are global, immutable reference data: reading them takes no
 * lock and decides nothing about stock.
 */
export async function normalizeStockLines(
  scope: TransactionScope,
  units: UnitReferenceRepository,
  lines: readonly StockLineSyntax[],
): Promise<readonly NormalizedStockLine[]> {
  const normalized: NormalizedStockLine[] = [];
  for (const line of lines) {
    let quantity: LineQuantity;
    if (line.quantity.form === "decimal") {
      const { decimal, unit } = line.quantity;
      const definition = await unitDefinition(scope, units, unit, line.index);
      const exact = withDomainRules(() => Quantity.fromDecimalString(decimal, definition), "decimal");
      if (!exact.isPositive()) throw invalid(["lines", line.index, "decimal"], "decimal must be greater than zero");
      quantity = { form: "direct", quantityMinor: exact.amountMinor, unit };
    } else {
      quantity = line.quantity;
    }
    normalized.push({
      variantId: line.variantId,
      quantity,
      ...(line.direction === undefined ? {} : { direction: line.direction }),
    });
  }
  return normalized.sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
}

/**
 * The fingerprinted form of normalized lines (plan section L): a direct line
 * is `{variantId, quantityMinor, unit}` and a pack line `{variantId, packId,
 * packCount}`; a pack's name and factor are state, never part of the command.
 */
export function fingerprintLines(lines: readonly NormalizedStockLine[]): CommandValue[] {
  return lines.map((line) => {
    const direction = line.direction === undefined ? undefined : canonicalEnum(line.direction);
    return line.quantity.form === "direct"
      ? {
          variantId: line.variantId,
          quantityMinor: line.quantity.quantityMinor,
          unit: line.quantity.unit,
          direction,
        }
      : {
          variantId: line.variantId,
          packId: line.quantity.packId,
          packCount: line.quantity.packCount,
          direction,
        };
  });
}

/** Optional document note: 1 to 500 characters after trimming. */
export function parseOptionalNote(value: string | undefined): InventoryNote | undefined {
  return value === undefined ? undefined : withDomainRules(() => parseInventoryNote(value), "note");
}

/** Optional goods-receipt reference: 1 to 64 characters after trimming. */
export function parseOptionalReference(value: string | undefined): GoodsReceiptReference | undefined {
  return value === undefined ? undefined : withDomainRules(() => parseGoodsReceiptReference(value), "reference");
}

/** The required reason for a reversal: 1 to 500 characters after trimming. */
export function parseReversalReason(value: unknown): InventoryReasonNote {
  if (typeof value !== "string") throw invalid(["reason"], "a reversal reason is required");
  return withDomainRules(() => parseInventoryReasonNote(value, "reason"), "reason");
}

/**
 * A threshold value: a direct quantity (minor units or decimal) with its
 * unit, 0 or more. There is no pack form (plan section Q).
 */
export interface ThresholdQuantityInput {
  readonly quantityMinor?: string;
  readonly decimal?: string;
  readonly unit: string;
}

export async function parseThresholdQuantity(
  scope: TransactionScope,
  units: UnitReferenceRepository,
  input: ThresholdQuantityInput,
): Promise<Quantity> {
  if (typeof input !== "object" || (input as unknown) === null) {
    throw invalid(["threshold"], "threshold must be a quantity");
  }
  const source = input as ThresholdQuantityInput & { readonly packId?: unknown; readonly packCount?: unknown };
  if (source.packId !== undefined || source.packCount !== undefined) {
    throw invalid(["threshold"], "a threshold is a quantity in the stock unit; packs are not accepted");
  }
  if ((source.quantityMinor === undefined) === (source.decimal === undefined)) {
    throw invalid(["threshold"], "a threshold needs exactly one of quantityMinor or decimal, with unit");
  }
  const unit = parseUnit(source.unit, ["threshold", "unit"]);
  if (source.quantityMinor !== undefined) {
    return withDomainRules(() => Quantity.fromMinorUnitsString(source.quantityMinor as string, unit), "quantityMinor");
  }
  const definition = await units.findByCode(scope, unit);
  if (definition === undefined) throw invalid(["threshold", "unit"], "unit is not a known unit of measure");
  return withDomainRules(() => Quantity.fromDecimalString(source.decimal as string, definition), "decimal");
}
