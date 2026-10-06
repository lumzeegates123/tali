import { INITIAL_UNITS_OF_MEASURE } from "@tali/domain";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sqlStateOf } from "../../src/errors/postgres-errors.js";
import { useFixtureHarness, uuid } from "../support/harness.js";
import { appPool, sqlState } from "../support/pg.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const INSUFFICIENT_PRIVILEGE = "42501";
const STRING_TOO_LONG = "22001";
const NOW = "2026-10-05T08:00:00.000Z";
const MAX_BIGINT = "9223372036854775807";

const USER_A = uuid(0xa1);
const USER_B = uuid(0xb1);
const BUSINESS_A = uuid(0xa2);
const BUSINESS_B = uuid(0xb2);
const MEMBERSHIP_A = uuid(0xa4);
const MEMBERSHIP_B = uuid(0xb4);

const CATALOG_TABLES = ["product_categories", "products", "product_variants", "product_packs"] as const;

let nextId = 0x3000;
const freshId = () => uuid(nextId++);

/**
 * Database-enforced invariants of the Build 2 Slice 2 catalog tables,
 * exercised directly as the application role (ADR-008 sections 3, 4.2 and 5):
 * read-only unit reference data, CHECKs, partial uniques, composite tenant
 * foreign keys (including the business-currency key), and privileges.
 * Business A uses NGN and business B KES, so no currency is special-cased.
 */
describe("catalog schema constraints (as tali_app)", () => {
  const { owner, client } = useFixtureHarness();
  let app: pg.Pool;

  beforeAll(() => {
    app = appPool();
  });

  afterAll(async () => {
    await app.end();
  });

  beforeEach(async () => {
    for (const [business, user, membership, currency] of [
      [BUSINESS_A, USER_A, MEMBERSHIP_A, "NGN"],
      [BUSINESS_B, USER_B, MEMBERSHIP_B, "KES"],
    ]) {
      await owner.query(
        `INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, 'Owner', 'ACTIVE', $2, $2)`,
        [user, NOW],
      );
      await owner.query(
        `INSERT INTO businesses (id, name, currency_code, time_zone, status, created_by_user_id, created_at, updated_at)
         VALUES ($1, 'Shop', $2, 'Africa/Lagos', 'ACTIVE', $3, $4, $4)`,
        [business, currency, user, NOW],
      );
      await owner.query(
        `INSERT INTO business_memberships (business_id, id, user_id, role, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 1, $4, $4)`,
        [business, membership, user, NOW],
      );
    }
  });

  interface CategoryRow {
    business?: string;
    name?: string;
    normalizedName?: string;
    status?: string;
    version?: number;
  }

  const insertCategory = (row: CategoryRow = {}, id = freshId()) =>
    app.query(
      `INSERT INTO product_categories (business_id, id, name, normalized_name, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [
        row.business ?? BUSINESS_A,
        id,
        row.name ?? "Drinks",
        row.normalizedName ?? (row.name ?? "Drinks").toLowerCase(),
        row.status ?? "ACTIVE",
        row.version ?? 1,
        NOW,
      ],
    );

  interface ProductRow {
    business?: string;
    name?: string;
    description?: string | null;
    category?: string | null;
    status?: string;
    version?: number;
    createdBy?: string;
  }

  const insertProduct = (row: ProductRow = {}, id = freshId()) =>
    app.query(
      `INSERT INTO products (business_id, id, name, description, category_id, status, version, created_by_membership_id,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [
        row.business ?? BUSINESS_A,
        id,
        row.name ?? "Peak Milk 400g",
        row.description ?? null,
        row.category ?? null,
        row.status ?? "ACTIVE",
        row.version ?? 1,
        row.createdBy ?? MEMBERSHIP_A,
        NOW,
      ],
    );

  interface VariantRow {
    business?: string;
    product?: string;
    isDefault?: boolean;
    status?: string;
    sku?: string | null;
    skuNormalized?: string | null;
    barcode?: string | null;
    barcodeNormalized?: string | null;
    stockUnit?: string;
    priceMinor?: string | null;
    priceCurrency?: string | null;
    priceVersion?: number;
    version?: number;
  }

  const insertVariant = (row: VariantRow, id = freshId()) =>
    app.query(
      `INSERT INTO product_variants (business_id, id, product_id, is_default, status, sku, sku_normalized, barcode,
         barcode_normalized, stock_unit_code, track_inventory, current_price_minor, current_price_currency,
         price_version, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12, $13, $14, $15, $15)`,
      [
        row.business ?? BUSINESS_A,
        id,
        row.product,
        row.isDefault ?? true,
        row.status ?? "ACTIVE",
        row.sku ?? null,
        "skuNormalized" in row ? row.skuNormalized : (row.sku?.toUpperCase() ?? null),
        row.barcode ?? null,
        "barcodeNormalized" in row ? row.barcodeNormalized : (row.barcode ?? null),
        row.stockUnit ?? "PIECE",
        row.priceMinor ?? null,
        row.priceCurrency ?? null,
        row.priceVersion ?? 0,
        row.version ?? 1,
        NOW,
      ],
    );

  /** A product with its default variant in business A (or `business`, using that business's membership). */
  async function productWithVariant(business = BUSINESS_A, variant: VariantRow = {}) {
    const productId = freshId();
    const variantId = freshId();
    await insertProduct({ business, createdBy: business === BUSINESS_A ? MEMBERSHIP_A : MEMBERSHIP_B }, productId);
    await insertVariant({ business, ...variant, product: productId }, variantId);
    return { productId, variantId };
  }

  const insertPack = (
    row: { business?: string; variant: string; name?: string; factor?: string; status?: string },
    id = freshId(),
  ) =>
    app.query(
      `INSERT INTO product_packs (business_id, id, variant_id, name, factor_minor, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [
        row.business ?? BUSINESS_A,
        id,
        row.variant,
        row.name ?? "Carton",
        row.factor ?? "24",
        row.status ?? "ACTIVE",
        NOW,
      ],
    );

  const insertPrice = (row: {
    business?: string;
    variant: string;
    amount?: string;
    currency?: string;
    priceVersion?: number;
    setBy?: string;
    reason?: string | null;
  }) =>
    app.query(
      `INSERT INTO product_variant_prices (business_id, id, variant_id, amount_minor, currency, price_version,
         effective_at, set_by_membership_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.business ?? BUSINESS_A,
        freshId(),
        row.variant,
        row.amount ?? "150000",
        row.currency ?? "NGN",
        row.priceVersion ?? 1,
        NOW,
        row.setBy ?? MEMBERSHIP_A,
        row.reason ?? null,
      ],
    );

  describe("units_of_measure (global reference data)", () => {
    it("holds exactly the nine approved units, with their kinds and scales", async () => {
      const { rows } = await app.query<{ code: string; kind: string; scale: number }>(
        `SELECT code, kind, scale FROM units_of_measure ORDER BY code`,
      );
      const expected = INITIAL_UNITS_OF_MEASURE.map(({ code, kind, scale }) => ({ code, kind, scale })).sort((a, b) =>
        a.code.localeCompare(b.code),
      );
      expect(rows).toEqual(expected);
      for (const container of ["CARTON", "CRATE", "BAG", "DOZEN", "BUNDLE"]) {
        expect(rows.some((row) => row.code === container)).toBe(false);
      }
    });

    it("is read-only for the application role", async () => {
      expect(
        await sqlState(app.query(`INSERT INTO units_of_measure (code, kind, scale) VALUES ('CARTON', 'COUNT', 0)`)),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`UPDATE units_of_measure SET scale = 2 WHERE code = 'KG'`))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlState(app.query(`DELETE FROM units_of_measure WHERE code = 'ML'`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`TRUNCATE units_of_measure`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("rejects malformed reference rows even for the owner (code, kind, scale CHECKs)", async () => {
      const insertUnit = (code: string, kind: string, scale: number) =>
        owner.query(`INSERT INTO units_of_measure (code, kind, scale) VALUES ($1, $2, $3)`, [code, kind, scale]);
      expect(await sqlState(insertUnit("X".repeat(17), "COUNT", 0))).toBe(STRING_TOO_LONG);
      for (const [code, kind, scale] of [
        ["carton", "COUNT", 0],
        ["CARTON1", "COUNT", 0],
        ["CARTON", "LENGTH", 0],
        ["CARTON", "COUNT", 4],
        ["CARTON", "COUNT", -1],
      ] as const) {
        expect(await sqlState(insertUnit(code, kind, scale)), code).toBe(CHECK_VIOLATION);
      }
    });
  });

  describe("privileges", () => {
    it.each(CATALOG_TABLES)("%s: DELETE and TRUNCATE are denied", async (table) => {
      expect(await sqlState(app.query(`DELETE FROM ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`TRUNCATE ${table}`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("product_variant_prices is insert-only: UPDATE, DELETE and TRUNCATE are denied", async () => {
      expect(await sqlState(app.query(`UPDATE product_variant_prices SET reason = NULL`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`DELETE FROM product_variant_prices`))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlState(app.query(`TRUNCATE product_variant_prices`))).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("the Prisma client path is refused too, with the SQLSTATE preserved", async () => {
      const denied = async (run: () => Promise<unknown>) => {
        try {
          await run();
        } catch (error) {
          return sqlStateOf(error);
        }
        throw new Error("expected the statement to be denied");
      };
      expect(await denied(() => client.$executeRaw`DELETE FROM products`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await denied(() => client.$executeRaw`UPDATE product_variant_prices SET reason = NULL`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await denied(() => client.$executeRaw`UPDATE units_of_measure SET scale = 0`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  describe("product_categories", () => {
    it("names are trimmed 1..60 characters with a non-empty key; two statuses; version from 1", async () => {
      await insertCategory({ name: "x".repeat(60) });
      for (const row of [
        { name: "" },
        { name: " Drinks" },
        { name: "Drinks " },
        { name: "x".repeat(61) },
        { normalizedName: "" },
        { normalizedName: "x".repeat(121) },
        { status: "DELETED" },
        { status: "active" },
        { version: 0 },
      ]) {
        expect(await sqlState(insertCategory(row)), JSON.stringify(row)).toBe(CHECK_VIOLATION);
      }
    });

    it("one ACTIVE category per name key per business; archived and other businesses do not collide", async () => {
      await insertCategory({ name: "Drinks" });
      expect(await sqlState(insertCategory({ name: "DRINKS", normalizedName: "drinks" }))).toBe(UNIQUE_VIOLATION);
      await insertCategory({ name: "Drinks", status: "ARCHIVED" });
      await insertCategory({ name: "Drinks", status: "ARCHIVED" });
      await insertCategory({ business: BUSINESS_B, name: "Drinks" });
    });
  });

  describe("products", () => {
    it("names are trimmed 1..120 characters and not unique; descriptions are 1..500 and not blank", async () => {
      await insertProduct({ name: "Peak Milk" });
      await insertProduct({ name: "Peak Milk" });
      await insertProduct({ name: "x".repeat(120), description: "d".repeat(500) });
      await insertProduct({ description: " leading and trailing space is kept " });
      for (const row of [
        { name: "" },
        { name: " padded" },
        { name: "x".repeat(121) },
        { description: "" },
        { description: "   " },
        { description: "d".repeat(501) },
        { status: "DELETED" },
        { version: 0 },
      ]) {
        expect(await sqlState(insertProduct(row)), JSON.stringify(row)).toBe(CHECK_VIOLATION);
      }
    });

    it("composite tenant keys: category and creating membership stay in the product's business", async () => {
      const categoryB = freshId();
      await insertCategory({ business: BUSINESS_B }, categoryB);
      expect(await sqlState(insertProduct({ category: categoryB }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertProduct({ createdBy: MEMBERSHIP_B }))).toBe(FOREIGN_KEY_VIOLATION);
      const categoryA = freshId();
      await insertCategory({}, categoryA);
      await insertProduct({ category: categoryA });
    });
  });

  describe("product_variants", () => {
    it("composite tenant key to the product, and the stock unit must be reference data", async () => {
      const productB = freshId();
      await insertProduct({ business: BUSINESS_B, createdBy: MEMBERSHIP_B }, productB);
      expect(await sqlState(insertVariant({ product: productB }))).toBe(FOREIGN_KEY_VIOLATION);
      const productA = freshId();
      await insertProduct({}, productA);
      expect(await sqlState(insertVariant({ product: productA, stockUnit: "CARTON" }))).toBe(FOREIGN_KEY_VIOLATION);
      await insertVariant({ product: productA, stockUnit: "KG" });
    });

    it("a product with its default variant is stored", async () => {
      const { productId, variantId } = await productWithVariant();
      const { rows } = await app.query<{ id: string; is_default: boolean }>(
        `SELECT id::text, is_default FROM product_variants WHERE business_id = $1 AND product_id = $2`,
        [BUSINESS_A, productId],
      );
      expect(rows).toEqual([{ id: variantId, is_default: true }]);
    });

    it("a non-default variant is rejected, for the application role and the owner (Build 2 CHECK)", async () => {
      const productId = freshId();
      await insertProduct({}, productId);
      expect(await sqlState(insertVariant({ product: productId, isDefault: false }))).toBe(CHECK_VIOLATION);
      const { productId: withDefault } = await productWithVariant();
      expect(await sqlState(insertVariant({ product: withDefault, isDefault: false }))).toBe(CHECK_VIOLATION);
      expect(
        await sqlState(
          owner.query(
            `INSERT INTO product_variants (business_id, id, product_id, is_default, status, stock_unit_code,
               track_inventory, price_version, version, created_at, updated_at)
             VALUES ($1, $2, $3, false, 'ACTIVE', 'PIECE', true, 0, 1, $4, $4)`,
            [BUSINESS_A, freshId(), productId, NOW],
          ),
        ),
      ).toBe(CHECK_VIOLATION);
      expect(await sqlState(app.query(`UPDATE product_variants SET is_default = false`))).toBe(CHECK_VIOLATION);
    });

    it("a second default variant for the same product is rejected by the partial unique index", async () => {
      const { productId } = await productWithVariant();
      const error: unknown = await insertVariant({ product: productId }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
      expect(error).toMatchObject({ constraint: "product_variants_one_default_per_product" });
      const { rows } = await app.query<{ n: string }>(
        `SELECT count(*) AS n FROM product_variants WHERE business_id = $1 AND product_id = $2`,
        [BUSINESS_A, productId],
      );
      expect(rows[0]?.n).toBe("1");
    });

    it("status, version and price version shapes", async () => {
      const productId = freshId();
      await insertProduct({}, productId);
      for (const row of [{ status: "DELETED" }, { version: 0 }, { priceVersion: -1 }]) {
        expect(await sqlState(insertVariant({ product: productId, ...row })), JSON.stringify(row)).toBe(
          CHECK_VIOLATION,
        );
      }
    });

    it("SKU and its key come as a pair; the key has the contract syntax; the value is trimmed 1..64", async () => {
      const productId = freshId();
      await insertProduct({}, productId);
      for (const row of [
        { sku: "abc-1", skuNormalized: null },
        { sku: null, skuNormalized: "ABC-1" },
        { sku: "abc-1", skuNormalized: "abc-1" },
        { sku: "abc#1", skuNormalized: "ABC#1" },
        { sku: "x".repeat(65), skuNormalized: "X".repeat(65) },
        { sku: " abc", skuNormalized: "ABC" },
        { sku: "", skuNormalized: "" },
      ]) {
        expect(await sqlState(insertVariant({ product: productId, ...row })), JSON.stringify(row)).toBe(
          CHECK_VIOLATION,
        );
      }
      await insertVariant({ product: productId, sku: "Abc 1/2._-", skuNormalized: "ABC 1/2._-" });
    });

    it("a SKU key is unique per business across every status, and free in another business", async () => {
      await productWithVariant(BUSINESS_A, { sku: "MILK-400", status: "ARCHIVED" });
      const productId = freshId();
      await insertProduct({}, productId);
      expect(await sqlState(insertVariant({ product: productId, sku: "milk-400" }))).toBe(UNIQUE_VIOLATION);
      await productWithVariant(BUSINESS_B, { sku: "MILK-400" });
    });

    it("barcode and its key come as a pair with the barcode syntax (no GTIN logic in SQL)", async () => {
      const productId = freshId();
      await insertProduct({}, productId);
      for (const row of [
        { barcode: "12345670", barcodeNormalized: null },
        { barcode: null, barcodeNormalized: "12345670" },
        { barcode: "1234 5670" },
        { barcode: "abc_1" },
        { barcode: "9".repeat(65) },
        { barcode: "" },
      ]) {
        expect(await sqlState(insertVariant({ product: productId, ...row })), JSON.stringify(row)).toBe(
          CHECK_VIOLATION,
        );
      }
      await insertVariant({ product: productId, barcode: "96385074", barcodeNormalized: "00000096385074" });
    });

    it("an ACTIVE barcode key identifies one variant per business; archived variants release it", async () => {
      await productWithVariant(BUSINESS_A, { barcode: "SHELF-1", status: "ARCHIVED" });
      await productWithVariant(BUSINESS_A, { barcode: "SHELF-1" });
      const productId = freshId();
      await insertProduct({}, productId);
      expect(await sqlState(insertVariant({ product: productId, barcode: "SHELF-1" }))).toBe(UNIQUE_VIOLATION);
      await insertVariant({ product: productId, barcode: "SHELF-1", status: "ARCHIVED" });
      await productWithVariant(BUSINESS_B, { barcode: "SHELF-1" });
    });

    it("current price: both columns or neither; positive; versioned from 1; unpriced is version 0", async () => {
      const productId = freshId();
      await insertProduct({}, productId);
      for (const row of [
        { priceMinor: null, priceCurrency: null, priceVersion: 1 },
        { priceMinor: "100", priceCurrency: "NGN", priceVersion: 0 },
        { priceMinor: "100", priceCurrency: null, priceVersion: 1 },
        { priceMinor: null, priceCurrency: "NGN", priceVersion: 1 },
        { priceMinor: "0", priceCurrency: "NGN", priceVersion: 1 },
        { priceMinor: "-5", priceCurrency: "NGN", priceVersion: 1 },
      ]) {
        expect(await sqlState(insertVariant({ product: productId, ...row })), JSON.stringify(row)).toBe(
          CHECK_VIOLATION,
        );
      }
      await insertVariant({ product: productId, priceMinor: MAX_BIGINT, priceCurrency: "NGN", priceVersion: 3 });
    });

    it("the current price is always in the variant's business currency (composite currency key)", async () => {
      const productA = freshId();
      await insertProduct({}, productA);
      expect(
        await sqlState(insertVariant({ product: productA, priceMinor: "100", priceCurrency: "KES", priceVersion: 1 })),
      ).toBe(FOREIGN_KEY_VIOLATION);
      const productB = freshId();
      await insertProduct({ business: BUSINESS_B, createdBy: MEMBERSHIP_B }, productB);
      expect(
        await sqlState(
          insertVariant({
            business: BUSINESS_B,
            product: productB,
            priceMinor: "100",
            priceCurrency: "NGN",
            priceVersion: 1,
          }),
        ),
      ).toBe(FOREIGN_KEY_VIOLATION);
      await insertVariant({
        business: BUSINESS_B,
        product: productB,
        priceMinor: "100",
        priceCurrency: "KES",
        priceVersion: 1,
      });
    });
  });

  describe("product_packs", () => {
    it("trimmed 1..40 character names, factors 2..1,000,000,000, ACTIVE or RETIRED", async () => {
      const { variantId } = await productWithVariant();
      await insertPack({ variant: variantId, name: "x".repeat(40), factor: "2" });
      await insertPack({ variant: variantId, name: "Big", factor: "1000000000" });
      for (const row of [
        { name: "" },
        { name: " Carton" },
        { name: "x".repeat(41) },
        { factor: "1" },
        { factor: "0" },
        { factor: "1000000001" },
        { status: "ARCHIVED" },
      ]) {
        expect(await sqlState(insertPack({ variant: variantId, ...row })), JSON.stringify(row)).toBe(CHECK_VIOLATION);
      }
    });

    it("one ACTIVE pack per exact, case-sensitive name per variant; retired packs do not collide", async () => {
      const { variantId } = await productWithVariant();
      const other = await productWithVariant();
      await insertPack({ variant: variantId, name: "Carton" });
      expect(await sqlState(insertPack({ variant: variantId, name: "Carton" }))).toBe(UNIQUE_VIOLATION);
      await insertPack({ variant: variantId, name: "carton" });
      await insertPack({ variant: variantId, name: "Carton", status: "RETIRED" });
      await insertPack({ variant: other.variantId, name: "Carton" });
    });

    it("composite tenant key: a pack's variant belongs to the pack's business", async () => {
      const variantB = await productWithVariant(BUSINESS_B);
      expect(await sqlState(insertPack({ variant: variantB.variantId }))).toBe(FOREIGN_KEY_VIOLATION);
    });
  });

  describe("product_variant_prices", () => {
    it("positive amounts, versions from 1, optional non-blank reasons up to 500 characters", async () => {
      const { variantId } = await productWithVariant();
      await insertPrice({ variant: variantId, amount: MAX_BIGINT, reason: "r".repeat(500) });
      for (const row of [
        { amount: "0" },
        { amount: "-1" },
        { priceVersion: 0 },
        { reason: "" },
        { reason: "  " },
        { reason: "r".repeat(501) },
      ]) {
        expect(await sqlState(insertPrice({ variant: variantId, priceVersion: 2, ...row })), JSON.stringify(row)).toBe(
          CHECK_VIOLATION,
        );
      }
    });

    it("one row per (business, variant, price version)", async () => {
      const { variantId } = await productWithVariant();
      await insertPrice({ variant: variantId, priceVersion: 1 });
      expect(await sqlState(insertPrice({ variant: variantId, priceVersion: 1 }))).toBe(UNIQUE_VIOLATION);
      await insertPrice({ variant: variantId, priceVersion: 2 });
    });

    it("composite keys: variant, setter and currency all belong to the row's business", async () => {
      const { variantId } = await productWithVariant();
      const variantB = await productWithVariant(BUSINESS_B);
      expect(await sqlState(insertPrice({ variant: variantB.variantId }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertPrice({ variant: variantId, setBy: MEMBERSHIP_B }))).toBe(FOREIGN_KEY_VIOLATION);
      expect(await sqlState(insertPrice({ variant: variantId, currency: "KES" }))).toBe(FOREIGN_KEY_VIOLATION);
      await insertPrice({
        business: BUSINESS_B,
        variant: variantB.variantId,
        currency: "KES",
        setBy: MEMBERSHIP_B,
      });
    });
  });
});
