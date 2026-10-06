import {
  AuditRecorder,
  type BusinessContext,
  ConcurrentModificationError,
  ConflictError,
  createArchiveProduct,
  createCreateProduct,
  createReactivateProduct,
  KeyedIdempotency,
  type TransactionScope,
  taliAuditRegistry,
} from "@tali/application";
import {
  archiveCategory,
  archiveProduct,
  type BusinessId,
  type CatalogProduct,
  type CurrencyCode,
  createCategory,
  createPack,
  createProduct,
  defineUnit,
  INITIAL_UNITS_OF_MEASURE,
  type MembershipId,
  Money,
  parseBarcode,
  parseCategoryName,
  parsePackName,
  parseProductDescription,
  parseProductName,
  parseSku,
  parseUnitCode,
  type ProductCategoryId,
  type ProductVariant,
  reactivateProduct,
  renameCategory,
  retirePack,
  setSellingPrice,
  updateProduct,
} from "@tali/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { delay, gate } from "../support/harness.js";
import { sqlState } from "../support/pg.js";
import { useTenancyHarness } from "../support/tenancy.js";

const LOCK_NOT_AVAILABLE = "55P03";
const NO_INVENTORY = { hasMovements: false, hasNonZeroBalance: false } as const;

interface Tenant {
  readonly businessId: BusinessId;
  readonly membershipId: MembershipId;
  readonly currency: CurrencyCode;
  readonly context: BusinessContext;
}

/** The normalized SKU and barcode of a fixture that has both. */
function keysOf(item: CatalogProduct) {
  const sku = item.variant.sku?.normalized;
  const barcode = item.variant.barcode?.normalized;
  if (sku === undefined || barcode === undefined) throw new Error("fixture has a SKU and a barcode");
  return { sku, barcode };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

/**
 * The PostgreSQL catalog adapters (Build 2 Slice 2; ADR-008 sections 3, 4.2,
 * 5 and 9) against the migrated test database, as the application role:
 * roundtrips through the domain restore functions, tenant-scoped lookups,
 * optimistic updates, row locks, unique-race translation to ConflictError,
 * concurrent races in independent transactions, and the barcode lifecycle
 * through the Slice 1 use cases. Business A uses NGN and business B KES.
 */
describe("catalog repositories (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const repos = harness.repositories;
  let a: Tenant;
  let b: Tenant;

  beforeEach(async () => {
    const tenancy = harness.compose();
    const tenant = async (subject: string, currencyCode: string): Promise<Tenant> => {
      const user = await tenancy.registeredUser(subject);
      const { result } = await tenancy.create(user, { currencyCode });
      return {
        businessId: result.business.id,
        membershipId: result.membership.id,
        currency: result.business.currencyCode,
        context: await tenancy.contextFor(user, result.business.id),
      };
    };
    a = await tenant("catalog-owner-a", "NGN");
    b = await tenant("catalog-owner-b", "KES");
  });

  const ids = () => harness.world().ids;
  const now = () => harness.world().clock.now();
  const run = <T>(work: (scope: TransactionScope) => Promise<T>) => harness.unitOfWork.run(work);
  const count = async (sql: string, params: readonly unknown[] = []) =>
    Number((await harness.owner.query<{ n: string }>(sql, [...params])).rows[0]?.n);

  interface ProductOptions {
    readonly name?: string;
    readonly description?: string;
    readonly categoryId?: ProductCategoryId;
    readonly sku?: string;
    readonly barcode?: string;
    readonly stockUnit?: string;
    readonly priceMinor?: bigint;
  }

  function newProduct(t: Tenant, options: ProductOptions = {}) {
    return createProduct({
      id: ids().newId("Product"),
      variantId: ids().newId("ProductVariant"),
      businessId: t.businessId,
      name: parseProductName(options.name ?? "Peak Milk 400g"),
      ...(options.description === undefined ? {} : { description: parseProductDescription(options.description) }),
      ...(options.categoryId === undefined ? {} : { categoryId: options.categoryId }),
      ...(options.sku === undefined ? {} : { sku: parseSku(options.sku) }),
      ...(options.barcode === undefined ? {} : { barcode: parseBarcode(options.barcode) }),
      stockUnit: parseUnitCode(options.stockUnit ?? "PIECE"),
      trackInventory: true,
      ...(options.priceMinor === undefined
        ? {}
        : {
            initialPrice: {
              id: ids().newId("ProductVariantPrice"),
              price: Money.ofMinor(options.priceMinor, t.currency),
              businessCurrency: t.currency,
            },
          }),
      createdByMembershipId: t.membershipId,
      now: now(),
    });
  }

  async function savedProduct(t: Tenant, options: ProductOptions = {}): Promise<CatalogProduct> {
    const created = newProduct(t, options);
    await run(async (scope) => {
      await repos.products.insert(scope, created.item);
      if (created.priceEntry !== undefined) await repos.productPriceHistory.append(scope, created.priceEntry);
    });
    return created.item;
  }

  const loadProduct = (t: Tenant, item: CatalogProduct) =>
    run((scope) => repos.products.findByIdForUpdate(scope, t.businessId, item.product.id));

  function newCategory(t: Tenant, name = "Drinks") {
    return createCategory({
      id: ids().newId("ProductCategory"),
      businessId: t.businessId,
      name: parseCategoryName(name),
      now: now(),
    });
  }

  function newPack(variant: ProductVariant, name = "Carton", factor = 24n) {
    return createPack({
      id: ids().newId("ProductPack"),
      variant,
      name: parsePackName(name),
      factorMinor: factor,
      now: now(),
    });
  }

  describe("products", () => {
    it("round-trips a product with every optional field, and one with none", async () => {
      const category = newCategory(a);
      await run((scope) => repos.productCategories.insert(scope, category));
      const full = await savedProduct(a, {
        description: "Full cream evaporated milk",
        categoryId: category.id,
        sku: "milk-400",
        barcode: "4006381333931",
        stockUnit: "TIN",
        priceMinor: 150_000n,
      });
      expect(await loadProduct(a, full)).toEqual(full);
      const bare = await savedProduct(a, { name: "Loose rice", stockUnit: "KG" });
      expect(await loadProduct(a, bare)).toEqual(bare);
      expect((await loadProduct(a, bare))?.variant.sellingPrice).toBe(undefined);
    });

    it("finds variants by SKU key and ACTIVE barcode key within the business only", async () => {
      const item = await savedProduct(a, { sku: "Milk-400", barcode: "96385074" });
      const sku = item.variant.sku?.normalized;
      const barcode = item.variant.barcode?.normalized;
      if (sku === undefined || barcode === undefined) throw new Error("fixture has a SKU and a barcode");
      expect(barcode).toBe("00000096385074");
      await run(async (scope) => {
        expect(await repos.products.findVariantIdBySku(scope, a.businessId, sku)).toBe(item.variant.id);
        expect(await repos.products.findActiveVariantIdByBarcode(scope, a.businessId, barcode)).toBe(item.variant.id);
        expect(await repos.products.findVariantIdBySku(scope, b.businessId, sku)).toBe(undefined);
        expect(await repos.products.findActiveVariantIdByBarcode(scope, b.businessId, barcode)).toBe(undefined);
        expect(await repos.products.findByIdForUpdate(scope, b.businessId, item.product.id)).toBe(undefined);
      });
      const inB = await savedProduct(b, { sku: "Milk-400", barcode: "96385074" });
      expect(await loadProduct(b, inB)).toEqual(inB);
    });

    it("an edit of product fields only leaves the variant row alone; a variant edit bumps both", async () => {
      const item = await savedProduct(a, { sku: "RICE-1" });
      const renamed = updateProduct({
        item,
        expectedVersion: 1,
        update: { name: parseProductName("Rice 1kg") },
        inventory: NO_INVENTORY,
        hasActivePacks: false,
        now: now(),
      });
      if (renamed.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.products.update(scope, item, renamed.item));
      const afterRename = await loadProduct(a, item);
      expect(afterRename).toEqual(renamed.item);
      expect(afterRename?.variant.version).toBe(1);

      const reunited = updateProduct({
        item: renamed.item,
        expectedVersion: 2,
        update: { sku: parseSku("RICE-2"), stockUnit: parseUnitCode("KG"), description: null },
        inventory: NO_INVENTORY,
        hasActivePacks: false,
        now: now(),
      });
      if (reunited.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.products.update(scope, renamed.item, reunited.item));
      const after = await loadProduct(a, item);
      expect(after).toEqual(reunited.item);
      expect({ product: after?.product.version, variant: after?.variant.version }).toEqual({ product: 3, variant: 2 });
    });

    it("setting a price updates the denormalized current price and appends one history row", async () => {
      const item = await savedProduct(a, { priceMinor: 100n });
      const priced = setSellingPrice({
        item,
        expectedVersion: 1,
        price: Money.ofMinor(9_223_372_036_854_775_807n, a.currency),
        businessCurrency: a.currency,
        priceId: ids().newId("ProductVariantPrice"),
        setByMembershipId: a.membershipId,
        now: now(),
      });
      if (priced.outcome !== "changed") throw new Error("expected a change");
      await run(async (scope) => {
        await repos.products.update(scope, item, priced.item);
        await repos.productPriceHistory.append(scope, priced.priceEntry);
      });
      expect(await loadProduct(a, item)).toEqual(priced.item);
      const { rows } = await harness.owner.query<{ amount: string; currency: string; version: number }>(
        `SELECT amount_minor::text AS amount, currency, price_version AS version FROM product_variant_prices
         WHERE business_id = $1 AND variant_id = $2 ORDER BY price_version`,
        [a.businessId, item.variant.id],
      );
      expect(rows).toEqual([
        { amount: "100", currency: "NGN", version: 1 },
        { amount: "9223372036854775807", currency: "NGN", version: 2 },
      ]);
    });

    it("archiving releases the barcode for ACTIVE lookups but keeps the SKU reserved", async () => {
      const item = await savedProduct(a, { sku: "SOAP-1", barcode: "SOAP-1" });
      const archived = archiveProduct({ item, expectedVersion: 1, now: now() });
      if (archived.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.products.update(scope, item, archived.item));
      await run(async (scope) => {
        const { sku, barcode } = keysOf(archived.item);
        expect(await repos.products.findActiveVariantIdByBarcode(scope, a.businessId, barcode)).toBe(undefined);
        expect(await repos.products.findVariantIdBySku(scope, a.businessId, sku)).toBe(item.variant.id);
      });
      const reloaded = await loadProduct(a, item);
      expect({ product: reloaded?.product.status, variant: reloaded?.variant.status }).toEqual({
        product: "ARCHIVED",
        variant: "ARCHIVED",
      });
    });

    it("an update from a stale version is ConcurrentModificationError and changes nothing", async () => {
      const item = await savedProduct(a);
      const first = archiveProduct({ item, expectedVersion: 1, now: now() });
      if (first.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.products.update(scope, item, first.item));
      const stale = updateProduct({
        item,
        expectedVersion: 1,
        update: { name: parseProductName("Lost update") },
        inventory: NO_INVENTORY,
        hasActivePacks: false,
        now: now(),
      });
      if (stale.outcome !== "changed") throw new Error("expected a change");
      expect(await rejection(run((scope) => repos.products.update(scope, item, stale.item)))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      expect(await loadProduct(a, item)).toEqual(first.item);
    });

    it("refuses transitions that break identity or change the variant without a version bump", async () => {
      const item = await savedProduct(a);
      const skipped = { ...item, product: { ...item.product, version: 3 } };
      await expect(run((scope) => repos.products.update(scope, item, skipped))).rejects.toThrow(
        "advance its version by one",
      );
      const silent = {
        product: { ...item.product, version: 2 },
        variant: { ...item.variant, trackInventory: false },
      };
      await expect(run((scope) => repos.products.update(scope, item, silent))).rejects.toThrow(
        "must advance the variant version",
      );
      expect(await loadProduct(a, item)).toEqual(item);
    });

    it("round-trips exactly one hidden default variant; the schema refuses any other variant row", async () => {
      const item = await savedProduct(a, { sku: "ONE-1" });
      const loaded = await loadProduct(a, item);
      expect(loaded).toEqual(item);
      expect(loaded?.variant).toMatchObject({ id: item.variant.id, productId: item.product.id, isDefault: true });
      const { rows } = await harness.owner.query<{ id: string; is_default: boolean }>(
        `SELECT id::text, is_default FROM product_variants WHERE business_id = $1 AND product_id = $2`,
        [a.businessId, item.product.id],
      );
      expect(rows).toEqual([{ id: item.variant.id, is_default: true }]);
      const insertVariant = (isDefault: boolean) =>
        harness.owner.query(
          `INSERT INTO product_variants (business_id, id, product_id, is_default, status, stock_unit_code,
             track_inventory, price_version, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'ACTIVE', 'PIECE', true, 0, 1, now(), now())`,
          [a.businessId, ids().newId("ProductVariant"), item.product.id, isDefault],
        );
      expect(await sqlState(insertVariant(false))).toBe("23514");
      expect(await sqlState(insertVariant(true))).toBe("23505");
      expect(await loadProduct(a, item)).toEqual(item);
    });

    it("fails loudly when a stored product has no default variant", async () => {
      const productId = ids().newId("Product");
      await harness.owner.query(
        `INSERT INTO products (business_id, id, name, status, version, created_by_membership_id, created_at, updated_at)
         VALUES ($1, $2, 'Orphan', 'ACTIVE', 1, $3, now(), now())`,
        [a.businessId, productId, a.membershipId],
      );
      await expect(run((scope) => repos.products.findByIdForUpdate(scope, a.businessId, productId))).rejects.toThrow(
        "exactly one default variant",
      );
    });

    it("locks the product and its variant until the transaction ends", async () => {
      const item = await savedProduct(a);
      const locked = gate();
      const release = gate();
      const holder = run(async (scope) => {
        await repos.products.findByIdForUpdate(scope, a.businessId, item.product.id);
        locked.open();
        await release.opened;
      });
      await locked.opened;
      const quick = harness.unitOfWorkWith({ lockTimeoutMs: 200 });
      expect(
        await rejection(quick.run((scope) => repos.products.findByIdForUpdate(scope, a.businessId, item.product.id))),
      ).toBeInstanceOf(ConcurrentModificationError);
      expect(
        await sqlState(
          harness.owner.query(`SELECT id FROM product_variants WHERE id = $1 FOR UPDATE NOWAIT`, [item.variant.id]),
        ),
      ).toBe(LOCK_NOT_AVAILABLE);
      const other = await savedProduct(a, { name: "Other" });
      await expect(
        quick.run((scope) => repos.products.findByIdForUpdate(scope, a.businessId, other.product.id)),
      ).resolves.toEqual(other);
      release.open();
      await holder;
    });

    it("a lost SKU or ACTIVE-barcode race is ConflictError; nothing is written", async () => {
      const holder = await savedProduct(a, { sku: "TEA-1", barcode: "TEA-BAR" });
      const duplicateSku = newProduct(a, { sku: "tea-1" }).item;
      const duplicateBarcode = newProduct(a, { barcode: "TEA-BAR" }).item;
      for (const [duplicate, message] of [
        [duplicateSku, "This SKU is already used by another product"],
        [duplicateBarcode, "This barcode is already used by another active product"],
      ] as const) {
        const failure = await rejection(run((scope) => repos.products.insert(scope, duplicate)));
        expect(failure).toBeInstanceOf(ConflictError);
        expect((failure as ConflictError).message).toBe(message);
        expect(await count(`SELECT count(*) AS n FROM products WHERE id = $1`, [duplicate.product.id])).toBe(0);
      }
      const other = await savedProduct(a, { name: "Other" });
      const taking = updateProduct({
        item: other,
        expectedVersion: 1,
        update: { sku: parseSku("TEA-1") },
        inventory: NO_INVENTORY,
        hasActivePacks: false,
        now: now(),
      });
      if (taking.outcome !== "changed") throw new Error("expected a change");
      expect(await rejection(run((scope) => repos.products.update(scope, other, taking.item)))).toBeInstanceOf(
        ConflictError,
      );
      expect(await loadProduct(a, other)).toEqual(other);
      expect(await loadProduct(a, holder)).toEqual(holder);
    });

    it("unrelated failures are not reported as conflicts", async () => {
      const item = await savedProduct(a);
      const samePrimaryKey = await rejection(run((scope) => repos.products.insert(scope, item)));
      expect(samePrimaryKey).not.toBeInstanceOf(ConflictError);
      const unknownUnit = await rejection(
        run((scope) => repos.products.insert(scope, newProduct(a, { stockUnit: "CARTON" }).item)),
      );
      expect(unknownUnit).not.toBeInstanceOf(ConflictError);
      const foreignMember = newProduct(b).item;
      const crossTenant = {
        product: { ...foreignMember.product, businessId: a.businessId },
        variant: { ...foreignMember.variant, businessId: a.businessId },
      };
      expect(await rejection(run((scope) => repos.products.insert(scope, crossTenant)))).not.toBeInstanceOf(
        ConflictError,
      );
      expect(await count(`SELECT count(*) AS n FROM products WHERE business_id = $1`, [a.businessId])).toBe(1);
    });
  });

  describe("price history", () => {
    it("is append-only: the adapter only appends and lists, and a duplicate version is ConflictError", async () => {
      expect(Object.keys(repos.productPriceHistory)).toEqual(["append", "listForVariant"]);
      const created = newProduct(a, { priceMinor: 500n });
      await run(async (scope) => {
        await repos.products.insert(scope, created.item);
        if (created.priceEntry !== undefined) await repos.productPriceHistory.append(scope, created.priceEntry);
      });
      const entry = created.priceEntry;
      if (entry === undefined) throw new Error("fixture has an initial price");
      const replay = { ...entry, id: ids().newId("ProductVariantPrice") };
      const failure = await rejection(run((scope) => repos.productPriceHistory.append(scope, replay)));
      expect(failure).toBeInstanceOf(ConflictError);
      expect((failure as ConflictError).message).toBe("The selling price was changed by another request");
      expect(
        await count(`SELECT count(*) AS n FROM product_variant_prices WHERE business_id = $1`, [a.businessId]),
      ).toBe(1);
    });
  });

  describe("categories", () => {
    it("round-trip, ACTIVE name lookup by key, and tenant scoping", async () => {
      const category = newCategory(a, "Soft Drinks");
      await run((scope) => repos.productCategories.insert(scope, category));
      await run(async (scope) => {
        expect(await repos.productCategories.findByIdForUpdate(scope, a.businessId, category.id)).toEqual(category);
        expect(await repos.productCategories.findActiveIdByName(scope, a.businessId, category.normalizedName)).toBe(
          category.id,
        );
        expect(await repos.productCategories.findByIdForUpdate(scope, b.businessId, category.id)).toBe(undefined);
        expect(await repos.productCategories.findActiveIdByName(scope, b.businessId, category.normalizedName)).toBe(
          undefined,
        );
      });
      await run((scope) => repos.productCategories.insert(scope, newCategory(b, "Soft Drinks")));
    });

    it("versioned rename and archive; a stale update is ConcurrentModificationError", async () => {
      const category = newCategory(a);
      await run((scope) => repos.productCategories.insert(scope, category));
      const renamed = renameCategory({
        category,
        expectedVersion: 1,
        name: parseCategoryName("Beverages"),
        now: now(),
      });
      if (renamed.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.productCategories.update(scope, category, renamed.category));
      const stale = archiveCategory({ category, expectedVersion: 1, now: now() });
      if (stale.outcome !== "changed") throw new Error("expected a change");
      expect(
        await rejection(run((scope) => repos.productCategories.update(scope, category, stale.category))),
      ).toBeInstanceOf(ConcurrentModificationError);
      const archived = archiveCategory({ category: renamed.category, expectedVersion: 2, now: now() });
      if (archived.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.productCategories.update(scope, renamed.category, archived.category));
      await run(async (scope) => {
        expect(await repos.productCategories.findByIdForUpdate(scope, a.businessId, category.id)).toEqual(
          archived.category,
        );
        expect(
          await repos.productCategories.findActiveIdByName(scope, a.businessId, archived.category.normalizedName),
        ).toBe(undefined);
      });
      await run((scope) => repos.productCategories.insert(scope, newCategory(a, "beverages")));
    });

    it("a lost ACTIVE-name race is ConflictError, on insert and on rename", async () => {
      await run((scope) => repos.productCategories.insert(scope, newCategory(a, "Snacks")));
      const failure = await rejection(run((scope) => repos.productCategories.insert(scope, newCategory(a, "SNACKS"))));
      expect(failure).toBeInstanceOf(ConflictError);
      expect((failure as ConflictError).message).toBe("An active category with this name already exists");
      const other = newCategory(a, "Sweets");
      await run((scope) => repos.productCategories.insert(scope, other));
      const clash = renameCategory({
        category: other,
        expectedVersion: 1,
        name: parseCategoryName("snacks"),
        now: now(),
      });
      if (clash.outcome !== "changed") throw new Error("expected a change");
      expect(
        await rejection(run((scope) => repos.productCategories.update(scope, other, clash.category))),
      ).toBeInstanceOf(ConflictError);
    });

    it("fails loudly when a stored name key does not match its name", async () => {
      const category = newCategory(a);
      await run((scope) => repos.productCategories.insert(scope, category));
      await harness.owner.query(`UPDATE product_categories SET normalized_name = 'other' WHERE id = $1`, [category.id]);
      await expect(
        run((scope) => repos.productCategories.findByIdForUpdate(scope, a.businessId, category.id)),
      ).rejects.toThrow("name key does not match");
    });

    it("locks the category until the transaction ends", async () => {
      const category = newCategory(a);
      await run((scope) => repos.productCategories.insert(scope, category));
      const locked = gate();
      const release = gate();
      const holder = run(async (scope) => {
        await repos.productCategories.findByIdForUpdate(scope, a.businessId, category.id);
        locked.open();
        await release.opened;
      });
      await locked.opened;
      expect(
        await sqlState(
          harness.owner.query(`SELECT id FROM product_categories WHERE id = $1 FOR UPDATE NOWAIT`, [category.id]),
        ),
      ).toBe(LOCK_NOT_AVAILABLE);
      release.open();
      await holder;
    });
  });

  describe("packs", () => {
    it("round-trip, exact-name ACTIVE lookup, hasActivePacks and tenant scoping", async () => {
      const item = await savedProduct(a);
      const pack = newPack(item.variant);
      await run((scope) => repos.productPacks.insert(scope, pack));
      await run(async (scope) => {
        expect(await repos.productPacks.findByIdForUpdate(scope, a.businessId, pack.id)).toEqual(pack);
        expect(await repos.productPacks.hasActivePacks(scope, a.businessId, item.variant.id)).toBe(true);
        expect(
          await repos.productPacks.findActiveIdByName(scope, a.businessId, item.variant.id, parsePackName("Carton")),
        ).toBe(pack.id);
        expect(
          await repos.productPacks.findActiveIdByName(scope, a.businessId, item.variant.id, parsePackName("carton")),
        ).toBe(undefined);
        expect(await repos.productPacks.findByIdForUpdate(scope, b.businessId, pack.id)).toBe(undefined);
        expect(await repos.productPacks.hasActivePacks(scope, b.businessId, item.variant.id)).toBe(false);
      });
    });

    it("retirement is the only change, ACTIVE to RETIRED once; a second retirement is ConcurrentModificationError", async () => {
      const item = await savedProduct(a);
      const pack = newPack(item.variant);
      await run((scope) => repos.productPacks.insert(scope, pack));
      const retired = retirePack({ pack, now: now() });
      if (retired.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.productPacks.update(scope, pack, retired.pack));
      await run(async (scope) => {
        expect(await repos.productPacks.findByIdForUpdate(scope, a.businessId, pack.id)).toEqual(retired.pack);
        expect(await repos.productPacks.hasActivePacks(scope, a.businessId, item.variant.id)).toBe(false);
      });
      expect(await rejection(run((scope) => repos.productPacks.update(scope, pack, retired.pack)))).toBeInstanceOf(
        ConcurrentModificationError,
      );
      await expect(run((scope) => repos.productPacks.update(scope, retired.pack, retired.pack))).rejects.toThrow(
        "ACTIVE to RETIRED",
      );
      await run((scope) => repos.productPacks.insert(scope, newPack(item.variant)));
    });

    it("a lost ACTIVE-name race is ConflictError; a foreign variant is not a conflict", async () => {
      const item = await savedProduct(a);
      await run((scope) => repos.productPacks.insert(scope, newPack(item.variant)));
      const failure = await rejection(
        run((scope) => repos.productPacks.insert(scope, newPack(item.variant, "Carton", 12n))),
      );
      expect(failure).toBeInstanceOf(ConflictError);
      expect((failure as ConflictError).message).toBe("An active pack with this name already exists");
      const foreign = await savedProduct(b);
      const smuggled = { ...newPack(foreign.variant), businessId: a.businessId };
      expect(await rejection(run((scope) => repos.productPacks.insert(scope, smuggled)))).not.toBeInstanceOf(
        ConflictError,
      );
    });
  });

  describe("units", () => {
    it("reads every approved unit through defineUnit, and nothing else", async () => {
      await run(async (scope) => {
        for (const unit of INITIAL_UNITS_OF_MEASURE) {
          expect(await repos.units.findByCode(scope, unit.code)).toEqual(unit);
        }
        expect(await repos.units.findByCode(scope, parseUnitCode("KG"))).toEqual(defineUnit("KG", "MASS", 3));
        expect(await repos.units.findByCode(scope, parseUnitCode("CARTON"))).toBe(undefined);
      });
    });
  });

  describe("concurrent races in independent transactions", () => {
    /** Runs `first` until it has written, then starts `second` (which blocks on the first's row), then commits the first. */
    async function race(
      first: (scope: TransactionScope) => Promise<void>,
      second: (scope: TransactionScope) => Promise<void>,
    ) {
      const written = gate();
      const release = gate();
      const winner = run(async (scope) => {
        await first(scope);
        written.open();
        await release.opened;
      });
      await written.opened;
      const loser = run(second);
      await delay(300);
      release.open();
      return Promise.allSettled([winner, loser]);
    }

    function expectOneWinner(results: PromiseSettledResult<void>[], loserType: new (...args: never[]) => Error) {
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(loserType);
    }

    it("two creates with one SKU: exactly one commits, the other is ConflictError", async () => {
      const first = newProduct(a, { sku: "RACE-SKU" }).item;
      const second = newProduct(a, { sku: "race-sku" }).item;
      const results = await race(
        (scope) => repos.products.insert(scope, first),
        (scope) => repos.products.insert(scope, second),
      );
      expectOneWinner(results, ConflictError);
      expect(
        await count(
          `SELECT count(*) AS n FROM product_variants WHERE business_id = $1 AND sku_normalized = 'RACE-SKU'`,
          [a.businessId],
        ),
      ).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM products WHERE id = $1`, [second.product.id])).toBe(0);
    });

    it("two creates with one ACTIVE barcode: exactly one commits, the other is ConflictError", async () => {
      const first = newProduct(a, { barcode: "4006381333931" }).item;
      const second = newProduct(a, { barcode: "4006381333931" }).item;
      const results = await race(
        (scope) => repos.products.insert(scope, first),
        (scope) => repos.products.insert(scope, second),
      );
      expectOneWinner(results, ConflictError);
      expect(
        await count(
          `SELECT count(*) AS n FROM product_variants
           WHERE business_id = $1 AND status = 'ACTIVE' AND barcode_normalized = '04006381333931'`,
          [a.businessId],
        ),
      ).toBe(1);
    });

    it("two updates from the same product version: one commits, the other is ConcurrentModificationError", async () => {
      const item = await savedProduct(a);
      const edit = (name: string) => {
        const transition = updateProduct({
          item,
          expectedVersion: 1,
          update: { name: parseProductName(name) },
          inventory: NO_INVENTORY,
          hasActivePacks: false,
          now: now(),
        });
        if (transition.outcome !== "changed") throw new Error("expected a change");
        return transition.item;
      };
      const winner = edit("Winner");
      const results = await race(
        (scope) => repos.products.update(scope, item, winner),
        (scope) => repos.products.update(scope, item, edit("Loser")),
      );
      expectOneWinner(results, ConcurrentModificationError);
      expect(await loadProduct(a, item)).toEqual(winner);
    });

    it("two updates from the same category version: one commits, the other is ConcurrentModificationError", async () => {
      const category = newCategory(a);
      await run((scope) => repos.productCategories.insert(scope, category));
      const rename = (name: string) => {
        const transition = renameCategory({ category, expectedVersion: 1, name: parseCategoryName(name), now: now() });
        if (transition.outcome !== "changed") throw new Error("expected a change");
        return transition.category;
      };
      const winner = rename("Winner");
      const results = await race(
        (scope) => repos.productCategories.update(scope, category, winner),
        (scope) => repos.productCategories.update(scope, category, rename("Loser")),
      );
      expectOneWinner(results, ConcurrentModificationError);
      await expect(
        run((scope) => repos.productCategories.findByIdForUpdate(scope, a.businessId, category.id)),
      ).resolves.toEqual(winner);
    });
  });

  describe("barcode lifecycle through the Slice 1 use cases", () => {
    function useCases() {
      const world = harness.world();
      const audit = new AuditRecorder({
        registry: taliAuditRegistry,
        writer: repos.auditWriter,
        clock: world.clock,
        ids: world.ids,
      });
      const common = {
        unitOfWork: harness.unitOfWork,
        memberships: repos.memberships,
        products: repos.products,
        audit,
      };
      return {
        create: createCreateProduct({
          ...common,
          categories: repos.productCategories,
          prices: repos.productPriceHistory,
          units: repos.units,
          idempotency: new KeyedIdempotency({
            businessStore: repos.businessIdempotency,
            clock: world.clock,
            ids: world.ids,
          }),
          hasher: world.hasher,
          ids: world.ids,
          clock: world.clock,
        }),
        archive: createArchiveProduct({ ...common, clock: world.clock }),
        reactivate: createReactivateProduct({ ...common, clock: world.clock }),
      };
    }

    it("A owns X; A is archived; B takes X; reactivating A is CONFLICT and changes nothing", async () => {
      const { create, archive, reactivate } = useCases();
      const input = (name: string) => ({
        name,
        sku: name.replace(" ", "-"),
        barcode: "4006381333931",
        stockUnit: "PIECE",
        trackInventory: true,
        idempotencyKey: ids().newId("IdempotencyKey"),
      });
      const first = (await create.execute(a.context, input("Product A"))).item;
      await archive.execute(a.context, { productId: first.product.id, expectedVersion: 1 });
      const second = (await create.execute(a.context, input("Product B"))).item;
      const auditBefore = await count(`SELECT count(*) AS n FROM business_audit_records WHERE business_id = $1`, [
        a.businessId,
      ]);

      const failure = await rejection(
        reactivate.execute(a.context, { productId: first.product.id, expectedVersion: 2 }),
      );
      expect((failure as { code?: unknown }).code).toBe("CONFLICT");

      const stored = await loadProduct(a, first);
      expect({ status: stored?.product.status, version: stored?.product.version }).toEqual({
        status: "ARCHIVED",
        version: 2,
      });
      expect(
        await count(`SELECT count(*) AS n FROM business_audit_records WHERE business_id = $1`, [a.businessId]),
      ).toBe(auditBefore);
      await run(async (scope) => {
        expect(await repos.products.findActiveVariantIdByBarcode(scope, a.businessId, keysOf(second).barcode)).toBe(
          second.variant.id,
        );
      });

      // The database is the backstop when the pre-check is bypassed (a concurrent reactivation).
      const archivedA = stored as CatalogProduct;
      const bypass = reactivateProduct({ item: archivedA, expectedVersion: 2, now: now() });
      if (bypass.outcome !== "changed") throw new Error("expected a change");
      expect(await rejection(run((scope) => repos.products.update(scope, archivedA, bypass.item)))).toBeInstanceOf(
        ConflictError,
      );
      expect(await loadProduct(a, first)).toEqual(archivedA);
    });
  });
});
