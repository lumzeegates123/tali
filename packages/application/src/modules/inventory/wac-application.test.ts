import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { createInventoryHarness } from "../../testing/inventory-harness.js";

describe("application WAC (ADR-009 section 18)", () => {
  it("removes sequential write-offs with HALF_EVEN shares and last-unit exactness", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "3",
          unit: "PIECE",
          totalCost: { amountMinor: "1000", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.value.toMinorUnitsString()).toBe("667");
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.value.toMinorUnitsString()).toBe("333");
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE" }],
      reasonCode: "DAMAGED",
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.value.toMinorUnitsString()).toBe("0");
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("0");
  });

  it("allocates from fractional stock-unit quantities", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("NGN", 2)] });
    const mine = await h.businessWithRoles("Mine", "NGN");
    const rice = await h.product(mine.OWNER, { name: "Rice", stockUnit: "KG" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: rice.variant.id,
          decimal: "1.5",
          unit: "KG",
          totalCost: { amountMinor: "1500", currency: "NGN" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.recordWriteOff.execute(mine.OWNER, {
      lines: [{ variantId: rice.variant.id, decimal: "0.5", unit: "KG" }],
      reasonCode: "SPOILED",
      idempotencyKey: key(),
    });
    expect(h.inventory.valuations[0]?.value.toMinorUnitsString()).toBe("1000");
    expect(h.stock(mine.OWNER, rice.variant.id)).toBe("1000");
  });

  it("keeps large bigint values exact through a receipt then an adjustment", async () => {
    const h = createInventoryHarness({ currencies: [defineCurrency("JPY", 0)] });
    const mine = await h.businessWithRoles("Mine", "JPY");
    const soap = await h.product(mine.OWNER, { name: "Soap" });
    const key = () => h.catalog.tenancy.ids.newId("IdempotencyKey");
    await h.recordOpeningStock.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "2",
          unit: "PIECE",
          totalCost: { amountMinor: "1000000000000000", currency: "JPY" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.postGoodsReceipt.execute(mine.OWNER, {
      lines: [
        {
          variantId: soap.variant.id,
          quantityMinor: "1",
          unit: "PIECE",
          totalCost: { amountMinor: "1", currency: "JPY" },
        },
      ],
      idempotencyKey: key(),
    });
    await h.recordAdjustment.execute(mine.OWNER, {
      lines: [{ variantId: soap.variant.id, quantityMinor: "1", unit: "PIECE", direction: "DECREASE" }],
      reasonCode: "DATA_ENTRY_CORRECTION",
      idempotencyKey: key(),
    });
    const remaining = h.inventory.valuations[0]?.value.amountMinor;
    expect(typeof remaining).toBe("bigint");
    expect(h.stock(mine.OWNER, soap.variant.id)).toBe("2");
    expect(remaining).toBeGreaterThan(0n);
  });
});
