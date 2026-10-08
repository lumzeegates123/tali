import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { Money, parseCurrencyCode, parseUnitCode } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import type { CatalogProduct, VariantInventoryState } from "./index.js";
import {
  archiveProduct,
  createProduct,
  parseBarcode,
  parseCatalogChangeReason,
  parseProductCategoryId,
  parseProductDescription,
  parseProductId,
  parseProductName,
  parseProductVariantId,
  parseProductVariantPriceId,
  parseSku,
  reactivateProduct,
  restoreCatalogProduct,
  restoreProductVariantPrice,
  setSellingPrice,
  updateProduct,
} from "./index.js";

const businessId = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const membershipId = parseMembershipId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e60");
const productId = parseProductId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e61");
const variantId = parseProductVariantId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e62");
const categoryId = parseProductCategoryId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e63");
const priceId1 = parseProductVariantPriceId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e64");
const priceId2 = parseProductVariantPriceId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e65");
const NGN = parseCurrencyCode("NGN");
const KES = parseCurrencyCode("KES");
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const now = new Date("2026-10-05T10:00:00.000Z");
const later = new Date("2026-10-05T11:00:00.000Z");
const noInventory: VariantInventoryState = {
  hasMovements: false,
  hasNonZeroBalance: false,
  hasConfiguredThreshold: false,
};

function expectDomainError(action: () => unknown, code: string, field?: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (field !== undefined) expect((error as DomainError).field).toBe(field);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
}

function newProduct(overrides: Partial<Parameters<typeof createProduct>[0]> = {}): CatalogProduct {
  return createProduct({
    id: productId,
    variantId,
    businessId,
    name: parseProductName("Peak Milk 400g"),
    stockUnit: PIECE,
    trackInventory: true,
    createdByMembershipId: membershipId,
    now,
    ...overrides,
  }).item;
}

describe("createProduct", () => {
  it("always creates exactly one hidden default variant with the product", () => {
    const item = newProduct({ sku: parseSku("pk-400"), barcode: parseBarcode("4006381333931") });
    expect(item.product).toMatchObject({ businessId, name: "Peak Milk 400g", status: "ACTIVE", version: 1 });
    expect(item.variant).toMatchObject({
      businessId,
      productId,
      isDefault: true,
      status: "ACTIVE",
      stockUnit: "PIECE",
      trackInventory: true,
      priceVersion: 0,
      version: 1,
    });
    expect(item.variant.sku?.normalized).toBe("PK-400");
    expect(item.variant.barcode?.normalized).toBe("04006381333931");
    expect(item.variant.sellingPrice).toBeUndefined();
    expect(Object.isFrozen(item.product) && Object.isFrozen(item.variant)).toBe(true);
  });

  it("creates the first price history row when an initial price is given", () => {
    const result = createProduct({
      id: productId,
      variantId,
      businessId,
      name: parseProductName("Rice"),
      stockUnit: KG,
      trackInventory: true,
      initialPrice: { id: priceId1, price: Money.ofMinor(150_000n, NGN), businessCurrency: NGN },
      createdByMembershipId: membershipId,
      now,
    });
    expect(result.item.variant.priceVersion).toBe(1);
    expect(result.item.variant.sellingPrice?.amountMinor).toBe(150_000n);
    expect(result.priceEntry).toMatchObject({
      id: priceId1,
      variantId,
      priceVersion: 1,
      setByMembershipId: membershipId,
    });
  });

  it("rejects a non-positive price or one in another currency", () => {
    const base = { id: productId, variantId, businessId, name: parseProductName("Rice"), stockUnit: KG };
    const create = (price: Money) =>
      createProduct({
        ...base,
        trackInventory: true,
        initialPrice: { id: priceId1, price, businessCurrency: NGN },
        createdByMembershipId: membershipId,
        now,
      });
    expectDomainError(() => create(Money.ofMinor(0n, NGN)), "INVALID_VALUE", "amountMinor");
    expectDomainError(() => create(Money.ofMinor(-1n, NGN)), "INVALID_VALUE", "amountMinor");
    expectDomainError(() => create(Money.ofMinor(100n, KES)), "INVALID_VALUE", "currency");
  });

  it("normalizes names and validates descriptions", () => {
    expect(parseProductName("  Cafe\u0301 Mix ")).toBe("Caf\u00e9 Mix");
    expectDomainError(() => parseProductName("   "), "INVALID_VALUE", "name");
    expectDomainError(() => parseProductName("x".repeat(121)), "INVALID_VALUE", "name");
    expect(parseProductName("x".repeat(120))).toHaveLength(120);
    expect(parseProductDescription("<b>not markup</b>")).toBe("<b>not markup</b>");
    expectDomainError(() => parseProductDescription("x".repeat(501)), "INVALID_VALUE", "description");
    expectDomainError(() => parseProductDescription("  "), "INVALID_VALUE", "description");
  });
});

describe("updateProduct", () => {
  it("checks expectedVersion first; a matching request that describes the current state is a no-op", () => {
    const item = newProduct({ sku: parseSku("PK-400") });
    const sameState = { name: parseProductName("Peak Milk 400g"), sku: parseSku("PK-400"), stockUnit: PIECE };
    const result = updateProduct({
      item,
      expectedVersion: 1,
      update: sameState,
      inventory: noInventory,
      hasActivePacks: false,
      now: later,
    });
    expect(result.outcome).toBe("unchanged");
    expect(result.item).toBe(item);
    expectDomainError(
      () =>
        updateProduct({
          item,
          expectedVersion: 99,
          update: sameState,
          inventory: noInventory,
          hasActivePacks: false,
          now: later,
        }),
      "VERSION_CONFLICT",
    );
  });

  it("applies a real change, bumps the product version and reports what changed", () => {
    const item = newProduct();
    const result = updateProduct({
      item,
      expectedVersion: 1,
      update: { name: parseProductName("Peak Milk 380g"), categoryId, description: parseProductDescription("Tin") },
      inventory: noInventory,
      hasActivePacks: false,
      now: later,
    });
    if (result.outcome !== "changed") throw new Error("expected change");
    expect(result.item.product).toMatchObject({ name: "Peak Milk 380g", categoryId, description: "Tin", version: 2 });
    expect(result.item.variant).toBe(item.variant);
    expect(result.changes).toEqual({
      name: true,
      description: true,
      category: true,
      sku: false,
      barcode: false,
      stockUnit: false,
      trackInventory: false,
    });
  });

  it("bumps both versions when variant fields change, and clears optional fields with null", () => {
    const item = newProduct({ sku: parseSku("A-1"), barcode: parseBarcode("SHOP-1") });
    const result = updateProduct({
      item,
      expectedVersion: 1,
      update: { sku: null, barcode: parseBarcode("96385074"), stockUnit: KG, trackInventory: false },
      inventory: noInventory,
      hasActivePacks: false,
      now: later,
    });
    if (result.outcome !== "changed") throw new Error("expected change");
    expect(result.item.product.version).toBe(2);
    expect(result.item.variant.version).toBe(2);
    expect(result.item.variant.sku).toBeUndefined();
    expect(result.item.variant.barcode?.normalized).toBe("00000096385074");
    expect(result.item.variant).toMatchObject({ stockUnit: "KG", trackInventory: false });
  });

  it("rejects a stale expectedVersion for a real change", () => {
    expectDomainError(
      () =>
        updateProduct({
          item: newProduct(),
          expectedVersion: 2,
          update: { name: parseProductName("Other") },
          inventory: noInventory,
          hasActivePacks: false,
          now: later,
        }),
      "VERSION_CONFLICT",
      "expectedVersion",
    );
  });

  it("guards the stock unit once movements exist and tracking while a balance is non-zero", () => {
    const item = newProduct();
    expectDomainError(
      () =>
        updateProduct({
          item,
          expectedVersion: 1,
          update: { stockUnit: KG },
          inventory: { ...noInventory, hasMovements: true },
          hasActivePacks: false,
          now: later,
        }),
      "INVALID_TRANSITION",
      "stockUnit",
    );
    expectDomainError(
      () =>
        updateProduct({
          item,
          expectedVersion: 1,
          update: { trackInventory: false },
          inventory: { ...noInventory, hasMovements: true, hasNonZeroBalance: true },
          hasActivePacks: false,
          now: later,
        }),
      "INVALID_TRANSITION",
      "trackInventory",
    );
    const untracked = updateProduct({
      item,
      expectedVersion: 1,
      update: { trackInventory: false },
      inventory: { ...noInventory, hasMovements: true, hasConfiguredThreshold: true },
      hasActivePacks: false,
      now: later,
    });
    expect(untracked.item.variant.trackInventory).toBe(false);
  });

  it("rejects a stock-unit change while a low-stock threshold is configured, and allows it once cleared", () => {
    const item = newProduct();
    const change =
      (inventory: VariantInventoryState, hasActivePacks = false) =>
      () =>
        updateProduct({ item, expectedVersion: 1, update: { stockUnit: KG }, inventory, hasActivePacks, now: later });
    expectDomainError(change({ ...noInventory, hasConfiguredThreshold: true }), "INVALID_TRANSITION", "stockUnit");
    expect(change({ ...noInventory, hasConfiguredThreshold: true }, true)).toThrow(
      "the stock unit cannot change while a low-stock threshold is configured",
    );
    expect(change({ ...noInventory, hasMovements: true, hasConfiguredThreshold: true })).toThrow(
      "the stock unit cannot change once inventory movements exist",
    );
    expect(change(noInventory)().item.variant.stockUnit).toBe(KG);
  });

  it("checks the version and the no-op before the threshold guard", () => {
    const item = newProduct();
    const inventory = { ...noInventory, hasConfiguredThreshold: true };
    expectDomainError(
      () =>
        updateProduct({
          item,
          expectedVersion: 2,
          update: { stockUnit: KG },
          inventory,
          hasActivePacks: false,
          now: later,
        }),
      "VERSION_CONFLICT",
      "expectedVersion",
    );
    const same = updateProduct({
      item,
      expectedVersion: 1,
      update: { stockUnit: item.variant.stockUnit },
      inventory,
      hasActivePacks: false,
      now: later,
    });
    expect(same.outcome).toBe("unchanged");
  });

  it("rejects a stock-unit change while an active pack is defined in the unit", () => {
    expectDomainError(
      () =>
        updateProduct({
          item: newProduct(),
          expectedVersion: 1,
          update: { stockUnit: KG },
          inventory: noInventory,
          hasActivePacks: true,
          now: later,
        }),
      "INVALID_TRANSITION",
      "stockUnit",
    );
  });

  it("treats a case-only SKU change as a real display change", () => {
    const item = newProduct({ sku: parseSku("pk-1") });
    const result = updateProduct({
      item,
      expectedVersion: 1,
      update: { sku: parseSku("PK-1") },
      inventory: noInventory,
      hasActivePacks: false,
      now: later,
    });
    expect(result.outcome).toBe("changed");
  });
});

describe("archive and reactivate", () => {
  it("changes product and default variant together and is idempotent", () => {
    const item = newProduct();
    const archived = archiveProduct({ item, expectedVersion: 1, now: later });
    if (archived.outcome !== "changed") throw new Error("expected change");
    expect(archived.item.product).toMatchObject({ status: "ARCHIVED", version: 2 });
    expect(archived.item.variant).toMatchObject({ status: "ARCHIVED", version: 2 });
    expect(archiveProduct({ item: archived.item, expectedVersion: 2, now: later }).outcome).toBe("unchanged");
    expectDomainError(
      () => archiveProduct({ item: archived.item, expectedVersion: 1, now: later }),
      "VERSION_CONFLICT",
    );
    expect(reactivateProduct({ item, expectedVersion: 1, now: later }).outcome).toBe("unchanged");
    expectDomainError(() => reactivateProduct({ item, expectedVersion: 2, now: later }), "VERSION_CONFLICT");
    const reactivated = reactivateProduct({ item: archived.item, expectedVersion: 2, now: later });
    expect(reactivated.item.product.status).toBe("ACTIVE");
    expect(reactivated.item.variant.status).toBe("ACTIVE");
    expectDomainError(
      () => reactivateProduct({ item: archived.item, expectedVersion: 1, now: later }),
      "VERSION_CONFLICT",
    );
  });
});

describe("setSellingPrice", () => {
  it("appends one history row with the next priceVersion on a real change", () => {
    const item = newProduct();
    const first = setSellingPrice({
      item,
      expectedVersion: 1,
      price: Money.ofMinor(50_000n, NGN),
      businessCurrency: NGN,
      priceId: priceId1,
      setByMembershipId: membershipId,
      now: later,
    });
    if (first.outcome !== "changed") throw new Error("expected change");
    expect(first.item.variant).toMatchObject({ priceVersion: 1, version: 2 });
    expect(first.item.product.version).toBe(2);
    expect(first.priceEntry).toMatchObject({ priceVersion: 1, variantId, businessId });

    const second = setSellingPrice({
      item: first.item,
      expectedVersion: 2,
      price: Money.ofMinor(55_000n, NGN),
      businessCurrency: NGN,
      priceId: priceId2,
      setByMembershipId: membershipId,
      reason: parseCatalogChangeReason("supplier increase"),
      now: later,
    });
    if (second.outcome !== "changed") throw new Error("expected change");
    expect(second.priceEntry).toMatchObject({ priceVersion: 2, reason: "supplier increase" });
    expect(second.item.variant.sellingPrice?.amountMinor).toBe(55_000n);
  });

  it("is a no-op for the current price at the current version; a stale version conflicts", () => {
    const priced = createProduct({
      id: productId,
      variantId,
      businessId,
      name: parseProductName("Rice"),
      stockUnit: KG,
      trackInventory: true,
      initialPrice: { id: priceId1, price: Money.ofMinor(100n, KES), businessCurrency: KES },
      createdByMembershipId: membershipId,
      now,
    }).item;
    const samePrice = {
      item: priced,
      price: Money.ofMinor(100n, KES),
      businessCurrency: KES,
      priceId: priceId2,
      setByMembershipId: membershipId,
      now: later,
    };
    const result = setSellingPrice({ ...samePrice, expectedVersion: priced.product.version });
    expect(result.outcome).toBe("unchanged");
    expect(result.item).toBe(priced);
    expectDomainError(
      () => setSellingPrice({ ...samePrice, expectedVersion: priced.product.version + 1 }),
      "VERSION_CONFLICT",
    );
  });

  it("rejects mixed currency, zero, negative and stale versions", () => {
    const item = newProduct();
    const attempt = (price: Money, expectedVersion = 1) =>
      setSellingPrice({
        item,
        expectedVersion,
        price,
        businessCurrency: NGN,
        priceId: priceId1,
        setByMembershipId: membershipId,
        now: later,
      });
    expectDomainError(() => attempt(Money.ofMinor(100n, KES)), "INVALID_VALUE", "currency");
    expectDomainError(() => attempt(Money.ofMinor(0n, NGN)), "INVALID_VALUE", "amountMinor");
    expectDomainError(() => attempt(Money.ofMinor(-5n, NGN)), "INVALID_VALUE", "amountMinor");
    expectDomainError(() => attempt(Money.ofMinor(2n ** 63n, NGN)), "INVALID_VALUE", "amountMinor");
    expectDomainError(() => attempt(Money.ofMinor(100n, NGN), 3), "VERSION_CONFLICT");
  });
});

describe("restore", () => {
  it("round-trips a stored product and rejects broken pairing invariants", () => {
    const item = newProduct({ sku: parseSku("pk-1"), barcode: parseBarcode("036000291452") });
    const stored = {
      product: { ...item.product },
      variant: {
        ...item.variant,
        sku: { value: "pk-1", normalized: "PK-1" },
        barcode: { value: "036000291452", normalized: "00036000291452" },
      },
    };
    expect(restoreCatalogProduct(stored)).toEqual(item);
    expectDomainError(
      () => restoreCatalogProduct({ ...stored, variant: { ...stored.variant, status: "ARCHIVED" } }),
      "INVALID_VALUE",
      "status",
    );
    expectDomainError(
      () => restoreCatalogProduct({ ...stored, variant: { ...stored.variant, isDefault: false } }),
      "INVALID_VALUE",
      "variant",
    );
    expectDomainError(
      () => restoreCatalogProduct({ ...stored, variant: { ...stored.variant, priceVersion: 1 } }),
      "INVALID_VALUE",
      "priceVersion",
    );
  });

  it("restores a price history row", () => {
    const row = restoreProductVariantPrice({
      id: priceId1,
      businessId,
      variantId,
      price: Money.ofMinor(5n, NGN),
      priceVersion: 1,
      effectiveAt: now,
      setByMembershipId: membershipId,
    });
    expect(row.priceVersion).toBe(1);
    expectDomainError(
      () =>
        restoreProductVariantPrice({
          id: priceId1,
          businessId,
          variantId,
          price: Money.ofMinor(5n, NGN),
          priceVersion: 0,
          effectiveAt: now,
          setByMembershipId: membershipId,
        }),
      "INVALID_VALUE",
      "priceVersion",
    );
  });
});
