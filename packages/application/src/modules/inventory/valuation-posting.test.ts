import { defineCurrency, Money } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { explicitValuationKind, explicitValuationLines } from "./valuation-posting.js";
import { emptyInventoryValuation } from "@tali/domain";
import { parseLocationId, parseProductVariantId } from "@tali/domain";
import { parseBusinessId } from "@tali/domain";

const ngn = defineCurrency("NGN", 2);
const businessId = parseBusinessId("01900000-0000-7000-8000-000000000001");
const locationId = parseLocationId("01900000-0000-7000-8000-000000000002");
const variantId = parseProductVariantId("01900000-0000-7000-8000-000000000003");

function money(minor: bigint): Money {
  return Money.ofMinor(minor, ngn.code);
}

describe("explicit valuation posting (ADR-009 section 20)", () => {
  it("uses OPENING_BALANCE_EQUITY only for INITIAL_OPENING", () => {
    const never = emptyInventoryValuation({
      businessId,
      locationId,
      variantId,
      currency: ngn.code,
    });
    expect(explicitValuationKind(never)).toBe("INITIAL_OPENING");
    const increase = explicitValuationLines("INITIAL_OPENING", money(100n));
    expect(increase.map((line) => line.role)).toEqual(["INVENTORY", "OPENING_BALANCE_EQUITY"]);
    expect(() => explicitValuationLines("INITIAL_OPENING", money(-40n))).toThrow(
      /initial opening valuation cannot decrease recorded value/,
    );
  });

  it("posts operational increase to INVENTORY_GAIN and decrease to INVENTORY_SHRINKAGE (examples M and N)", () => {
    const increase = explicitValuationLines("OPERATIONAL", money(205_333n));
    expect(increase.map((line) => [line.role, line.direction])).toEqual([
      ["INVENTORY", "DEBIT"],
      ["INVENTORY_GAIN", "CREDIT"],
    ]);
    const decrease = explicitValuationLines("OPERATIONAL", money(-44_667n));
    expect(decrease.map((line) => [line.role, line.direction])).toEqual([
      ["INVENTORY_SHRINKAGE", "DEBIT"],
      ["INVENTORY", "CREDIT"],
    ]);
    expect(explicitValuationLines("OPERATIONAL", money(0n))).toEqual([]);
    expect(() => explicitValuationLines("REVERSAL_RESIDUAL", money(1n))).toThrow(
      /reversal residual is not an explicit stock valuation/,
    );
  });

  it("never uses OPENING_BALANCE_EQUITY for an operational valuation", () => {
    for (const difference of [money(1n), money(-1n), money(0n)]) {
      expect(
        explicitValuationLines("OPERATIONAL", difference).some((line) => line.role === "OPENING_BALANCE_EQUITY"),
      ).toBe(false);
    }
  });
});
