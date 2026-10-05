import { describe, expect, it } from "vitest";
import { DomainError } from "../../errors.js";
import { KernelError, parseUnitCode } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import {
  archiveCategory,
  createCategory,
  createPack,
  createProduct,
  INITIAL_UNITS_OF_MEASURE,
  packEntryQuantity,
  parseCategoryName,
  parsePackFactor,
  parsePackName,
  parseProductCategoryId,
  parseProductId,
  parseProductName,
  parseProductPackId,
  parseProductVariantId,
  renameCategory,
  restoreCategory,
  restorePack,
  retirePack,
} from "./index.js";

const businessId = parseBusinessId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f");
const categoryId = parseProductCategoryId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e70");
const packId = parseProductPackId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e71");
const now = new Date("2026-10-05T10:00:00.000Z");
const later = new Date("2026-10-05T11:00:00.000Z");

function expectDomainError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
}

describe("initial units of measure", () => {
  it("seeds exactly the nine reviewed units with their kinds and scales", () => {
    expect(INITIAL_UNITS_OF_MEASURE.map((unit) => [unit.code, unit.kind, unit.scale])).toEqual([
      ["PIECE", "COUNT", 0],
      ["BOTTLE", "COUNT", 0],
      ["SACHET", "COUNT", 0],
      ["TIN", "COUNT", 0],
      ["PACK", "COUNT", 0],
      ["KG", "MASS", 3],
      ["G", "MASS", 0],
      ["L", "VOLUME", 3],
      ["ML", "VOLUME", 0],
    ]);
    expect(Object.isFrozen(INITIAL_UNITS_OF_MEASURE)).toBe(true);
  });
});

describe("ProductCategory", () => {
  it("creates ACTIVE at version 1 with a case-insensitive key", () => {
    const category = createCategory({ id: categoryId, businessId, name: parseCategoryName(" Drinks "), now });
    expect(category).toMatchObject({ name: "Drinks", normalizedName: "drinks", status: "ACTIVE", version: 1 });
    expect(parseCategoryName("x".repeat(60))).toHaveLength(60);
    expectDomainError(() => parseCategoryName("x".repeat(61)), "INVALID_VALUE");
  });

  it("renames with optimistic versioning; the same name is a no-op", () => {
    const category = createCategory({ id: categoryId, businessId, name: parseCategoryName("Drinks"), now });
    expect(
      renameCategory({ category, expectedVersion: 1, name: parseCategoryName("Drinks"), now: later }).outcome,
    ).toBe("unchanged");
    expectDomainError(
      () => renameCategory({ category, expectedVersion: 7, name: parseCategoryName("Drinks"), now: later }),
      "VERSION_CONFLICT",
    );
    const renamed = renameCategory({ category, expectedVersion: 1, name: parseCategoryName("DRINKS"), now: later });
    expect(renamed.category).toMatchObject({ name: "DRINKS", normalizedName: "drinks", version: 2 });
    expectDomainError(
      () => renameCategory({ category, expectedVersion: 2, name: parseCategoryName("Soft drinks"), now: later }),
      "VERSION_CONFLICT",
    );
  });

  it("archives once; archiving again is a no-op", () => {
    const category = createCategory({ id: categoryId, businessId, name: parseCategoryName("Drinks"), now });
    const archived = archiveCategory({ category, expectedVersion: 1, now: later });
    expect(archived.category).toMatchObject({ status: "ARCHIVED", version: 2 });
    expect(archiveCategory({ category: archived.category, expectedVersion: 2, now: later }).outcome).toBe("unchanged");
    expectDomainError(
      () => archiveCategory({ category: archived.category, expectedVersion: 1, now: later }),
      "VERSION_CONFLICT",
    );
    expect(restoreCategory({ ...archived.category })).toEqual(archived.category);
    expectDomainError(() => restoreCategory({ ...archived.category, status: "DELETED" }), "INVALID_VALUE");
  });
});

describe("ProductPack", () => {
  const variant = createProduct({
    id: parseProductId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e72"),
    variantId: parseProductVariantId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e73"),
    businessId,
    name: parseProductName("Coke 50cl"),
    stockUnit: parseUnitCode("BOTTLE"),
    trackInventory: true,
    createdByMembershipId: parseMembershipId("01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e74"),
    now,
  }).item.variant;

  it("bounds the factor to 2 through 10^9 bigint", () => {
    expect(parsePackFactor(2n)).toBe(2n);
    expect(parsePackFactor(1_000_000_000n)).toBe(1_000_000_000n);
    expectDomainError(() => parsePackFactor(1n), "INVALID_VALUE");
    expectDomainError(() => parsePackFactor(1_000_000_001n), "INVALID_VALUE");
    expectDomainError(() => parsePackFactor(24 as unknown as bigint), "INVALID_VALUE");
    expect(parsePackName("x".repeat(40))).toHaveLength(40);
    expectDomainError(() => parsePackName("x".repeat(41)), "INVALID_VALUE");
  });

  it("belongs to its variant's business and converts pack counts exactly", () => {
    const pack = createPack({ id: packId, variant, name: parsePackName("Crate of 24"), factorMinor: 24n, now });
    expect(pack).toMatchObject({ businessId, variantId: variant.id, factorMinor: 24n, status: "ACTIVE" });
    const quantity = packEntryQuantity({ pack, stockUnit: variant.stockUnit, packCount: 3n });
    expect(quantity.amountMinor).toBe(72n);
    expect(quantity.unit).toBe("BOTTLE");
    expectDomainError(() => packEntryQuantity({ pack, stockUnit: variant.stockUnit, packCount: 0n }), "INVALID_VALUE");
  });

  it("rejects conversions beyond the quantity bound instead of overflowing", () => {
    const pack = createPack({ id: packId, variant, name: parsePackName("Huge"), factorMinor: 1_000_000_000n, now });
    expect(() => packEntryQuantity({ pack, stockUnit: variant.stockUnit, packCount: 10_000_000n })).toThrow(
      KernelError,
    );
  });

  it("retires one-way; retired packs cannot be used for new entries", () => {
    const pack = createPack({ id: packId, variant, name: parsePackName("Crate of 24"), factorMinor: 24n, now });
    const retired = retirePack({ pack, now: later });
    expect(retired.pack.status).toBe("RETIRED");
    expect(retirePack({ pack: retired.pack, now: later }).outcome).toBe("unchanged");
    expectDomainError(
      () => packEntryQuantity({ pack: retired.pack, stockUnit: variant.stockUnit, packCount: 1n }),
      "INVALID_TRANSITION",
    );
    expect(restorePack({ ...retired.pack })).toEqual(retired.pack);
    expectDomainError(() => restorePack({ ...retired.pack, status: "ARCHIVED" }), "INVALID_VALUE");
  });
});
