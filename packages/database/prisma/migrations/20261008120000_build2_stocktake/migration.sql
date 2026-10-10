-- Build 2 Slice 6: stocktakes, stocktake lines and the COUNT_CORRECTION
-- movement type (ADR-008 section 12; plan 005, W3).
--
-- Forward-only and atomic. `prisma migrate deploy` (Prisma 7.10) does NOT run
-- a migration file in one transaction: without the explicit BEGIN/COMMIT
-- below, a failure part-way leaves the earlier statements applied (measured: the
-- stocktake tables created and the four movement CHECKs dropped, not re-added).
-- With them, any failing statement aborts the whole transaction, nothing in
-- this file persists, and Prisma leaves the migration unfinished (not applied).
-- Prisma then reports "current transaction is aborted" rather than the failing
-- statement's own error; rerun the file in psql to see it.
-- test/integration/zb-stocktake-migration-safety proves this against a
-- failure-injected copy of this file.
--
-- Order: A-C the two stocktake tables with their keys, foreign keys and
-- CHECKs; D-E the movement's stocktake references; F the four replaced
-- movement CHECKs; G the COUNT_CORRECTION CHECKs and partial unique index; H no
-- audit change (entity_type is a format CHECK, which already admits
-- "stocktake"); I privileges. Existing movements get stocktake_id NULL and no
-- row is rewritten. Re-adding the reason shape validates every existing row: an
-- original ADJUSTMENT or WRITE_OFF without a reason code (which the application
-- never writes) fails it, and the whole migration rolls back.

BEGIN;

-- A. CreateTable
CREATE TABLE "stocktakes" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "note" TEXT,
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "posted_by_membership_id" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "business_date" DATE,
    "cancelled_by_membership_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- B. CreateTable
CREATE TABLE "stocktake_lines" (
    "business_id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "counted_quantity_minor" BIGINT NOT NULL,
    "stock_unit_code" VARCHAR(16) NOT NULL,
    "expected_at_count_minor" BIGINT NOT NULL,
    "balance_version_at_count" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "counted_by_membership_id" UUID NOT NULL,
    "counted_at" TIMESTAMPTZ(3) NOT NULL,
    "variance_minor" BIGINT,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("business_id","stocktake_id","variant_id")
);

-- C. CreateIndex
CREATE UNIQUE INDEX "stocktakes_business_id_id_key" ON "stocktakes"("business_id", "id");

-- C. CreateIndex: the target of the movement's stocktake-location foreign key.
CREATE UNIQUE INDEX "stocktakes_business_id_id_location_id_key" ON "stocktakes"("business_id", "id", "location_id");

-- C. AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_business_id_created_by_membership_id_fkey" FOREIGN KEY ("business_id", "created_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_business_id_posted_by_membership_id_fkey" FOREIGN KEY ("business_id", "posted_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_business_id_cancelled_by_membership_id_fkey" FOREIGN KEY ("business_id", "cancelled_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_business_id_stocktake_id_fkey" FOREIGN KEY ("business_id", "stocktake_id") REFERENCES "stocktakes"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stock_unit_code_fkey" FOREIGN KEY ("stock_unit_code") REFERENCES "units_of_measure"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- C. AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_business_id_counted_by_membership_id_fkey" FOREIGN KEY ("business_id", "counted_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Custom SQL (hand-written and reviewed; not generated by Prisma). Every
-- object here is listed in scripts/verify-schema.mjs. RLS stays off; there
-- are no triggers or functions.
-- ---------------------------------------------------------------------------

-- C. Stocktake headers: DRAFT, POSTED or CANCELLED; an optional trimmed note
-- of 1..500 characters. The posting columns (who, when, business date) are
-- present together and exactly when POSTED; the cancellation columns (who,
-- when) together and exactly when CANCELLED. So a DRAFT has neither set, a
-- POSTED stocktake no cancellation and a CANCELLED one no posting.
ALTER TABLE "stocktakes"
    ADD CONSTRAINT "stocktakes_status_valid" CHECK ("status" IN ('DRAFT', 'POSTED', 'CANCELLED')),
    ADD CONSTRAINT "stocktakes_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "stocktakes_note_valid" CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" = btrim("note"))),
    ADD CONSTRAINT "stocktakes_posted_shape" CHECK (
        ("status" = 'POSTED') = ("posted_at" IS NOT NULL)
        AND ("posted_at" IS NULL) = ("posted_by_membership_id" IS NULL)
        AND ("posted_at" IS NULL) = ("business_date" IS NULL)
    ),
    ADD CONSTRAINT "stocktakes_cancelled_shape" CHECK (
        ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
        AND ("cancelled_at" IS NULL) = ("cancelled_by_membership_id" IS NULL)
    ),
    ADD CONSTRAINT "stocktakes_posted_after_created" CHECK ("posted_at" IS NULL OR "posted_at" >= "created_at"),
    ADD CONSTRAINT "stocktakes_cancelled_after_created" CHECK ("cancelled_at" IS NULL OR "cancelled_at" >= "created_at");

-- C. Stocktake lines: COUNTED or REMOVED; a counted quantity of 0..10^15 and
-- an expected on-hand within 10^15 in either direction, both in the stock unit
-- at count time; versions from 0 (balance) and 1 (line). The variance is
-- written once at posting, within 10^15, and only on a COUNTED line. Whether a
-- POSTED stocktake's COUNTED lines all carry one spans two tables: the
-- application enforces it.
ALTER TABLE "stocktake_lines"
    ADD CONSTRAINT "stocktake_lines_status_valid" CHECK ("status" IN ('COUNTED', 'REMOVED')),
    ADD CONSTRAINT "stocktake_lines_counted_quantity_range" CHECK ("counted_quantity_minor" BETWEEN 0 AND 1000000000000000),
    ADD CONSTRAINT "stocktake_lines_expected_at_count_range" CHECK ("expected_at_count_minor" BETWEEN -1000000000000000 AND 1000000000000000),
    ADD CONSTRAINT "stocktake_lines_balance_version_non_negative" CHECK ("balance_version_at_count" >= 0),
    ADD CONSTRAINT "stocktake_lines_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "stocktake_lines_variance_range" CHECK ("variance_minor" IS NULL OR "variance_minor" BETWEEN -1000000000000000 AND 1000000000000000),
    ADD CONSTRAINT "stocktake_lines_variance_counted_only" CHECK ("variance_minor" IS NULL OR "status" = 'COUNTED');

-- C. One DRAFT stocktake per location (plan decision D1): the storage-level
-- guarantee behind CreateStocktake's CONFLICT. POSTED and CANCELLED
-- stocktakes are unlimited.
CREATE UNIQUE INDEX "stocktakes_one_draft" ON "stocktakes" ("business_id", "location_id") WHERE "status" = 'DRAFT';

-- D. AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "stocktake_id" UUID;

-- E. AddForeignKey: a COUNT_CORRECTION references its stocktake line, which
-- pins the movement to the line's business and variant (the counted variant
-- is in this stocktake).
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_stocktake_id_variant_id_fkey" FOREIGN KEY ("business_id", "stocktake_id", "variant_id") REFERENCES "stocktake_lines"("business_id", "stocktake_id", "variant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- E. AddForeignKey: and its stocktake header, which pins the movement to the
-- stocktake's location (lines carry no location of their own).
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_stocktake_id_location_id_fkey" FOREIGN KEY ("business_id", "stocktake_id", "location_id") REFERENCES "stocktakes"("business_id", "id", "location_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- F. The four movement CHECKs that name the movement types or sources are
-- replaced in place, each by a definition that accepts every valid row the old
-- one accepted for the four Slice 5 types, plus COUNT_CORRECTION: the fifth
-- type; the stocktake line as a fourth document reference; a COUNT_CORRECTION
-- in either direction but never a reversal; and no reason code or note on a
-- COUNT_CORRECTION (a reversal is never one). The reason shape also closes a
-- Slice 5 gap: an original ADJUSTMENT or WRITE_OFF with a NULL reason_code
-- made "reason_code IN (...)" UNKNOWN, which a CHECK accepts, so the code is
-- now required explicitly. Every other Slice 5 movement CHECK, index and
-- foreign key is untouched.
ALTER TABLE "inventory_movements"
    DROP CONSTRAINT "inventory_movements_type_valid",
    DROP CONSTRAINT "inventory_movements_one_source",
    DROP CONSTRAINT "inventory_movements_direction",
    DROP CONSTRAINT "inventory_movements_reason_shape";

ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_type_valid" CHECK ("type" IN ('OPENING', 'PURCHASE_RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'COUNT_CORRECTION')),
    ADD CONSTRAINT "inventory_movements_one_source" CHECK (num_nonnulls("opening_batch_id", "goods_receipt_id", "adjustment_id", "stocktake_id") = 1),
    ADD CONSTRAINT "inventory_movements_direction" CHECK (
        ("type" = 'OPENING' AND "reverses_movement_id" IS NULL AND "quantity_delta_minor" > 0)
        OR ("type" = 'PURCHASE_RECEIPT' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" > 0)))
        OR ("type" = 'WRITE_OFF' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" < 0)))
        OR ("type" = 'ADJUSTMENT')
        OR ("type" = 'COUNT_CORRECTION' AND "reverses_movement_id" IS NULL)
    ),
    ADD CONSTRAINT "inventory_movements_reason_shape" CHECK (
        ("reverses_movement_id" IS NULL AND "type" IN ('OPENING', 'PURCHASE_RECEIPT', 'COUNT_CORRECTION')
            AND "reason_code" IS NULL AND "reason_note" IS NULL)
        OR ("reverses_movement_id" IS NULL AND "type" = 'ADJUSTMENT'
            AND "reason_code" IS NOT NULL
            AND "reason_code" IN ('FOUND_STOCK', 'DATA_ENTRY_CORRECTION', 'OTHER')
            AND ("reason_code" <> 'OTHER' OR "reason_note" IS NOT NULL))
        OR ("reverses_movement_id" IS NULL AND "type" = 'WRITE_OFF'
            AND "reason_code" IS NOT NULL
            AND "reason_code" IN ('DAMAGED', 'EXPIRED', 'SPOILED', 'THEFT_OR_LOSS', 'OTHER')
            AND ("reason_code" <> 'OTHER' OR "reason_note" IS NOT NULL))
        OR ("reverses_movement_id" IS NOT NULL AND "type" <> 'COUNT_CORRECTION'
            AND "reason_code" IS NULL AND "reason_note" IS NOT NULL)
    );

-- G. COUNT_CORRECTION exactly when the stocktake line is the source (with
-- one_source, no other document can be); never a reversal (deliberately
-- redundant with the direction and reason shapes); never a pack snapshot
-- (pack_shape makes a NULL pack_id clear all four pack columns).
ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_count_correction_source" CHECK (("type" = 'COUNT_CORRECTION') = ("stocktake_id" IS NOT NULL)),
    ADD CONSTRAINT "inventory_movements_count_correction_not_reversible" CHECK ("type" <> 'COUNT_CORRECTION' OR "reverses_movement_id" IS NULL),
    ADD CONSTRAINT "inventory_movements_count_correction_no_pack" CHECK ("type" <> 'COUNT_CORRECTION' OR "pack_id" IS NULL);

-- G. At most one COUNT_CORRECTION per stocktake line.
CREATE UNIQUE INDEX "inventory_movements_count_correction_unique" ON "inventory_movements" ("business_id", "stocktake_id", "variant_id") WHERE "stocktake_id" IS NOT NULL;

-- H. No audit change: business_audit_records_entity_type_format is
-- intentionally a format CHECK (^[a-z][a-z_]*$, at most 64 characters), not a
-- closed entity-type registry, so the "stocktake" entity type is already
-- valid. The application audit registry is the closed list of actions and
-- entity types.

-- I. Privileges: nothing is deleted or truncated. Stocktake headers change
-- only their lifecycle columns, and lines only their count and variance
-- columns, so UPDATE is granted on those columns alone (which also backs
-- their SELECT ... FOR UPDATE row locks). Movements stay insert-only. One
-- statement per table, so the migration scan in verify-schema.mjs sees each
-- grant next to its table name.
GRANT SELECT, INSERT ON "stocktakes" TO tali_app;
GRANT UPDATE ("status", "version", "posted_at", "posted_by_membership_id", "business_date", "cancelled_at", "cancelled_by_membership_id") ON "stocktakes" TO tali_app;
GRANT SELECT, INSERT ON "stocktake_lines" TO tali_app;
GRANT UPDATE ("status", "counted_quantity_minor", "stock_unit_code", "expected_at_count_minor", "balance_version_at_count", "version", "counted_by_membership_id", "counted_at", "variance_minor") ON "stocktake_lines" TO tali_app;

COMMIT;
