-- Build 3 Slice 3: journal entries/lines with valuation-slice typed sources,
-- inventory valuation projections, movement valuation facts and stock
-- valuation documents (ADR-009 sections 7 to 13, 19 and 20).
--
-- Forward-only and atomic: this file carries its own BEGIN/COMMIT, because
-- `prisma migrate deploy` (Prisma 7.10) does not run a migration file in one
-- transaction. Any failing statement aborts the whole file and nothing
-- persists.
--
-- Additive only. No existing table is rewritten and no historical movement
-- is given a value. Untouched stock items stay without a valuation row
-- (UNVALUED, value 0). Charts are not backfilled here.
--
-- The cyclic FKs journal_entries.valuation_id <-> stock_valuations.journal_entry_id
-- are DEFERRABLE INITIALLY DEFERRED so both rows can be inserted in one
-- transaction with pre-generated UUIDs (append-only: no UPDATE of those ids).

BEGIN;

-- A. Tables
CREATE TABLE "journal_entries" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "entry_kind" TEXT NOT NULL,
    "opening_batch_id" UUID,
    "goods_receipt_id" UUID,
    "adjustment_id" UUID,
    "stocktake_id" UUID,
    "valuation_id" UUID,
    "reverses_entry_id" UUID,
    "posting_rule" TEXT NOT NULL,
    "posting_rule_version" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "actor_membership_id" UUID,
    "device_id" UUID,
    "location_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_lines" (
    "business_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "memo_kind" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("business_id", "entry_id", "line_number")
);

CREATE TABLE "inventory_valuations" (
    "business_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "value_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "first_valued_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL,
    "started_from_balance_version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_valuations_pkey" PRIMARY KEY ("business_id", "location_id", "variant_id")
);

CREATE TABLE "inventory_movement_valuations" (
    "business_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "cost_basis" TEXT NOT NULL,
    "value_delta_minor" BIGINT NOT NULL,
    "value_after_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status_after" TEXT NOT NULL,
    "supplied_cost_minor" BIGINT,
    "journal_entry_id" UUID,

    CONSTRAINT "inventory_movement_valuations_pkey" PRIMARY KEY ("business_id", "movement_id")
);

CREATE TABLE "stock_valuations" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity_at_valuation_minor" BIGINT NOT NULL,
    "balance_version_at_valuation" INTEGER NOT NULL,
    "previous_value_minor" BIGINT NOT NULL,
    "new_value_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "journal_entry_id" UUID,
    "actor_membership_id" UUID NOT NULL,
    "device_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_valuations_pkey" PRIMARY KEY ("id")
);

-- B. Unique indexes (composite tenant keys and reversal uniqueness)
CREATE UNIQUE INDEX "journal_entries_business_id_id_key" ON "journal_entries"("business_id", "id");
CREATE UNIQUE INDEX "journal_entries_business_id_id_currency_key" ON "journal_entries"("business_id", "id", "currency");
CREATE UNIQUE INDEX "journal_entries_business_id_reverses_entry_id_key" ON "journal_entries"("business_id", "reverses_entry_id");
CREATE UNIQUE INDEX "stock_valuations_business_id_id_key" ON "stock_valuations"("business_id", "id");
CREATE UNIQUE INDEX "stock_valuations_business_id_journal_entry_id_key" ON "stock_valuations"("business_id", "journal_entry_id");

-- One ORIGINAL entry per typed source (ADR-009 section 13)
CREATE UNIQUE INDEX "journal_entries_original_opening_batch_key"
    ON "journal_entries"("business_id", "opening_batch_id")
    WHERE "entry_kind" = 'ORIGINAL' AND "opening_batch_id" IS NOT NULL;
CREATE UNIQUE INDEX "journal_entries_original_goods_receipt_key"
    ON "journal_entries"("business_id", "goods_receipt_id")
    WHERE "entry_kind" = 'ORIGINAL' AND "goods_receipt_id" IS NOT NULL;
CREATE UNIQUE INDEX "journal_entries_original_adjustment_key"
    ON "journal_entries"("business_id", "adjustment_id")
    WHERE "entry_kind" = 'ORIGINAL' AND "adjustment_id" IS NOT NULL;
CREATE UNIQUE INDEX "journal_entries_original_stocktake_key"
    ON "journal_entries"("business_id", "stocktake_id")
    WHERE "entry_kind" = 'ORIGINAL' AND "stocktake_id" IS NOT NULL;
CREATE UNIQUE INDEX "journal_entries_original_valuation_key"
    ON "journal_entries"("business_id", "valuation_id")
    WHERE "entry_kind" = 'ORIGINAL' AND "valuation_id" IS NOT NULL;

-- C. Foreign keys
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_currency_fkey" FOREIGN KEY ("business_id", "currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_opening_batch_id_fkey" FOREIGN KEY ("business_id", "opening_batch_id") REFERENCES "inventory_opening_batches"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_goods_receipt_id_fkey" FOREIGN KEY ("business_id", "goods_receipt_id") REFERENCES "goods_receipts"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_adjustment_id_fkey" FOREIGN KEY ("business_id", "adjustment_id") REFERENCES "inventory_adjustments"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_stocktake_id_fkey" FOREIGN KEY ("business_id", "stocktake_id") REFERENCES "stocktakes"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_reverses_entry_id_fkey" FOREIGN KEY ("business_id", "reverses_entry_id") REFERENCES "journal_entries"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_business_id_entry_id_fkey" FOREIGN KEY ("business_id", "entry_id") REFERENCES "journal_entries"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_business_id_account_id_fkey" FOREIGN KEY ("business_id", "account_id") REFERENCES "ledger_accounts"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_business_id_entry_id_currency_fkey" FOREIGN KEY ("business_id", "entry_id", "currency") REFERENCES "journal_entries"("business_id", "id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_business_id_currency_fkey" FOREIGN KEY ("business_id", "currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "inventory_movement_valuations" ADD CONSTRAINT "inventory_movement_valuations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inventory_movement_valuations" ADD CONSTRAINT "inventory_movement_valuations_business_id_movement_id_fkey" FOREIGN KEY ("business_id", "movement_id") REFERENCES "inventory_movements"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inventory_movement_valuations" ADD CONSTRAINT "inventory_movement_valuations_business_id_journal_entry_id_fkey" FOREIGN KEY ("business_id", "journal_entry_id") REFERENCES "journal_entries"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "inventory_movement_valuations" ADD CONSTRAINT "inventory_movement_valuations_business_id_currency_fkey" FOREIGN KEY ("business_id", "currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_currency_fkey" FOREIGN KEY ("business_id", "currency") REFERENCES "businesses"("id", "currency_code") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_business_id_valuation_id_fkey" FOREIGN KEY ("business_id", "valuation_id") REFERENCES "stock_valuations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_business_id_journal_entry_id_fkey" FOREIGN KEY ("business_id", "journal_entry_id") REFERENCES "journal_entries"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- D. CHECKs
ALTER TABLE "journal_entries"
    ADD CONSTRAINT "journal_entries_entry_kind_valid" CHECK ("entry_kind" IN ('ORIGINAL', 'REVERSAL')),
    ADD CONSTRAINT "journal_entries_reversal_shape" CHECK (
        ("entry_kind" = 'REVERSAL') = ("reverses_entry_id" IS NOT NULL)
    ),
    ADD CONSTRAINT "journal_entries_one_source" CHECK (
        (CASE WHEN "opening_batch_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "goods_receipt_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "adjustment_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "stocktake_id" IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN "valuation_id" IS NOT NULL THEN 1 ELSE 0 END)
        = 1
    ),
    ADD CONSTRAINT "journal_entries_posting_rule_valid" CHECK ("posting_rule" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    ADD CONSTRAINT "journal_entries_posting_rule_version_positive" CHECK ("posting_rule_version" >= 1),
    ADD CONSTRAINT "journal_entries_description_valid" CHECK (char_length("description") BETWEEN 1 AND 120 AND "description" ~ '^[\x20-\x7E]+$'),
    ADD CONSTRAINT "journal_entries_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "journal_entries_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "journal_entries_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at");

ALTER TABLE "journal_lines"
    ADD CONSTRAINT "journal_lines_line_number_positive" CHECK ("line_number" >= 1),
    ADD CONSTRAINT "journal_lines_direction_valid" CHECK ("direction" IN ('DEBIT', 'CREDIT')),
    ADD CONSTRAINT "journal_lines_amount_positive" CHECK ("amount_minor" > 0),
    ADD CONSTRAINT "journal_lines_memo_kind_valid" CHECK ("memo_kind" IS NULL OR "memo_kind" IN (
        'TENDER_CASH', 'TENDER_BANK_TRANSFER', 'TENDER_POS_CARD', 'TENDER_OTHER',
        'REVENUE', 'DISCOUNT', 'TAX', 'COGS', 'INVENTORY', 'INVENTORY_GAIN',
        'INVENTORY_SHRINKAGE', 'OPENING_VALUATION', 'OPERATIONAL_VALUATION', 'GOODS_RECEIPT'
    ));

ALTER TABLE "inventory_valuations"
    ADD CONSTRAINT "inventory_valuations_status_valid" CHECK ("status" IN ('VALUED', 'UNVALUED')),
    ADD CONSTRAINT "inventory_valuations_value_non_negative" CHECK ("value_minor" >= 0),
    ADD CONSTRAINT "inventory_valuations_version_non_negative" CHECK ("version" >= 0),
    ADD CONSTRAINT "inventory_valuations_started_from_non_negative" CHECK ("started_from_balance_version" >= 0);

ALTER TABLE "inventory_movement_valuations"
    ADD CONSTRAINT "inventory_movement_valuations_cost_basis_valid" CHECK ("cost_basis" IN ('SUPPLIED_COST', 'WEIGHTED_AVERAGE', 'REVERSAL_OF_ORIGINAL', 'NOT_VALUED')),
    ADD CONSTRAINT "inventory_movement_valuations_status_after_valid" CHECK ("status_after" IN ('VALUED', 'UNVALUED')),
    ADD CONSTRAINT "inventory_movement_valuations_value_after_non_negative" CHECK ("value_after_minor" >= 0),
    ADD CONSTRAINT "inventory_movement_valuations_not_valued_zero_delta" CHECK ("cost_basis" <> 'NOT_VALUED' OR "value_delta_minor" = 0);

ALTER TABLE "stock_valuations"
    ADD CONSTRAINT "stock_valuations_kind_valid" CHECK ("kind" IN ('INITIAL_OPENING', 'OPERATIONAL')),
    ADD CONSTRAINT "stock_valuations_quantity_non_negative" CHECK ("quantity_at_valuation_minor" >= 0),
    ADD CONSTRAINT "stock_valuations_previous_value_non_negative" CHECK ("previous_value_minor" >= 0),
    ADD CONSTRAINT "stock_valuations_new_value_non_negative" CHECK ("new_value_minor" >= 0),
    ADD CONSTRAINT "stock_valuations_reason_valid" CHECK (char_length("reason") BETWEEN 1 AND 500 AND "reason" = btrim("reason")),
    ADD CONSTRAINT "stock_valuations_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "stock_valuations_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "stock_valuations_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at");

-- E. Privileges
GRANT SELECT, INSERT ON "journal_entries" TO tali_app;
GRANT SELECT, INSERT ON "journal_lines" TO tali_app;
GRANT SELECT, INSERT ON "inventory_movement_valuations" TO tali_app;
GRANT SELECT, INSERT ON "stock_valuations" TO tali_app;
GRANT SELECT, INSERT ON "inventory_valuations" TO tali_app;
GRANT UPDATE ("status", "value_minor", "first_valued_at", "version", "updated_at") ON "inventory_valuations" TO tali_app;

COMMIT;
