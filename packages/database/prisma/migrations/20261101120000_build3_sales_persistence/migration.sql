-- Build 3 Slice 5: sales persistence and SALE inventory/ledger integration
-- (ADR-011; ADR-009 sections 7, 14 and 28; ADR-008 section 8).
--
-- Forward-only and atomic: this file carries its own BEGIN/COMMIT, because
-- `prisma migrate deploy` (Prisma 7.10) does not run a migration file in one
-- transaction. Any failing statement aborts the whole file and nothing
-- persists.
--
-- Additive only. No existing row is rewritten and nothing is backfilled: no
-- sale exists before this migration, and receipt counters are created lazily
-- by the first sale of each business.
--
-- A sale is written before its original journal and before its SALE
-- movements, all with pre-generated UUIDs in one transaction. Only the two FKs
-- that point forward in that order are DEFERRABLE INITIALLY DEFERRED:
-- sales -> its original journal and sale_lines -> its SALE movement. Every FK
-- pointing back at the sale is immediate. Nothing UPDATEs an immutable
-- snapshot: the original journal id is set on insert, never attached later.

BEGIN;

-- A. Typed SALE sources on the existing movement and journal tables.
ALTER TABLE "inventory_movements" ADD COLUMN     "sale_id" UUID;

ALTER TABLE "journal_entries" ADD COLUMN     "sale_id" UUID;

-- B. Tables
CREATE TABLE "sales" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "gross_total_minor" BIGINT NOT NULL,
    "discount_total_minor" BIGINT NOT NULL,
    "tax_total_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "cost_status" TEXT NOT NULL,
    "cogs_total_minor" BIGINT NOT NULL,
    "recorded_by_membership_id" UUID NOT NULL,
    "device_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "device_reported_at" TIMESTAMPTZ(3),
    "journal_entry_id" UUID NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_membership_id" UUID,
    "reversal_reason" TEXT,
    "reversal_journal_entry_id" UUID,
    "reversal_tender_unwound_confirmed" BOOLEAN,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sale_lines" (
    "business_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_name" TEXT NOT NULL,
    "sku" TEXT,
    "tracked" BOOLEAN NOT NULL,
    "quantity_minor" BIGINT NOT NULL,
    "unit" VARCHAR(16) NOT NULL,
    "unit_scale" SMALLINT NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "price_version" INTEGER NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "discount_kind" TEXT NOT NULL,
    "discount_value" BIGINT NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "tax_treatment_id" UUID,
    "tax_name" TEXT,
    "tax_kind" TEXT NOT NULL,
    "tax_rate_bps" INTEGER,
    "tax_pricing_mode" TEXT,
    "tax_rounding_mode" TEXT,
    "taxable_base_minor" BIGINT NOT NULL,
    "tax_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "cost_status" TEXT NOT NULL,
    "cost_minor" BIGINT,
    "valuation_version_read" INTEGER,
    "movement_id" UUID,

    CONSTRAINT "sale_lines_pkey" PRIMARY KEY ("business_id","sale_id","line_number")
);

CREATE TABLE "sale_tenders" (
    "business_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "tender_number" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reference" TEXT,
    "verification_status" TEXT NOT NULL,
    "cash_received_minor" BIGINT,
    "change_given_minor" BIGINT,

    CONSTRAINT "sale_tenders_pkey" PRIMARY KEY ("business_id","sale_id","tender_number")
);

CREATE TABLE "sale_receipt_sequences" (
    "business_id" UUID NOT NULL,
    "next_number" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sale_receipt_sequences_pkey" PRIMARY KEY ("business_id")
);

-- C. Indexes
CREATE INDEX "sales_business_id_location_id_id_idx" ON "sales"("business_id", "location_id", "id");

CREATE INDEX "sales_business_id_location_id_recorded_by_membership_id_id_idx" ON "sales"("business_id", "location_id", "recorded_by_membership_id", "id");

CREATE UNIQUE INDEX "sales_business_id_id_key" ON "sales"("business_id", "id");

CREATE UNIQUE INDEX "sales_business_id_id_location_id_key" ON "sales"("business_id", "id", "location_id");

CREATE UNIQUE INDEX "sales_business_id_receipt_number_key" ON "sales"("business_id", "receipt_number");

CREATE UNIQUE INDEX "sale_lines_business_id_movement_id_key" ON "sale_lines"("business_id", "movement_id");

CREATE UNIQUE INDEX "inventory_movements_sale_line_target_key" ON "inventory_movements"("business_id", "id", "sale_id", "variant_id");

CREATE UNIQUE INDEX "journal_entries_business_id_id_sale_id_key" ON "journal_entries"("business_id", "id", "sale_id");

-- One ORIGINAL journal per sale; its REVERSAL is bounded by
-- journal_entries_business_id_reverses_entry_id_key.
CREATE UNIQUE INDEX "journal_entries_original_sale_key"
    ON "journal_entries"("business_id", "sale_id")
    WHERE "entry_kind" = 'ORIGINAL' AND "sale_id" IS NOT NULL;

-- D. Foreign keys. Every tenant reference is composite with business_id, so a
-- row can only point at rows of its own business.
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_sale_id_location_id_fkey" FOREIGN KEY ("business_id", "sale_id", "location_id") REFERENCES "sales"("business_id", "id", "location_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_sale_id_location_id_fkey" FOREIGN KEY ("business_id", "sale_id", "location_id") REFERENCES "sales"("business_id", "id", "location_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sales" ADD CONSTRAINT "sales_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sales" ADD CONSTRAINT "sales_business_id_currency_fkey" FOREIGN KEY ("business_id", "currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sales" ADD CONSTRAINT "sales_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sales" ADD CONSTRAINT "sales_business_id_recorded_by_membership_id_fkey" FOREIGN KEY ("business_id", "recorded_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sales" ADD CONSTRAINT "sales_business_id_reversed_by_membership_id_fkey" FOREIGN KEY ("business_id", "reversed_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sales" ADD CONSTRAINT "sales_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The original journal is inserted after the sale in the same transaction.
ALTER TABLE "sales" ADD CONSTRAINT "sales_original_journal_fkey" FOREIGN KEY ("business_id", "journal_entry_id", "id") REFERENCES "journal_entries"("business_id", "id", "sale_id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- The reversal journal is posted before the sale is marked REVERSED.
ALTER TABLE "sales" ADD CONSTRAINT "sales_reversal_journal_fkey" FOREIGN KEY ("business_id", "reversal_journal_entry_id", "id") REFERENCES "journal_entries"("business_id", "id", "sale_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_business_id_sale_id_fkey" FOREIGN KEY ("business_id", "sale_id") REFERENCES "sales"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_unit_fkey" FOREIGN KEY ("unit") REFERENCES "units_of_measure"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The line's SALE movement is inserted after the line in the same
-- transaction, and must belong to the same sale and variant.
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_movement_fkey" FOREIGN KEY ("business_id", "movement_id", "sale_id", "variant_id") REFERENCES "inventory_movements"("business_id", "id", "sale_id", "variant_id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_business_id_sale_id_fkey" FOREIGN KEY ("business_id", "sale_id") REFERENCES "sales"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "sale_receipt_sequences" ADD CONSTRAINT "sale_receipt_sequences_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- E. The movement CHECKs that name the movement types or sources are replaced
-- in place, each by a definition that accepts every row the old one accepted,
-- plus SALE: the sixth type; the sale as a fifth document reference; a
-- negative original and a positive reversal; and no reason on an original.
-- A SALE reversal already needs a reason note and no reason code through the
-- unchanged reversal clause.
ALTER TABLE "inventory_movements"
    DROP CONSTRAINT "inventory_movements_type_valid",
    DROP CONSTRAINT "inventory_movements_one_source",
    DROP CONSTRAINT "inventory_movements_direction",
    DROP CONSTRAINT "inventory_movements_reason_shape";

ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_type_valid" CHECK ("type" IN ('OPENING', 'PURCHASE_RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'COUNT_CORRECTION', 'SALE')),
    ADD CONSTRAINT "inventory_movements_one_source" CHECK (num_nonnulls("opening_batch_id", "goods_receipt_id", "adjustment_id", "stocktake_id", "sale_id") = 1),
    ADD CONSTRAINT "inventory_movements_direction" CHECK (
        ("type" = 'OPENING' AND "reverses_movement_id" IS NULL AND "quantity_delta_minor" > 0)
        OR ("type" = 'PURCHASE_RECEIPT' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" > 0)))
        OR ("type" = 'WRITE_OFF' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" < 0)))
        OR ("type" = 'ADJUSTMENT')
        OR ("type" = 'COUNT_CORRECTION' AND "reverses_movement_id" IS NULL)
        OR ("type" = 'SALE' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" < 0)))
    ),
    ADD CONSTRAINT "inventory_movements_reason_shape" CHECK (
        ("reverses_movement_id" IS NULL AND "type" IN ('OPENING', 'PURCHASE_RECEIPT', 'COUNT_CORRECTION', 'SALE')
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

-- SALE exactly when the sale is the source (with one_source, no other
-- document can be); never a pack snapshot (pack_shape makes a NULL pack_id
-- clear all four pack columns).
ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_sale_source" CHECK (("type" = 'SALE') = ("sale_id" IS NOT NULL)),
    ADD CONSTRAINT "inventory_movements_sale_no_pack" CHECK ("type" <> 'SALE' OR "pack_id" IS NULL);

-- F. The journal source CHECK gains the sale as a sixth typed source. A sale
-- journal must carry its location: the location-scoped FK to the sale is
-- MATCH SIMPLE and would not be checked with a NULL location.
ALTER TABLE "journal_entries"
    DROP CONSTRAINT "journal_entries_one_source";

ALTER TABLE "journal_entries"
    ADD CONSTRAINT "journal_entries_one_source" CHECK (
        (CASE WHEN "opening_batch_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "goods_receipt_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "adjustment_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "stocktake_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "valuation_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "sale_id" IS NOT NULL THEN 1 ELSE 0 END)
        = 1
    ),
    ADD CONSTRAINT "journal_entries_sale_location" CHECK ("sale_id" IS NULL OR "location_id" IS NOT NULL);

-- G. Sale CHECKs. Shapes and ranges only; totals, line arithmetic and
-- posting agreement are domain invariants verified by db:sales-consistency.
ALTER TABLE "sales"
    ADD CONSTRAINT "sales_status_valid" CHECK ("status" IN ('POSTED', 'REVERSED')),
    ADD CONSTRAINT "sales_receipt_number_format" CHECK ("receipt_number" ~ '^S-[0-9]+$'),
    ADD CONSTRAINT "sales_gross_total_positive" CHECK ("gross_total_minor" > 0),
    ADD CONSTRAINT "sales_discount_total_non_negative" CHECK ("discount_total_minor" >= 0),
    ADD CONSTRAINT "sales_tax_total_non_negative" CHECK ("tax_total_minor" >= 0),
    ADD CONSTRAINT "sales_total_positive" CHECK ("total_minor" > 0),
    ADD CONSTRAINT "sales_cost_status_valid" CHECK ("cost_status" IN ('VALUED', 'PARTIAL', 'UNVALUED', 'NOT_APPLICABLE')),
    ADD CONSTRAINT "sales_cogs_total_non_negative" CHECK ("cogs_total_minor" >= 0),
    ADD CONSTRAINT "sales_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "sales_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "sales_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at"),
    ADD CONSTRAINT "sales_reversal_reason_valid" CHECK ("reversal_reason" IS NULL OR (char_length("reversal_reason") BETWEEN 1 AND 500 AND "reversal_reason" = btrim("reversal_reason"))),
    ADD CONSTRAINT "sales_reversal_journal_distinct" CHECK ("reversal_journal_entry_id" IS NULL OR "reversal_journal_entry_id" <> "journal_entry_id"),
    ADD CONSTRAINT "sales_reversal_shape" CHECK (
        ("status" = 'POSTED'
            AND "reversed_at" IS NULL AND "reversed_by_membership_id" IS NULL AND "reversal_reason" IS NULL
            AND "reversal_journal_entry_id" IS NULL AND "reversal_tender_unwound_confirmed" IS NULL)
        OR ("status" = 'REVERSED'
            AND "reversed_at" IS NOT NULL AND "reversed_by_membership_id" IS NOT NULL AND "reversal_reason" IS NOT NULL
            AND "reversal_journal_entry_id" IS NOT NULL AND "reversal_tender_unwound_confirmed" IS NOT NULL
            AND "reversal_tender_unwound_confirmed")
    );

ALTER TABLE "sale_lines"
    ADD CONSTRAINT "sale_lines_line_number_range" CHECK ("line_number" BETWEEN 1 AND 200),
    ADD CONSTRAINT "sale_lines_product_name_valid" CHECK (char_length("product_name") BETWEEN 1 AND 120 AND "product_name" = btrim("product_name")),
    ADD CONSTRAINT "sale_lines_sku_valid" CHECK ("sku" IS NULL OR (char_length("sku") BETWEEN 1 AND 64 AND "sku" = btrim("sku"))),
    ADD CONSTRAINT "sale_lines_quantity_positive" CHECK ("quantity_minor" > 0),
    ADD CONSTRAINT "sale_lines_unit_scale_range" CHECK ("unit_scale" BETWEEN 0 AND 3),
    ADD CONSTRAINT "sale_lines_unit_price_positive" CHECK ("unit_price_minor" > 0),
    ADD CONSTRAINT "sale_lines_price_version_positive" CHECK ("price_version" >= 1),
    ADD CONSTRAINT "sale_lines_gross_positive" CHECK ("gross_minor" > 0),
    ADD CONSTRAINT "sale_lines_discount_range" CHECK ("discount_minor" >= 0 AND "discount_minor" < "gross_minor"),
    ADD CONSTRAINT "sale_lines_net_positive" CHECK ("net_minor" > 0),
    ADD CONSTRAINT "sale_lines_tax_non_negative" CHECK ("tax_minor" >= 0),
    ADD CONSTRAINT "sale_lines_taxable_base_non_negative" CHECK ("taxable_base_minor" >= 0),
    ADD CONSTRAINT "sale_lines_total_positive" CHECK ("total_minor" > 0),
    ADD CONSTRAINT "sale_lines_discount_shape" CHECK (
        ("discount_kind" = 'NONE' AND "discount_value" = 0 AND "discount_minor" = 0)
        OR ("discount_kind" = 'FIXED' AND "discount_value" > 0 AND "discount_value" = "discount_minor")
        OR ("discount_kind" = 'BASIS_POINTS' AND "discount_value" BETWEEN 1 AND 9999)
    ),
    ADD CONSTRAINT "sale_lines_tax_kind_valid" CHECK ("tax_kind" IN ('NONE', 'STANDARD', 'ZERO_RATED', 'EXEMPT')),
    ADD CONSTRAINT "sale_lines_tax_none_shape" CHECK (
        "tax_kind" <> 'NONE'
        OR ("tax_treatment_id" IS NULL AND "tax_name" IS NULL AND "tax_rate_bps" IS NULL
            AND "tax_pricing_mode" IS NULL AND "tax_rounding_mode" IS NULL
            AND "taxable_base_minor" = "net_minor" AND "tax_minor" = 0)
    ),
    ADD CONSTRAINT "sale_lines_tax_name_valid" CHECK ("tax_name" IS NULL OR (char_length("tax_name") BETWEEN 1 AND 120 AND "tax_name" = btrim("tax_name"))),
    ADD CONSTRAINT "sale_lines_tax_rate_range" CHECK ("tax_rate_bps" IS NULL OR "tax_rate_bps" BETWEEN 0 AND 10000),
    ADD CONSTRAINT "sale_lines_tax_pricing_mode_valid" CHECK ("tax_pricing_mode" IS NULL OR "tax_pricing_mode" IN ('EXCLUSIVE', 'INCLUSIVE')),
    ADD CONSTRAINT "sale_lines_tax_rounding_mode_format" CHECK ("tax_rounding_mode" IS NULL OR "tax_rounding_mode" ~ '^[A-Z_]{1,32}$'),
    ADD CONSTRAINT "sale_lines_cost_status_valid" CHECK ("cost_status" IN ('VALUED', 'UNVALUED', 'NOT_APPLICABLE')),
    ADD CONSTRAINT "sale_lines_cost_shape" CHECK (
        (NOT "tracked" AND "cost_status" = 'NOT_APPLICABLE'
            AND "cost_minor" IS NULL AND "valuation_version_read" IS NULL AND "movement_id" IS NULL)
        OR ("tracked" AND "cost_status" = 'VALUED'
            AND "cost_minor" IS NOT NULL AND "cost_minor" >= 0
            AND "valuation_version_read" IS NOT NULL AND "valuation_version_read" >= 0
            AND "movement_id" IS NOT NULL)
        OR ("tracked" AND "cost_status" = 'UNVALUED'
            AND "cost_minor" IS NULL
            AND "valuation_version_read" IS NOT NULL AND "valuation_version_read" >= 0
            AND "movement_id" IS NOT NULL)
    );

ALTER TABLE "sale_tenders"
    ADD CONSTRAINT "sale_tenders_tender_number_range" CHECK ("tender_number" BETWEEN 1 AND 10),
    ADD CONSTRAINT "sale_tenders_method_valid" CHECK ("method" IN ('CASH', 'BANK_TRANSFER', 'POS_CARD', 'OTHER')),
    ADD CONSTRAINT "sale_tenders_amount_positive" CHECK ("amount_minor" > 0),
    ADD CONSTRAINT "sale_tenders_reference_valid" CHECK ("reference" IS NULL OR (char_length("reference") BETWEEN 1 AND 64 AND "reference" = btrim("reference"))),
    ADD CONSTRAINT "sale_tenders_verification_status_valid" CHECK ("verification_status" IN ('NOT_APPLICABLE', 'NOT_VERIFIED')),
    ADD CONSTRAINT "sale_tenders_cash_shape" CHECK (
        ("method" = 'CASH' AND "verification_status" = 'NOT_APPLICABLE'
            AND (("cash_received_minor" IS NULL AND "change_given_minor" IS NULL)
                OR ("cash_received_minor" IS NOT NULL AND "change_given_minor" IS NOT NULL
                    AND "cash_received_minor" >= "amount_minor"
                    AND "change_given_minor" = "cash_received_minor" - "amount_minor")))
        OR ("method" <> 'CASH' AND "verification_status" = 'NOT_VERIFIED'
            AND "cash_received_minor" IS NULL AND "change_given_minor" IS NULL)
    );

ALTER TABLE "sale_receipt_sequences"
    ADD CONSTRAINT "sale_receipt_sequences_next_number_positive" CHECK ("next_number" >= 1);

-- H. Privileges. Sales, lines and tenders are append-only for the
-- application role except the reversal transition of a sale header; the
-- receipt counter only moves forward. No DELETE or TRUNCATE anywhere.
GRANT SELECT, INSERT ON "sales" TO tali_app;
GRANT UPDATE ("status", "reversed_at", "reversed_by_membership_id", "reversal_reason", "reversal_journal_entry_id", "reversal_tender_unwound_confirmed") ON "sales" TO tali_app;
GRANT SELECT, INSERT ON "sale_lines" TO tali_app;
GRANT SELECT, INSERT ON "sale_tenders" TO tali_app;
GRANT SELECT, INSERT ON "sale_receipt_sequences" TO tali_app;
GRANT UPDATE ("next_number", "updated_at") ON "sale_receipt_sequences" TO tali_app;

COMMIT;
