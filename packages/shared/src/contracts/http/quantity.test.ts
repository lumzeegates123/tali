import { describe, expect, it } from "vitest";
import { QuantityMinorStringSchema, QuantityWireSchema, UnitCodeWireSchema } from "./quantity.js";

describe("quantity wire contract", () => {
  it("accepts canonical signed integer strings up to 10^15 in absolute value", () => {
    for (const value of ["0", "1", "-1", "1500", "1000000000000000", "-1000000000000000"]) {
      expect(QuantityMinorStringSchema.parse(value)).toBe(value);
    }
  });

  it("rejects numbers, non-canonical forms, negative zero and out-of-range values without coercion", () => {
    for (const value of [
      1500,
      0,
      1.5,
      "-0",
      "01",
      "+1",
      "1.5",
      "1e3",
      " 1",
      "1 ",
      "",
      "-",
      "1000000000000001",
      "-1000000000000001",
      "99999999999999999",
      null,
      true,
    ]) {
      expect(QuantityMinorStringSchema.safeParse(value).success).toBe(false);
    }
  });

  it("unit codes are 1 to 16 uppercase letters", () => {
    for (const code of ["KG", "PIECE", "L", "A".repeat(16)]) expect(UnitCodeWireSchema.parse(code)).toBe(code);
    for (const code of ["", "kg", "Kg", "KG1", "K G", "A".repeat(17), "KG-", 1]) {
      expect(UnitCodeWireSchema.safeParse(code).success).toBe(false);
    }
  });

  it("the quantity object is strict and string-only", () => {
    expect(QuantityWireSchema.parse({ quantityMinor: "1500", unit: "KG" })).toEqual({
      quantityMinor: "1500",
      unit: "KG",
    });
    for (const body of [
      { quantityMinor: 1500, unit: "KG" },
      { quantityMinor: "1500" },
      { unit: "KG" },
      { quantityMinor: "1500", unit: "KG", scale: 3 },
      { quantityMinor: "1500", unit: "kg" },
    ]) {
      expect(QuantityWireSchema.safeParse(body).success).toBe(false);
    }
  });
});
