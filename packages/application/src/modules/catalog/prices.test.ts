import { defineCurrency } from "@tali/domain";
import { describe, expect, it } from "vitest";
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  VersionConflictError,
} from "../../errors/application-error.js";
import type { CatalogHarness } from "../../testing/catalog-harness.js";
import { createCatalogHarness } from "../../testing/catalog-harness.js";

const CURRENCIES = [
  defineCurrency("NGN", 2),
  defineCurrency("KES", 2),
  defineCurrency("JPY", 0),
  defineCurrency("KWD", 3),
];

async function setup(currencyCode = "NGN") {
  const h = createCatalogHarness({ currencies: CURRENCIES });
  const mine = await h.businessWithRoles("Mine", currencyCode);
  const theirs = await h.businessWithRoles("Theirs", "KES");
  const { item } = await h.createProduct.execute(mine.OWNER, {
    name: "Rice",
    stockUnit: "KG",
    trackInventory: true,
    idempotencyKey: h.tenancy.ids.newId("IdempotencyKey"),
  });
  return { h, mine, theirs, item };
}

function priceAudit(h: CatalogHarness) {
  return h.tenancy.auditWriter.businessRecords.filter((record) => record.action === "product.price_set");
}

function state(h: CatalogHarness) {
  return JSON.stringify({
    variants: h.catalog.products.map((item) => [
      item.product.version,
      item.variant.version,
      item.variant.priceVersion,
      item.variant.sellingPrice?.toMinorUnitsString(),
    ]),
    history: h.catalog.priceHistory.length,
    audit: h.tenancy.auditWriter.businessRecords.length,
  });
}

describe("SetSellingPrice", () => {
  it("sets the first price: one history row, priceVersion 1, versions incremented, audited", async () => {
    const { h, mine, item } = await setup();
    const result = await h.setSellingPrice.execute(mine.MANAGER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor: "150000", currency: "NGN" },
      reason: "launch price",
    });
    expect(result.changed).toBe(true);
    expect(result.item.variant).toMatchObject({ priceVersion: 1, version: 2 });
    expect(result.item.product.version).toBe(2);
    expect(result.item.variant.sellingPrice?.toMinorUnitsString()).toBe("150000");
    expect(h.catalog.priceHistory).toHaveLength(1);
    expect(h.catalog.priceHistory[0]).toMatchObject({ priceVersion: 1, reason: "launch price" });
    expect(priceAudit(h)).toHaveLength(1);
    expect(priceAudit(h)[0]).toMatchObject({
      entityType: "product",
      entityId: item.product.id,
      reason: "launch price",
      payload: { variantId: item.variant.id, toAmountMinor: "150000", currency: "NGN", priceVersion: 1 },
    });
    expect(priceAudit(h)[0]?.payload).not.toHaveProperty("fromAmountMinor");
  });

  it("appends exactly one row per real change with a gap-free priceVersion and from/to amounts", async () => {
    const { h, mine, item } = await setup();
    await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor: "100", currency: "NGN" },
    });
    const second = await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 2,
      price: { amountMinor: "120", currency: "NGN" },
    });
    expect(second.item.variant.priceVersion).toBe(2);
    expect(h.catalog.priceHistory.map((row) => [row.priceVersion, row.price.toMinorUnitsString()])).toEqual([
      [1, "100"],
      [2, "120"],
    ]);
    expect(priceAudit(h)[1]?.payload).toMatchObject({ fromAmountMinor: "100", toAmountMinor: "120", priceVersion: 2 });
  });

  it("A: the current price with the current expectedVersion is a no-op: no history, no version, no audit", async () => {
    const { h, mine, item } = await setup();
    await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor: "100", currency: "NGN" },
    });
    const before = state(h);
    const again = await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 2,
      price: { amountMinor: "100", currency: "NGN" },
    });
    expect(again.changed).toBe(false);
    expect(again.item.product.version).toBe(2);
    expect(again.item.variant.priceVersion).toBe(1);
    expect(state(h)).toBe(before);
  });

  it("B: the current price (NGN X at version N) with expectedVersion N-1 is VERSION_CONFLICT, not a no-op", async () => {
    const { h, mine, item } = await setup();
    await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor: "100", currency: "NGN" },
    });
    const before = state(h);
    const attempt = h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor: "100", currency: "NGN" },
    });
    await expect(attempt).rejects.toThrow(VersionConflictError);
    await expect(attempt).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(state(h)).toBe(before);
  });

  it("C: rejects a stale expectedVersion for a real change", async () => {
    const { h, mine, item } = await setup();
    await h.updateProduct.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, name: "Rice 50kg" });
    const before = state(h);
    await expect(
      h.setSellingPrice.execute(mine.OWNER, {
        productId: item.product.id,
        expectedVersion: 1,
        price: { amountMinor: "100", currency: "NGN" },
      }),
    ).rejects.toThrow(VersionConflictError);
    expect(state(h)).toBe(before);
  });

  it.each(["STOCK_KEEPER", "CASHIER", "ACCOUNTANT"] as const)("denies %s (no product:price)", async (role) => {
    const { h, mine, item } = await setup();
    const before = state(h);
    await expect(
      h.setSellingPrice.execute(mine[role], {
        productId: item.product.id,
        expectedVersion: 1,
        price: { amountMinor: "100", currency: "NGN" },
      }),
    ).rejects.toThrow(PermissionDeniedError);
    expect(state(h)).toBe(before);
  });

  it("returns NOT_FOUND for another business's product without writing", async () => {
    const { h, theirs, item } = await setup();
    const before = state(h);
    await expect(
      h.setSellingPrice.execute(theirs.OWNER, {
        productId: item.product.id,
        expectedVersion: 1,
        price: { amountMinor: "100", currency: "KES" },
      }),
    ).rejects.toThrow(NotFoundError);
    expect(state(h)).toBe(before);
  });

  it.each([
    ["zero", { amountMinor: "0", currency: "NGN" }],
    ["negative", { amountMinor: "-100", currency: "NGN" }],
    ["decimal text", { amountMinor: "1.50", currency: "NGN" }],
    ["a leading zero", { amountMinor: "0100", currency: "NGN" }],
    ["a JavaScript number", { amountMinor: 100 as unknown as string, currency: "NGN" }],
    ["above BIGINT", { amountMinor: "9223372036854775808", currency: "NGN" }],
    ["another currency", { amountMinor: "100", currency: "KES" }],
    ["a malformed currency", { amountMinor: "100", currency: "ngn" }],
  ])("rejects a %s price with VALIDATION_FAILED and writes nothing", async (_label, price) => {
    const { h, mine, item } = await setup();
    const before = state(h);
    await expect(
      h.setSellingPrice.execute(mine.OWNER, { productId: item.product.id, expectedVersion: 1, price }),
    ).rejects.toThrow(ValidationError);
    expect(state(h)).toBe(before);
  });

  it("accepts the BIGINT ceiling exactly", async () => {
    const { h, mine, item } = await setup();
    const result = await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor: "9223372036854775807", currency: "NGN" },
    });
    expect(priceAudit(h)[0]?.payload["toAmountMinor"]).toBe("9223372036854775807");
    expect(result.item.variant.sellingPrice?.amountMinor).toBe(9_223_372_036_854_775_807n);
  });
});

describe("selling prices in other currencies (never NGN-specific)", () => {
  it.each([
    ["KES", "2 decimals", "15050"],
    ["JPY", "0 decimals", "1500"],
    ["KWD", "3 decimals", "1250"],
  ])("prices a %s business (%s) in its own currency only", async (currency, _exponent, amountMinor) => {
    const { h, mine, item } = await setup(currency);
    const result = await h.setSellingPrice.execute(mine.OWNER, {
      productId: item.product.id,
      expectedVersion: 1,
      price: { amountMinor, currency },
    });
    expect(result.item.variant.sellingPrice?.currency).toBe(currency);
    expect(priceAudit(h)[0]?.payload).toMatchObject({ currency, toAmountMinor: amountMinor });
    await expect(
      h.setSellingPrice.execute(mine.OWNER, {
        productId: item.product.id,
        expectedVersion: 2,
        price: { amountMinor, currency: "NGN" },
      }),
    ).rejects.toThrow(ValidationError);
    expect(h.catalog.priceHistory).toHaveLength(1);
  });

  it("creates a product with an initial price in a non-NGN business", async () => {
    const h = createCatalogHarness({ currencies: CURRENCIES });
    const mine = await h.businessWithRoles("Shop", "JPY");
    const { item } = await h.createProduct.execute(mine.OWNER, {
      name: "Tea",
      stockUnit: "PIECE",
      trackInventory: true,
      initialPrice: { amountMinor: "300", currency: "JPY" },
      idempotencyKey: h.tenancy.ids.newId("IdempotencyKey"),
    });
    expect(item.variant.sellingPrice?.currency).toBe("JPY");
    await expect(
      h.createProduct.execute(mine.OWNER, {
        name: "Tea",
        stockUnit: "PIECE",
        trackInventory: true,
        initialPrice: { amountMinor: "300", currency: "NGN" },
        idempotencyKey: h.tenancy.ids.newId("IdempotencyKey"),
      }),
    ).rejects.toThrow(ValidationError);
  });
});
