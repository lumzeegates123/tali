-- CreateTable
CREATE TABLE "units_of_measure" (
    "code" VARCHAR(16) NOT NULL,
    "kind" TEXT NOT NULL,
    "scale" SMALLINT NOT NULL,

    CONSTRAINT "units_of_measure_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" UUID,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "sku" TEXT,
    "sku_normalized" TEXT,
    "barcode" TEXT,
    "barcode_normalized" TEXT,
    "stock_unit_code" VARCHAR(16) NOT NULL,
    "track_inventory" BOOLEAN NOT NULL,
    "current_price_minor" BIGINT,
    "current_price_currency" VARCHAR(3),
    "price_version" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_packs" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "factor_minor" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant_prices" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "price_version" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "set_by_membership_id" UUID NOT NULL,
    "reason" TEXT,

    CONSTRAINT "product_variant_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_business_id_status_idx" ON "product_categories"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_business_id_id_key" ON "product_categories"("business_id", "id");

-- CreateIndex
CREATE INDEX "products_business_id_status_idx" ON "products"("business_id", "status");

-- CreateIndex
CREATE INDEX "products_business_id_name_idx" ON "products"("business_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_business_id_id_key" ON "products"("business_id", "id");

-- CreateIndex
CREATE INDEX "product_variants_business_id_product_id_idx" ON "product_variants"("business_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_business_id_id_key" ON "product_variants"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_business_id_sku_normalized_key" ON "product_variants"("business_id", "sku_normalized");

-- CreateIndex
CREATE INDEX "product_packs_business_id_variant_id_idx" ON "product_packs"("business_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_packs_business_id_id_key" ON "product_packs"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_packs_business_id_id_variant_id_key" ON "product_packs"("business_id", "id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_prices_business_id_id_key" ON "product_variant_prices"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_prices_business_id_variant_id_price_version_key" ON "product_variant_prices"("business_id", "variant_id", "price_version");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_id_currency_code_key" ON "businesses"("id", "currency_code");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_category_id_fkey" FOREIGN KEY ("business_id", "category_id") REFERENCES "product_categories"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_business_id_created_by_membership_id_fkey" FOREIGN KEY ("business_id", "created_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_business_id_product_id_fkey" FOREIGN KEY ("business_id", "product_id") REFERENCES "products"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_stock_unit_code_fkey" FOREIGN KEY ("stock_unit_code") REFERENCES "units_of_measure"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_business_id_current_price_currency_fkey" FOREIGN KEY ("business_id", "current_price_currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_packs" ADD CONSTRAINT "product_packs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_packs" ADD CONSTRAINT "product_packs_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variant_prices" ADD CONSTRAINT "product_variant_prices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variant_prices" ADD CONSTRAINT "product_variant_prices_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variant_prices" ADD CONSTRAINT "product_variant_prices_business_id_currency_fkey" FOREIGN KEY ("business_id", "currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "product_variant_prices" ADD CONSTRAINT "product_variant_prices_business_id_set_by_membership_id_fkey" FOREIGN KEY ("business_id", "set_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Custom SQL (hand-written and reviewed; not generated by Prisma).
-- Build 2 Slice 2 (docs/plans/004-build-2-catalog-inventory.md; ADR-008
-- sections 3, 4.2, 5 and 9).
--
-- The composite tenant foreign keys and the (businesses.id, currency_code)
-- unique key above are generated from the Prisma schema. This section adds
-- CHECK constraints, partial unique indexes, privileges and the unit
-- reference rows. Every object here is listed in scripts/verify-schema.mjs.
-- RLS stays off. No business rule lives in the database: there are no
-- triggers or functions. Name and code normalization (NFC, trimming, case
-- folding, GTIN padding) is computed by the application; the database checks
-- only the stored shape and never relies on a collation.
-- ---------------------------------------------------------------------------

-- units_of_measure: global reference data. Codes are 1..16 uppercase letters;
-- the scale is the number of decimal places a quantity in the unit carries.
ALTER TABLE "units_of_measure"
    ADD CONSTRAINT "units_of_measure_code_format" CHECK ("code" ~ '^[A-Z]{1,16}$'),
    ADD CONSTRAINT "units_of_measure_kind_valid" CHECK ("kind" IN ('COUNT', 'MASS', 'VOLUME')),
    ADD CONSTRAINT "units_of_measure_scale_range" CHECK ("scale" BETWEEN 0 AND 3);

-- product_categories: flat; the trimmed 1..60 character name, and its
-- application-computed lowercase key. Lowercasing can lengthen a string (one
-- code point can become two), so the key's bound is twice the name's.
ALTER TABLE "product_categories"
    ADD CONSTRAINT "product_categories_name_length" CHECK (char_length("name") BETWEEN 1 AND 60),
    ADD CONSTRAINT "product_categories_name_trimmed" CHECK ("name" = btrim("name")),
    ADD CONSTRAINT "product_categories_normalized_name_length" CHECK (char_length("normalized_name") BETWEEN 1 AND 120),
    ADD CONSTRAINT "product_categories_status_valid" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
    ADD CONSTRAINT "product_categories_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "product_categories_updated_after_created" CHECK ("updated_at" >= "created_at");

-- products: the trimmed 1..120 character name (not unique); an optional
-- 1..500 character description that is not blank.
ALTER TABLE "products"
    ADD CONSTRAINT "products_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    ADD CONSTRAINT "products_name_trimmed" CHECK ("name" = btrim("name")),
    ADD CONSTRAINT "products_description_valid" CHECK ("description" IS NULL OR (char_length("description") BETWEEN 1 AND 500 AND "description" ~ '[^[:space:]]')),
    ADD CONSTRAINT "products_status_valid" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
    ADD CONSTRAINT "products_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "products_updated_after_created" CHECK ("updated_at" >= "created_at");

-- product_variants: SKU and barcode are each stored with their normalized
-- key, both present or both absent. The SKU key is the upper-cased contract
-- form; the display value may differ in length after case mapping, so only
-- its bounds are checked here. GTIN normalization is not repeated in SQL.
-- The current price and its currency are present together, positive, and
-- versioned from 1; an unpriced variant has price version 0.
-- Build 2 has exactly one hidden default variant per product (ADR-008 section
-- 3.2): every row is the default, and the partial unique index below allows
-- at most one per product. Multi-variant support may drop only this CHECK and
-- keep that index.
ALTER TABLE "product_variants"
    ADD CONSTRAINT "product_variants_default_only" CHECK ("is_default" = true),
    ADD CONSTRAINT "product_variants_status_valid" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
    ADD CONSTRAINT "product_variants_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "product_variants_price_version_non_negative" CHECK ("price_version" >= 0),
    ADD CONSTRAINT "product_variants_sku_pair" CHECK (("sku" IS NULL) = ("sku_normalized" IS NULL)),
    ADD CONSTRAINT "product_variants_sku_valid" CHECK ("sku" IS NULL OR (char_length("sku") BETWEEN 1 AND 64 AND "sku" = btrim("sku"))),
    ADD CONSTRAINT "product_variants_sku_normalized_format" CHECK ("sku_normalized" IS NULL OR "sku_normalized" ~ '^[A-Z0-9 ._/-]{1,64}$'),
    ADD CONSTRAINT "product_variants_barcode_pair" CHECK (("barcode" IS NULL) = ("barcode_normalized" IS NULL)),
    ADD CONSTRAINT "product_variants_barcode_format" CHECK ("barcode" IS NULL OR "barcode" ~ '^[0-9A-Za-z-]{1,64}$'),
    ADD CONSTRAINT "product_variants_barcode_normalized_format" CHECK ("barcode_normalized" IS NULL OR "barcode_normalized" ~ '^[0-9A-Za-z-]{1,64}$'),
    ADD CONSTRAINT "product_variants_price_shape" CHECK (
        ("current_price_minor" IS NULL AND "current_price_currency" IS NULL AND "price_version" = 0)
        OR ("current_price_minor" IS NOT NULL AND "current_price_currency" IS NOT NULL AND "current_price_minor" > 0 AND "price_version" >= 1)
    ),
    ADD CONSTRAINT "product_variants_updated_after_created" CHECK ("updated_at" >= "created_at");

-- product_packs: the trimmed 1..40 character name; a whole-number factor of
-- 2..1,000,000,000 stock-unit minor quantities. Packs are retired, never deleted.
ALTER TABLE "product_packs"
    ADD CONSTRAINT "product_packs_name_length" CHECK (char_length("name") BETWEEN 1 AND 40),
    ADD CONSTRAINT "product_packs_name_trimmed" CHECK ("name" = btrim("name")),
    ADD CONSTRAINT "product_packs_factor_range" CHECK ("factor_minor" BETWEEN 2 AND 1000000000),
    ADD CONSTRAINT "product_packs_status_valid" CHECK ("status" IN ('ACTIVE', 'RETIRED')),
    ADD CONSTRAINT "product_packs_updated_after_created" CHECK ("updated_at" >= "created_at");

-- product_variant_prices: append-only history in integer minor units.
ALTER TABLE "product_variant_prices"
    ADD CONSTRAINT "product_variant_prices_amount_positive" CHECK ("amount_minor" > 0),
    ADD CONSTRAINT "product_variant_prices_price_version_positive" CHECK ("price_version" >= 1),
    ADD CONSTRAINT "product_variant_prices_reason_valid" CHECK ("reason" IS NULL OR (char_length("reason") BETWEEN 1 AND 500 AND "reason" ~ '[^[:space:]]'));

-- Partial unique indexes (ADR-008 sections 3.1, 3.3, 4.3 and 5.2): one
-- default variant per product; an ACTIVE barcode identifies one variant per
-- business (an archived variant releases it); one ACTIVE category per
-- normalized name; one ACTIVE pack per exact, case-sensitive name per variant.
CREATE UNIQUE INDEX "product_variants_one_default_per_product" ON "product_variants" ("business_id", "product_id") WHERE "is_default";
CREATE UNIQUE INDEX "product_variants_active_barcode_unique" ON "product_variants" ("business_id", "barcode_normalized") WHERE "status" = 'ACTIVE' AND "barcode_normalized" IS NOT NULL;
CREATE UNIQUE INDEX "product_categories_active_name_unique" ON "product_categories" ("business_id", "normalized_name") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "product_packs_active_name_unique" ON "product_packs" ("business_id", "variant_id", "name") WHERE "status" = 'ACTIVE';

-- Privileges: units are read-only reference data; catalog records are read,
-- created and changed in state, never deleted or truncated; price history is
-- insert-only. UPDATE also backs the SELECT ... FOR UPDATE row locks. One
-- statement per table, so the migration scan in verify-schema.mjs sees each
-- grant next to its table name.
GRANT SELECT ON "units_of_measure" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "product_categories" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "products" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "product_variants" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "product_packs" TO tali_app;
GRANT SELECT, INSERT ON "product_variant_prices" TO tali_app;

-- Unit reference data (ADR-008 section 4.2). Exactly these nine units; no
-- container units (CARTON, CRATE, BAG, DOZEN, BUNDLE) are seeded.
INSERT INTO "units_of_measure" ("code", "kind", "scale") VALUES
    ('PIECE', 'COUNT', 0),
    ('BOTTLE', 'COUNT', 0),
    ('SACHET', 'COUNT', 0),
    ('TIN', 'COUNT', 0),
    ('PACK', 'COUNT', 0),
    ('KG', 'MASS', 3),
    ('G', 'MASS', 0),
    ('L', 'VOLUME', 3),
    ('ML', 'VOLUME', 0);
