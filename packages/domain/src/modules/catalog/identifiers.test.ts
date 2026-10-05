import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { isValidGtin, parseBarcode, parseSku, restoreBarcode, restoreSku } from "./index.js";

function expectInvalid(action: () => unknown, field: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("INVALID_VALUE");
    expect((error as DomainError).field).toBe(field);
    return;
  }
  throw new Error("expected INVALID_VALUE");
}

describe("SKU normalization (ADR-008 section 5.1)", () => {
  it("trims, collapses inner whitespace, keeps display case and upper-cases the key", () => {
    expect(parseSku("  pep-500ml \t x2 ")).toEqual({ value: "pep-500ml x2", normalized: "PEP-500ML X2" });
    expect(parseSku("A.B_C/D-1").normalized).toBe("A.B_C/D-1");
  });

  it("makes case-only variants of one SKU collide on the key", () => {
    expect(parseSku("rice-50kg").normalized).toBe(parseSku("RICE-50KG").normalized);
    expect(parseSku("rice-50kg").value).not.toBe(parseSku("RICE-50KG").value);
  });

  it("applies NFC before validating, so composed and decomposed forms are judged alike", () => {
    expectInvalid(() => parseSku("cafe\u0301"), "sku");
    expectInvalid(() => parseSku("caf\u00e9"), "sku");
  });

  it("enforces the 1 to 64 character boundary after normalization", () => {
    expect(parseSku("A").normalized).toBe("A");
    expect(parseSku("A".repeat(64)).normalized).toHaveLength(64);
    expectInvalid(() => parseSku("A".repeat(65)), "sku");
    expectInvalid(() => parseSku("   "), "sku");
    expectInvalid(() => parseSku(""), "sku");
  });

  it("rejects characters outside the allowed set", () => {
    for (const invalid of ["A#1", "A,B", "A+B", "A:B", "Ａ1", "A\u0000B", "\uD800"]) {
      expectInvalid(() => parseSku(invalid), "sku");
    }
  });

  it("restores only a stored pair that matches the contract", () => {
    expect(restoreSku("pep-1", "PEP-1").normalized).toBe("PEP-1");
    expectInvalid(() => restoreSku("pep-1", "pep-1"), "sku");
  });
});

describe("barcode normalization (ADR-008 section 5.2)", () => {
  it("normalizes valid GTIN-8, UPC-A (GTIN-12), EAN-13 and GTIN-14 to GTIN-14", () => {
    expect(parseBarcode("96385074")).toEqual({ value: "96385074", normalized: "00000096385074" });
    expect(parseBarcode("036000291452")).toEqual({ value: "036000291452", normalized: "00036000291452" });
    expect(parseBarcode("4006381333931")).toEqual({ value: "4006381333931", normalized: "04006381333931" });
    expect(parseBarcode("10036000291459")).toEqual({ value: "10036000291459", normalized: "10036000291459" });
  });

  it("makes equivalent forms of one GTIN normalize identically", () => {
    const keys = ["036000291452", "0036000291452", "00036000291452"].map((code) => parseBarcode(code).normalized);
    expect(new Set(keys).size).toBe(1);
    expect(parseBarcode("96385074").normalized).toBe(parseBarcode("000096385074").normalized);
  });

  it("keeps a GTIN-length code with a bad check digit as an ordinary merchant barcode", () => {
    expect(isValidGtin("036000291453")).toBe(false);
    expect(parseBarcode("036000291453")).toEqual({ value: "036000291453", normalized: "036000291453" });
    expect(parseBarcode("036000291453").normalized).not.toBe(parseBarcode("036000291452").normalized);
  });

  it("keeps all-digit codes of non-GTIN lengths unchanged", () => {
    expect(parseBarcode("12345").normalized).toBe("12345");
    expect(parseBarcode("0096385074").normalized).toBe("0096385074");
  });

  it("accepts letters and hyphens case-sensitively as merchant barcodes", () => {
    expect(parseBarcode("SHOP-001a").normalized).toBe("SHOP-001a");
    expect(parseBarcode("shop-001a").normalized).not.toBe(parseBarcode("SHOP-001A").normalized);
  });

  it("trims surrounding whitespace", () => {
    expect(parseBarcode("  4006381333931\n")).toEqual({ value: "4006381333931", normalized: "04006381333931" });
  });

  it("enforces the 1 to 64 character boundary", () => {
    expect(parseBarcode("1").normalized).toBe("1");
    expect(parseBarcode("A".repeat(64)).normalized).toHaveLength(64);
    expectInvalid(() => parseBarcode("A".repeat(65)), "barcode");
    expectInvalid(() => parseBarcode(""), "barcode");
    expectInvalid(() => parseBarcode("   "), "barcode");
  });

  it("rejects invalid syntax", () => {
    for (const invalid of ["400 638", "4006_381", "ABC.1", "é1", "１２３", "12/34"]) {
      expectInvalid(() => parseBarcode(invalid), "barcode");
    }
  });

  it("checks GTIN validity only for digit strings of GTIN lengths", () => {
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("9638507")).toBe(false);
    expect(isValidGtin("96385075")).toBe(false);
    expect(isValidGtin("A6385074")).toBe(false);
  });

  it("restores only a stored pair that matches the contract", () => {
    expect(restoreBarcode("036000291452", "00036000291452").normalized).toBe("00036000291452");
    expectInvalid(() => restoreBarcode("036000291452", "036000291452"), "barcode");
  });
});

/** A seeded linear congruential generator: the same cases on every run, no dependency. */
function seededIntegers(seed: bigint): () => number {
  let state = seed;
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % (2n ** 61n - 1n);
    return Number(state % 1_000_000n);
  };
}

/** Independent reference: GS1 mod-10 check digit, weights 3 and 1 from the right of the payload. */
function referenceCheckDigit(payload: string): string {
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const fromRight = payload.length - 1 - index;
    sum += Number(payload.charAt(index)) * (fromRight % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

describe("identifier generated cases (seeded, deterministic)", () => {
  const SKU_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ._/-";

  function generatedSku(next: () => number): string {
    const length = 1 + (next() % 40);
    let text = "A";
    for (let index = 1; index < length; index += 1) text += SKU_ALPHABET[next() % SKU_ALPHABET.length] ?? "A";
    return text;
  }

  it("SKU keys ignore case and surrounding or repeated whitespace, and normalization is idempotent", () => {
    const next = seededIntegers(41n);
    for (let index = 0; index < 500; index += 1) {
      const raw = generatedSku(next);
      const sku = parseSku(raw);
      expect(sku.normalized).toBe(sku.value.toUpperCase());
      expect(parseSku(sku.value)).toEqual(sku);
      expect(parseSku(raw.toLowerCase()).normalized).toBe(sku.normalized);
      expect(parseSku(` \t${raw.replaceAll(" ", "   ")}\n`).normalized).toBe(sku.normalized);
      expect(restoreSku(sku.value, sku.normalized)).toEqual(sku);
    }
  });

  it("every valid GTIN-8/12/13/14 becomes its GTIN-14 form, and zero-padded forms collide", () => {
    const next = seededIntegers(7n);
    for (let index = 0; index < 500; index += 1) {
      const length = [8, 12, 13, 14][next() % 4] ?? 13;
      let payload = "";
      for (let digit = 1; digit < length; digit += 1) payload += String(next() % 10);
      const code = payload + referenceCheckDigit(payload);
      expect(isValidGtin(code)).toBe(true);
      const barcode = parseBarcode(code);
      expect(barcode.normalized).toBe(code.padStart(14, "0"));
      expect(barcode.value).toBe(code);
      if (length < 14) expect(parseBarcode(code.padStart(14, "0")).normalized).toBe(barcode.normalized);
      expect(restoreBarcode(barcode.value, barcode.normalized)).toEqual(barcode);
    }
  });

  it("every GTIN-length code with a wrong check digit stays an ordinary, unchanged barcode", () => {
    const next = seededIntegers(13n);
    for (let index = 0; index < 500; index += 1) {
      const length = [8, 12, 13, 14][next() % 4] ?? 13;
      let payload = "";
      for (let digit = 1; digit < length; digit += 1) payload += String(next() % 10);
      const correct = Number(referenceCheckDigit(payload));
      const wrong = String((correct + 1 + (next() % 9)) % 10);
      const code = payload + wrong;
      expect(isValidGtin(code)).toBe(false);
      expect(parseBarcode(code)).toEqual({ value: code, normalized: code });
    }
  });
});
