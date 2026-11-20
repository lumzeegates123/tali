import { type CurrencyDefinition, Quantity, type UnitDefinition } from "@tali/domain/kernel";
import {
  type MoneyWire,
  type RecordSaleRequest,
  RecordSaleRequestSchema,
  type SaleDiscountRequestWire,
  type SaleLineRequestWire,
  type SaleTenderRequestWire,
} from "@tali/shared";
import { moneyInputHint, parseMoneyInput } from "../catalog/money-format";

/**
 * Turns the cart and tender rows a person typed into the `RecordSale` wire
 * command. Quantities are parsed exactly in the stock unit by the kernel
 * `Quantity` (extra decimal places are rejected, never rounded); amounts are
 * parsed by the kernel `Money` in the business currency. Nothing here adds up
 * prices, applies a discount, computes tax, a total, change, cost or margin:
 * Tali computes all of those when the sale is recorded.
 */

export const MAX_CART_LINES = 200;
export const MAX_TENDERS = 10;
export const MAX_TENDER_REFERENCE = 64;
export const MAX_BASIS_POINTS = 9999;

export type TenderMethod = SaleTenderRequestWire["method"];
export type DiscountKind = "NONE" | "FIXED" | "PERCENT";

export const TENDER_LABEL: Readonly<Record<TenderMethod, string>> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank transfer",
  POS_CARD: "POS card",
  OTHER: "Other",
};

/** One cart row per variant, in its stock unit; the price is what the catalog displayed. */
export interface CartLine {
  readonly variantId: string;
  readonly productId: string;
  readonly name: string;
  readonly sku: string | null;
  readonly stockUnit: string;
  readonly displayedPrice: MoneyWire;
  readonly priceVersion: number;
  readonly quantityText: string;
  readonly discountKind: DiscountKind;
  readonly discountText: string;
}

export interface TenderDraft {
  /** A row identity for rendering only; never sent. */
  readonly rowId: string;
  readonly method: TenderMethod;
  readonly amountText: string;
  /** Non-cash tenders only. */
  readonly reference: string;
  /** Cash tenders only. */
  readonly cashReceivedText: string;
}

/** The command without its `saleId`: what "the same sale" means for a retry. */
export type SalePayload = Pick<RecordSaleRequest, "lines" | "tenders">;

export interface LineErrors {
  readonly quantity?: string;
  readonly discount?: string;
}

export interface TenderErrors {
  readonly amount?: string;
  readonly reference?: string;
  readonly cashReceived?: string;
}

export type DraftResult =
  | { readonly ok: true; readonly payload: SalePayload }
  | {
      readonly ok: false;
      readonly form: string | undefined;
      readonly lines: Readonly<Record<string, LineErrors>>;
      readonly tenders: Readonly<Record<string, TenderErrors>>;
    };

function quantityError(text: string, unit: UnitDefinition | undefined): string | { readonly minor: string } {
  if (unit === undefined) return "The stock unit of this item could not be loaded. Try again later.";
  const trimmed = text.trim();
  if (trimmed === "") return "Enter a quantity.";
  let quantity: Quantity;
  try {
    quantity = Quantity.fromDecimalString(trimmed, unit);
  } catch {
    return unit.scale === 0
      ? `Enter a whole number of ${unit.code}, for example 2.`
      : `Enter ${unit.code} as a number with at most ${unit.scale} decimal places, for example 1.5.`;
  }
  if (!quantity.isPositive()) return "Enter a quantity greater than zero.";
  return { minor: quantity.toMinorUnitsString() };
}

/** "12.5" percent to 1250 basis points, by string: 1 to 9999 basis points, at most 2 decimal places. */
export function percentToBasisPoints(text: string): number | undefined {
  const match = /^([0-9]{1,2})(?:\.([0-9]{1,2}))?$/u.exec(text.trim());
  if (match === null) return undefined;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const basisPoints = Number.parseInt(`${whole}${fraction}`, 10);
  return basisPoints >= 1 && basisPoints <= MAX_BASIS_POINTS ? basisPoints : undefined;
}

/** Basis points as a percent for display, by string: 1250 is "12.5%". */
export function basisPointsText(basisPoints: number): string {
  const digits = String(basisPoints).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2).replace(/0+$/u, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`}%`;
}

function discountOf(
  line: CartLine,
  definition: CurrencyDefinition,
): { readonly discount: SaleDiscountRequestWire | undefined } | string {
  switch (line.discountKind) {
    case "NONE":
      return { discount: undefined };
    case "FIXED": {
      const parsed = parseMoneyInput(line.discountText, definition);
      if (parsed.ok) return { discount: { kind: "FIXED", amount: parsed.value } };
      return parsed.reason === "empty"
        ? "Enter the discount amount."
        : parsed.reason === "notPositive"
          ? "The discount must be more than zero."
          : parsed.reason === "tooLarge"
            ? "This discount is too large."
            : moneyInputHint(definition);
    }
    case "PERCENT": {
      const basisPoints = percentToBasisPoints(line.discountText);
      return basisPoints === undefined
        ? "Enter a percentage from 0.01 to 99.99, with at most 2 decimal places."
        : { discount: { kind: "BASIS_POINTS", basisPoints } };
    }
  }
}

function tenderOf(
  tender: TenderDraft,
  definition: CurrencyDefinition,
): { readonly tender: SaleTenderRequestWire } | TenderErrors {
  const errors: { amount?: string; reference?: string; cashReceived?: string } = {};
  const amount = parseMoneyInput(tender.amountText, definition);
  if (!amount.ok) {
    errors.amount =
      amount.reason === "empty"
        ? "Enter the amount paid with this tender."
        : amount.reason === "notPositive"
          ? "The amount must be more than zero."
          : amount.reason === "tooLarge"
            ? "This amount is too large."
            : moneyInputHint(definition);
  }
  let cashReceived: MoneyWire | undefined;
  let reference: string | undefined;
  if (tender.method === "CASH") {
    if (tender.cashReceivedText.trim() !== "") {
      const parsed = parseMoneyInput(tender.cashReceivedText, definition);
      if (parsed.ok) cashReceived = parsed.value;
      else
        errors.cashReceived = parsed.reason === "tooLarge" ? "This amount is too large." : moneyInputHint(definition);
    }
  } else {
    const trimmed = tender.reference.trim();
    if (trimmed.length > MAX_TENDER_REFERENCE) errors.reference = `Use at most ${MAX_TENDER_REFERENCE} characters.`;
    else if (trimmed !== "") reference = trimmed;
  }
  if (!amount.ok || errors.reference !== undefined || errors.cashReceived !== undefined) return errors;
  return {
    tender: {
      method: tender.method,
      amount: amount.value,
      ...(reference === undefined ? {} : { reference }),
      ...(cashReceived === undefined ? {} : { cashReceived }),
    },
  };
}

/**
 * Builds the sale command or the errors to show. `allowDiscount` is the UX
 * affordance only: without it any discount typed is refused here, and the API
 * still refuses a discount without `sales:discount`.
 */
export function buildSalePayload(input: {
  readonly lines: readonly CartLine[];
  readonly tenders: readonly TenderDraft[];
  readonly currency: CurrencyDefinition;
  readonly unitFor: (code: string) => UnitDefinition | undefined;
  readonly allowDiscount: boolean;
}): DraftResult {
  const lineErrors: Record<string, LineErrors> = {};
  const tenderErrors: Record<string, TenderErrors> = {};
  let form: string | undefined;
  if (input.lines.length === 0) form = "Add at least one product to the cart.";
  else if (input.lines.length > MAX_CART_LINES) form = `A sale can have at most ${MAX_CART_LINES} lines.`;
  else if (input.tenders.length === 0) form = "Add at least one tender.";
  else if (input.tenders.length > MAX_TENDERS) form = `A sale can have at most ${MAX_TENDERS} tenders.`;

  const lines: SaleLineRequestWire[] = [];
  for (const line of input.lines) {
    const errors: { quantity?: string; discount?: string } = {};
    const unit = input.unitFor(line.stockUnit);
    const quantity = quantityError(line.quantityText, unit);
    if (typeof quantity === "string") errors.quantity = quantity;
    let discount: SaleDiscountRequestWire | undefined;
    if (line.discountKind !== "NONE" && !input.allowDiscount) {
      errors.discount = "You cannot give discounts.";
    } else {
      const parsed = discountOf(line, input.currency);
      if (typeof parsed === "string") errors.discount = parsed;
      else discount = parsed.discount;
    }
    if (errors.quantity !== undefined || errors.discount !== undefined || typeof quantity === "string") {
      lineErrors[line.variantId] = errors;
      continue;
    }
    lines.push({
      variantId: line.variantId,
      quantity: { quantityMinor: quantity.minor, unit: line.stockUnit },
      expectedPriceVersion: line.priceVersion,
      ...(discount === undefined ? {} : { discount }),
    });
  }

  const tenders: SaleTenderRequestWire[] = [];
  for (const draft of input.tenders) {
    const parsed = tenderOf(draft, input.currency);
    if ("tender" in parsed) tenders.push(parsed.tender);
    else tenderErrors[draft.rowId] = parsed;
  }

  if (form !== undefined || Object.keys(lineErrors).length > 0 || Object.keys(tenderErrors).length > 0) {
    return { ok: false, form, lines: lineErrors, tenders: tenderErrors };
  }
  const payload: SalePayload = { lines, tenders };
  const checked = RecordSaleRequestSchema.safeParse({ saleId: "00000000-0000-7000-8000-000000000000", ...payload });
  if (!checked.success) {
    return { ok: false, form: "Some details are not valid. Check the cart and tenders.", lines: {}, tenders: {} };
  }
  return { ok: true, payload };
}
