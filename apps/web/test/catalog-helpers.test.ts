import { defineCurrency, defineUnit } from "@tali/domain/kernel";
import type { CreateProductRequest } from "@tali/shared";
import { describe, expect, it } from "vitest";
import { catalogAffordances } from "../src/catalog/affordances";
import { KeyedSubmission, sameAddPack, sameCreateCategory, sameCreateProduct } from "../src/catalog/keyed-submission";
import { currencyDefinition, formatMoney, groupDigits, parseMoneyInput } from "../src/catalog/money-format";
import { formatFactor, parseFactorInput } from "../src/catalog/quantity-format";

const NGN = defineCurrency("NGN", 2);
const JPY = defineCurrency("JPY", 0);
const BHD = defineCurrency("BHD", 3);
const PIECE = defineUnit("PIECE", "COUNT", 0);
const KG = defineUnit("KG", "MASS", 3);

describe("exact money input", () => {
  it("converts decimal major units to the minor-unit wire string without floats", () => {
    for (const [input, definition, amountMinor] of [
      ["350.00", NGN, "35000"],
      ["350", NGN, "35000"],
      ["  1500.5 ", NGN, "150050"],
      ["0.01", NGN, "1"],
      ["0.1", NGN, "10"],
      ["1500", JPY, "1500"],
      ["1.234", BHD, "1234"],
      ["90071992547409.93", NGN, "9007199254740993"],
      ["92233720368547758.07", NGN, "9223372036854775807"],
    ] as const) {
      expect({ input, result: parseMoneyInput(input, definition) }).toEqual({
        input,
        result: { ok: true, value: { amountMinor, currency: definition.code } },
      });
    }
  });

  it("rejects ambiguous, rounded, separated or non-positive input", () => {
    for (const [input, definition, reason] of [
      ["", NGN, "empty"],
      ["   ", NGN, "empty"],
      ["1,500.00", NGN, "format"],
      ["1 500", NGN, "format"],
      ["1500.505", NGN, "format"],
      ["1.5", JPY, "format"],
      ["1e3", NGN, "format"],
      ["0x10", NGN, "format"],
      [".5", NGN, "format"],
      ["5.", NGN, "format"],
      ["+5", NGN, "format"],
      ["NaN", NGN, "format"],
      ["Infinity", NGN, "format"],
      ["01.00", NGN, "format"],
      ["0", NGN, "notPositive"],
      ["0.00", NGN, "notPositive"],
      ["-1.00", NGN, "notPositive"],
      ["92233720368547758.08", NGN, "tooLarge"],
    ] as const) {
      expect({ input, result: parseMoneyInput(input, definition) }).toEqual({ input, result: { ok: false, reason } });
    }
  });

  it("formats the authoritative minor-unit string with the server currency definition", () => {
    expect(formatMoney({ amountMinor: "35000", currency: "NGN" }, NGN)).toBe("350.00 NGN");
    expect(formatMoney({ amountMinor: "123456789", currency: "NGN" }, NGN)).toBe("1,234,567.89 NGN");
    expect(formatMoney({ amountMinor: "9007199254740993", currency: "NGN" }, NGN)).toBe("90,071,992,547,409.93 NGN");
    expect(formatMoney({ amountMinor: "1500", currency: "JPY" }, JPY)).toBe("1,500 JPY");
    expect(formatMoney({ amountMinor: "5", currency: "BHD" }, BHD)).toBe("0.005 BHD");
  });

  it("shows exact minor units instead of guessing when the definition is missing or differs", () => {
    expect(formatMoney({ amountMinor: "35000", currency: "NGN" }, undefined)).toBe("35000 minor units NGN");
    expect(formatMoney({ amountMinor: "35000", currency: "KES" }, NGN)).toBe("35000 minor units KES");
  });

  it("groups digits as a string operation", () => {
    expect(groupDigits("0.50")).toBe("0.50");
    expect(groupDigits("100")).toBe("100");
    expect(groupDigits("1000")).toBe("1,000");
    expect(groupDigits("-1234567.8")).toBe("-1,234,567.8");
  });

  it("builds a definition only from a valid server currency", () => {
    expect(currencyDefinition({ code: "NGN", minorUnitDigits: 2 })).toEqual(NGN);
    expect(currencyDefinition({ code: "ngn", minorUnitDigits: 2 })).toBeUndefined();
  });
});

describe("exact pack factor", () => {
  it("converts the per-pack quantity in the stock unit to factorMinor", () => {
    expect(parseFactorInput("24", PIECE)).toEqual({ ok: true, factorMinor: "24" });
    expect(parseFactorInput(" 12 ", PIECE)).toEqual({ ok: true, factorMinor: "12" });
    expect(parseFactorInput("0.5", KG)).toEqual({ ok: true, factorMinor: "500" });
    expect(parseFactorInput("25", KG)).toEqual({ ok: true, factorMinor: "25000" });
    expect(parseFactorInput("1.001", KG)).toEqual({ ok: true, factorMinor: "1001" });
  });

  it("rejects fractions beyond the unit scale, separators and non-positive values", () => {
    for (const [input, unit, reason] of [
      ["", PIECE, "empty"],
      ["1.5", PIECE, "format"],
      ["0.0005", KG, "format"],
      ["1,000", PIECE, "format"],
      ["1e2", PIECE, "format"],
      ["0", PIECE, "notPositive"],
      ["-2", PIECE, "notPositive"],
    ] as const) {
      expect({ input, result: parseFactorInput(input, unit) }).toEqual({ input, result: { ok: false, reason } });
    }
  });

  it("formats factorMinor in the stock unit", () => {
    expect(formatFactor("24", PIECE, "PIECE")).toBe("24 PIECE");
    expect(formatFactor("500", KG, "KG")).toBe("0.500 KG");
    expect(formatFactor("500", undefined, "KG")).toBe("500 minor units KG");
    expect(formatFactor("500", PIECE, "KG")).toBe("500 minor units KG");
  });
});

describe("role affordances (UX only)", () => {
  it("matches the five-role permission matrix and is read-only for anything else", () => {
    expect(
      Object.fromEntries(
        ["OWNER", "MANAGER", "STOCK_KEEPER", "CASHIER", "ACCOUNTANT", "UNKNOWN"].map((role) => [
          role,
          catalogAffordances(role),
        ]),
      ),
    ).toEqual({
      OWNER: { canManage: true, canPrice: true },
      MANAGER: { canManage: true, canPrice: true },
      STOCK_KEEPER: { canManage: true, canPrice: false },
      CASHIER: { canManage: false, canPrice: false },
      ACCOUNTANT: { canManage: false, canPrice: false },
      UNKNOWN: { canManage: false, canPrice: false },
    });
    expect(catalogAffordances(undefined)).toEqual({ canManage: false, canPrice: false });
  });
});

describe("keyed submission", () => {
  const BASE: CreateProductRequest = {
    name: "Malt 33cl",
    description: "Can",
    categoryId: "0190a000-0000-7000-8000-000000000c01",
    sku: "MALT-33",
    barcode: "6151234567890",
    stockUnit: "PIECE",
    trackInventory: true,
    initialPrice: { amountMinor: "35000", currency: "NGN" },
  };

  it("treats a create-product command as unchanged only when every request field matches", () => {
    expect(sameCreateProduct(BASE, { ...BASE })).toBe(true);
    expect(sameCreateProduct(BASE, { ...BASE, initialPrice: { amountMinor: "35000", currency: "NGN" } })).toBe(true);
    const variants: Partial<Record<keyof CreateProductRequest, unknown>>[] = [
      { name: "Malt 50cl" },
      { description: "Bottle" },
      { categoryId: "0190a000-0000-7000-8000-000000000c02" },
      { sku: "MALT-34" },
      { barcode: "6151234567891" },
      { stockUnit: "KG" },
      { trackInventory: false },
      { initialPrice: { amountMinor: "35001", currency: "NGN" } },
      { initialPrice: { amountMinor: "35000", currency: "KES" } },
    ];
    for (const change of variants) {
      expect({ change, same: sameCreateProduct(BASE, { ...BASE, ...change } as CreateProductRequest) }).toEqual({
        change,
        same: false,
      });
    }
    for (const field of ["description", "categoryId", "sku", "barcode", "initialPrice"] as const) {
      const without = Object.fromEntries(Object.entries(BASE).filter(([key]) => key !== field)) as CreateProductRequest;
      expect({ field, same: sameCreateProduct(BASE, without) }).toEqual({ field, same: false });
      expect({ field, same: sameCreateProduct(without, BASE) }).toEqual({ field, same: false });
      expect({ field, same: sameCreateProduct(without, { ...without }) }).toEqual({ field, same: true });
    }
    const emptySku = { ...BASE, sku: "" };
    const noSku = { ...BASE };
    delete noSku.sku;
    expect(sameCreateProduct(emptySku, noSku)).toBe(false);
  });

  it("compares category name and pack product, name and factor", () => {
    expect(sameCreateCategory({ name: "Drinks" }, { name: "Drinks" })).toBe(true);
    expect(sameCreateCategory({ name: "Drinks" }, { name: "drinks" })).toBe(false);
    const pack = { productId: "p-1", request: { name: "Crate", factorMinor: "24" } };
    expect(sameAddPack(pack, { productId: "p-1", request: { name: "Crate", factorMinor: "24" } })).toBe(true);
    expect(sameAddPack(pack, { ...pack, productId: "p-2" })).toBe(false);
    expect(sameAddPack(pack, { ...pack, request: { name: "Box", factorMinor: "24" } })).toBe(false);
    expect(sameAddPack(pack, { ...pack, request: { name: "Crate", factorMinor: "12" } })).toBe(false);
  });

  it("reuses the key after an unknown outcome, renews it on change, success or IDEMPOTENCY_KEY_REUSED", () => {
    let next = 0;
    const submission = new KeyedSubmission(sameCreateCategory, () => `key-${String((next += 1))}`);
    expect(submission.begin({ name: "Drinks" })).toBe("key-1");
    expect(submission.begin({ name: "Drinks" })).toBeUndefined();
    submission.finish("failed");
    expect(submission.begin({ name: "Drinks" })).toBe("key-1");
    submission.finish("failed");
    expect(submission.begin({ name: "Snacks" })).toBe("key-2");
    submission.finish("failed");
    expect(submission.begin({ name: "Snacks" })).toBe("key-2");
    submission.finish("keyReused");
    expect(submission.begin({ name: "Snacks" })).toBe("key-3");
    submission.finish("succeeded");
    expect(submission.begin({ name: "Snacks" })).toBe("key-4");
    submission.reset();
    expect(submission.inFlight).toBe(false);
    expect(submission.begin({ name: "Snacks" })).toBe("key-5");
  });
});
