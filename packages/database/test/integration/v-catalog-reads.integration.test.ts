import type { PageRequest, ProductSearch, TransactionScope } from "@tali/application";
import { parsePageRequest, parseProductSearch } from "@tali/application";
import {
  archiveCategory,
  archiveProduct,
  type BusinessId,
  type CatalogProduct,
  type CurrencyCode,
  createCategory,
  createPack,
  createProduct,
  INITIAL_UNITS_OF_MEASURE,
  type MembershipId,
  Money,
  parseBarcode,
  parseCatalogChangeReason,
  parseCategoryName,
  parsePackName,
  parseProductName,
  parseSku,
  parseUnitCode,
  type ProductVariant,
  retirePack,
  setSellingPrice,
} from "@tali/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { escapeLikePattern } from "../../src/repositories/product-repository.js";
import { useTenancyHarness } from "../support/tenancy.js";

interface Tenant {
  readonly businessId: BusinessId;
  readonly membershipId: MembershipId;
  readonly currency: CurrencyCode;
}

const FIRST_PAGE: PageRequest = parsePageRequest();

/**
 * The Build 2 Slice 3 catalog read methods against the migrated test database,
 * as the application role: tenant isolation, status filters, name/SKU/barcode
 * search (literal, case-insensitive containment and exact normalized keys),
 * keyset pagination, and the global unit list. Business A uses NGN and
 * business B KES.
 */
describe("catalog reads (PostgreSQL)", () => {
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
      };
    };
    a = await tenant("catalog-reader-a", "NGN");
    b = await tenant("catalog-reader-b", "KES");
  });

  const ids = () => harness.world().ids;
  const now = () => harness.world().clock.now();
  const run = <T>(work: (scope: TransactionScope) => Promise<T>) => harness.unitOfWork.run(work);

  async function saved(
    t: Tenant,
    options: { name?: string; sku?: string; barcode?: string; priceMinor?: bigint } = {},
  ): Promise<CatalogProduct> {
    const created = createProduct({
      id: ids().newId("Product"),
      variantId: ids().newId("ProductVariant"),
      businessId: t.businessId,
      name: parseProductName(options.name ?? "Peak Milk 400g"),
      ...(options.sku === undefined ? {} : { sku: parseSku(options.sku) }),
      ...(options.barcode === undefined ? {} : { barcode: parseBarcode(options.barcode) }),
      stockUnit: parseUnitCode("PIECE"),
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
    await run(async (scope) => {
      await repos.products.insert(scope, created.item);
      if (created.priceEntry !== undefined) await repos.productPriceHistory.append(scope, created.priceEntry);
    });
    return created.item;
  }

  async function archived(item: CatalogProduct): Promise<CatalogProduct> {
    const result = archiveProduct({ item, expectedVersion: item.product.version, now: now() });
    if (result.outcome !== "changed") throw new Error("expected a change");
    await run((scope) => repos.products.update(scope, item, result.item));
    return result.item;
  }

  const list = (t: Tenant, status: "ACTIVE" | "ARCHIVED" = "ACTIVE", search?: ProductSearch, page = FIRST_PAGE) =>
    run((scope) =>
      repos.products.list(scope, t.businessId, { status, ...(search === undefined ? {} : { search }) }, page),
    );
  const search = async (t: Tenant, q: string) =>
    (await list(t, "ACTIVE", parseProductSearch(q))).items.map((item) => item.product.name);

  async function pack(variant: ProductVariant, name: string) {
    const created = createPack({
      id: ids().newId("ProductPack"),
      variant,
      name: parsePackName(name),
      factorMinor: 24n,
      now: now(),
    });
    await run((scope) => repos.productPacks.insert(scope, created));
    return created;
  }

  describe("products", () => {
    it("finds by ID within the business only, in any status, without a lock", async () => {
      const item = await saved(a, { sku: "PK-1", barcode: "036000291452", priceMinor: 500n });
      const gone = await archived(await saved(a, { name: "Gone" }));
      await run(async (scope) => {
        expect(await repos.products.findById(scope, a.businessId, item.product.id)).toEqual(item);
        expect(await repos.products.findById(scope, a.businessId, gone.product.id)).toEqual(gone);
        expect(await repos.products.findById(scope, b.businessId, item.product.id)).toBe(undefined);
      });
    });

    it("lists ACTIVE or ARCHIVED products of one business in ascending ID order", async () => {
      const kept = await saved(a, { name: "Kept" });
      const gone = await archived(await saved(a, { name: "Gone" }));
      await saved(b, { name: "Theirs" });
      expect((await list(a)).items).toEqual([kept]);
      expect((await list(a, "ARCHIVED")).items).toEqual([gone]);
      expect((await list(b)).items.map((item) => item.product.name)).toEqual(["Theirs"]);
      expect((await list(b, "ARCHIVED")).items).toEqual([]);
    });

    it("pages with the ID keyset, deterministically", async () => {
      const made: string[] = [];
      for (const name of ["A", "B", "C", "D", "E"]) made.push((await saved(a, { name })).product.id);
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await list(a, "ACTIVE", undefined, parsePageRequest({ limit: 2, ...(after ? { after } : {}) }));
        seen.push(...page.items.map((item) => item.product.id));
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      }
      expect(seen).toEqual([...made].sort());
      const last = await list(a, "ACTIVE", undefined, parsePageRequest({ limit: 5 }));
      expect(last.nextCursor).toBeNull();
    });

    it("searches names case-insensitively by literal containment within the business", async () => {
      await saved(a, { name: "Peak Milk 400g" });
      await saved(a, { name: "100% Juice" });
      await saved(a, { name: "1000 Juice" });
      await saved(a, { name: "Under_score" });
      await saved(a, { name: "Under score" });
      await saved(a, { name: "Back\\slash" });
      await saved(b, { name: "Peak Milk 400g" });
      expect(await search(a, "milk")).toEqual(["Peak Milk 400g"]);
      expect(await search(a, "PEAK MILK")).toEqual(["Peak Milk 400g"]);
      expect(await search(a, "0%")).toEqual(["100% Juice"]);
      expect(await search(a, "0% J")).toEqual(["100% Juice"]);
      expect(await search(a, "r_s")).toEqual(["Under_score"]);
      expect(await search(a, "%")).toEqual(["100% Juice"]);
      expect(await search(a, "_")).toEqual(["Under_score"]);
      expect(await search(a, "k\\s")).toEqual(["Back\\slash"]);
      expect(await search(a, "nothing here")).toEqual([]);
      expect((await search(a, "juice")).sort()).toEqual(["100% Juice", "1000 Juice"]);
    });

    it("matches the exact normalized SKU and GTIN-equivalent barcode forms", async () => {
      await saved(a, { name: "Milk", sku: "pk-400" });
      await saved(a, { name: "Rice", barcode: "036000291452" });
      await saved(a, { name: "Custom", barcode: "abc-12" });
      await saved(b, { name: "Theirs", sku: "PK-400", barcode: "0036000291452" });
      expect(await search(a, "PK-400")).toEqual(["Milk"]);
      expect(await search(a, " pk-400 ")).toEqual(["Milk"]);
      expect(await search(a, "PK-40")).toEqual([]);
      expect(await search(a, "036000291452")).toEqual(["Rice"]);
      expect(await search(a, "0036000291452")).toEqual(["Rice"]);
      expect(await search(a, "00036000291452")).toEqual(["Rice"]);
      expect(await search(a, "abc-12")).toEqual(["Custom"]);
      expect(await search(a, "ABC-12")).toEqual([]);
    });

    it("searches only within the requested status", async () => {
      const gone = await archived(await saved(a, { name: "Old Milk", sku: "OLD-1" }));
      expect(await search(a, "OLD-1")).toEqual([]);
      expect((await list(a, "ARCHIVED", parseProductSearch("old-1"))).items).toEqual([gone]);
    });

    it("escapes LIKE syntax in search terms", () => {
      expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
      expect(escapeLikePattern("plain")).toBe("plain");
    });
  });

  describe("categories", () => {
    it("find by ID and list by status within the business", async () => {
      const drinks = createCategory({
        id: ids().newId("ProductCategory"),
        businessId: a.businessId,
        name: parseCategoryName("Drinks"),
        now: now(),
      });
      const old = createCategory({
        id: ids().newId("ProductCategory"),
        businessId: a.businessId,
        name: parseCategoryName("Old"),
        now: now(),
      });
      const theirs = createCategory({
        id: ids().newId("ProductCategory"),
        businessId: b.businessId,
        name: parseCategoryName("Drinks"),
        now: now(),
      });
      await run(async (scope) => {
        for (const category of [drinks, old, theirs]) await repos.productCategories.insert(scope, category);
      });
      const archivedOld = archiveCategory({ category: old, expectedVersion: 1, now: now() });
      if (archivedOld.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.productCategories.update(scope, old, archivedOld.category));
      await run(async (scope) => {
        expect(await repos.productCategories.findById(scope, a.businessId, drinks.id)).toEqual(drinks);
        expect(await repos.productCategories.findById(scope, a.businessId, old.id)).toEqual(archivedOld.category);
        expect(await repos.productCategories.findById(scope, b.businessId, drinks.id)).toBe(undefined);
        expect((await repos.productCategories.list(scope, a.businessId, "ACTIVE", FIRST_PAGE)).items).toEqual([drinks]);
        expect((await repos.productCategories.list(scope, a.businessId, "ARCHIVED", FIRST_PAGE)).items).toEqual([
          archivedOld.category,
        ]);
        expect((await repos.productCategories.list(scope, b.businessId, "ACTIVE", FIRST_PAGE)).items).toEqual([theirs]);
        const page = await repos.productCategories.list(scope, b.businessId, "ACTIVE", parsePageRequest({ limit: 1 }));
        expect(page.nextCursor).toBeNull();
      });
    });
  });

  describe("packs", () => {
    it("list one variant's packs by status, scoped to the business", async () => {
      const item = await saved(a);
      const other = await saved(a, { name: "Other" });
      const crate = await pack(item.variant, "Crate");
      const box = await pack(item.variant, "Box");
      await pack(other.variant, "Crate");
      const retired = retirePack({ pack: box, now: now() });
      if (retired.outcome !== "changed") throw new Error("expected a change");
      await run((scope) => repos.productPacks.update(scope, box, retired.pack));
      await run(async (scope) => {
        const active = await repos.productPacks.listForVariant(
          scope,
          a.businessId,
          item.variant.id,
          "ACTIVE",
          FIRST_PAGE,
        );
        expect(active.items).toEqual([crate]);
        const gone = await repos.productPacks.listForVariant(
          scope,
          a.businessId,
          item.variant.id,
          "RETIRED",
          FIRST_PAGE,
        );
        expect(gone.items).toEqual([retired.pack]);
        const foreign = await repos.productPacks.listForVariant(
          scope,
          b.businessId,
          item.variant.id,
          "ACTIVE",
          FIRST_PAGE,
        );
        expect(foreign.items).toEqual([]);
        const paged = await repos.productPacks.listForVariant(
          scope,
          a.businessId,
          item.variant.id,
          "ACTIVE",
          parsePageRequest({ limit: 1 }),
        );
        expect(paged).toEqual({ items: [crate], nextCursor: null });
      });
    });
  });

  describe("price history", () => {
    it("lists one variant's prices in stable ascending ID order in integer minor units, scoped to the business", async () => {
      const item = await saved(a, { priceMinor: 100n });
      const priced = setSellingPrice({
        item,
        expectedVersion: 1,
        price: Money.ofMinor(9_223_372_036_854_775_807n, a.currency),
        businessCurrency: a.currency,
        priceId: ids().newId("ProductVariantPrice"),
        setByMembershipId: a.membershipId,
        reason: parseCatalogChangeReason("Supplier increase"),
        now: now(),
      });
      if (priced.outcome !== "changed") throw new Error("expected a change");
      await run(async (scope) => {
        await repos.products.update(scope, item, priced.item);
        await repos.productPriceHistory.append(scope, priced.priceEntry);
      });
      await run(async (scope) => {
        const history = await repos.productPriceHistory.listForVariant(
          scope,
          a.businessId,
          item.variant.id,
          FIRST_PAGE,
        );
        expect(history.items.map((row) => [row.priceVersion, row.price.toMinorUnitsString(), row.reason])).toEqual([
          [1, "100", undefined],
          [2, "9223372036854775807", "Supplier increase"],
        ]);
        expect(history.items[1]).toEqual(priced.priceEntry);
        const first = await repos.productPriceHistory.listForVariant(
          scope,
          a.businessId,
          item.variant.id,
          parsePageRequest({ limit: 1 }),
        );
        expect(first.nextCursor).toBe(history.items[0]?.id);
        expect(
          (await repos.productPriceHistory.listForVariant(scope, b.businessId, item.variant.id, FIRST_PAGE)).items,
        ).toEqual([]);
      });
    });
  });

  describe("units", () => {
    it("lists exactly the approved units ordered by code", async () => {
      const units = await run((scope) => repos.units.listAll(scope));
      expect(units).toEqual(
        [...INITIAL_UNITS_OF_MEASURE].sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0)),
      );
      expect(units).toHaveLength(9);
    });
  });
});
