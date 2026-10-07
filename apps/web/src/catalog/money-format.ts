import { type CurrencyDefinition, defineCurrency, Money } from "@tali/domain/kernel";
import { type BusinessCurrencyResponse, type MoneyWire, MoneyWireSchema } from "@tali/shared";

/**
 * Exact money conversion for the catalog UI. Input is a decimal string in
 * major units, converted by the kernel `Money` into the wire minor-unit
 * string; display formats the authoritative minor-unit string from the API.
 * No JavaScript number ever holds an amount.
 */

/** The business currency from `GET .../currency`; undefined if the definition is unusable. */
export function currencyDefinition(response: BusinessCurrencyResponse): CurrencyDefinition | undefined {
  try {
    return defineCurrency(response.code, response.minorUnitDigits);
  } catch {
    return undefined;
  }
}

export type MoneyInputError = "empty" | "format" | "notPositive" | "tooLarge";

export type MoneyInputResult =
  { readonly ok: true; readonly value: MoneyWire } | { readonly ok: false; readonly reason: MoneyInputError };

/** Parses a price typed in major units, e.g. "1500.50"; only surrounding whitespace is ignored. */
export function parseMoneyInput(input: string, definition: CurrencyDefinition): MoneyInputResult {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  let money: Money;
  try {
    money = Money.fromDecimalString(text, definition);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (!money.isPositive()) return { ok: false, reason: "notPositive" };
  const wire = MoneyWireSchema.safeParse({ amountMinor: money.toMinorUnitsString(), currency: definition.code });
  return wire.success ? { ok: true, value: wire.data } : { ok: false, reason: "tooLarge" };
}

/** How to type an amount in this currency. */
export function moneyInputHint(definition: CurrencyDefinition): string {
  if (definition.minorUnitDigits === 0) {
    return `Amount in ${definition.code}, for example 1500, with no separators or decimal places.`;
  }
  const example = `1500.${"5".padEnd(definition.minorUnitDigits, "0")}`;
  const places = definition.minorUnitDigits === 1 ? "1 decimal place" : `${definition.minorUnitDigits} decimal places`;
  return `Amount in ${definition.code}, for example ${example}, with no separators and at most ${places}.`;
}

export function moneyInputError(reason: MoneyInputError, definition: CurrencyDefinition): string {
  switch (reason) {
    case "empty":
      return "Enter a price.";
    case "notPositive":
      return "The price must be more than zero.";
    case "tooLarge":
      return "This price is too large.";
    case "format":
      return moneyInputHint(definition);
  }
}

/**
 * Display text for a wire amount, e.g. "1,500.50 NGN". Without a matching
 * currency definition the exact minor-unit string is shown instead of a guess.
 */
export function formatMoney(wire: MoneyWire, definition: CurrencyDefinition | undefined): string {
  if (definition === undefined || wire.currency !== definition.code) {
    return `${wire.amountMinor} minor units ${wire.currency}`;
  }
  try {
    const decimal = Money.fromMinorUnitsString(wire.amountMinor, definition.code).toDecimalString(definition);
    return `${groupDigits(decimal)} ${definition.code}`;
  } catch {
    return `${wire.amountMinor} minor units ${wire.currency}`;
  }
}

/** Inserts thousands separators into the whole part of a decimal string, as a pure string operation. */
export function groupDigits(decimal: string): string {
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const point = unsigned.indexOf(".");
  const whole = point === -1 ? unsigned : unsigned.slice(0, point);
  const fraction = point === -1 ? "" : unsigned.slice(point);
  const groups: string[] = [];
  for (let end = whole.length; end > 0; end -= 3) groups.unshift(whole.slice(end > 3 ? end - 3 : 0, end));
  return `${negative ? "-" : ""}${groups.join(",")}${fraction}`;
}
