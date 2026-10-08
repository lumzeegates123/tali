-- CreateTable
CREATE TABLE "inventory_opening_batches" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "note" TEXT,
    "actor_membership_id" UUID NOT NULL,
    "device_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_opening_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_membership_id" UUID,
    "reversal_reason" TEXT,
    "actor_membership_id" UUID NOT NULL,
    "device_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_adjustments" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "reason_note" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by_membership_id" UUID,
    "reversal_reason" TEXT,
    "actor_membership_id" UUID NOT NULL,
    "device_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "quantity_delta_minor" BIGINT NOT NULL,
    "balance_after_minor" BIGINT NOT NULL,
    "balance_version" INTEGER NOT NULL,
    "opening_batch_id" UUID,
    "goods_receipt_id" UUID,
    "adjustment_id" UUID,
    "pack_id" UUID,
    "pack_name" TEXT,
    "pack_count" BIGINT,
    "pack_factor_minor" BIGINT,
    "reverses_movement_id" UUID,
    "reason_code" TEXT,
    "reason_note" TEXT,
    "actor_membership_id" UUID NOT NULL,
    "device_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "business_date" DATE NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "business_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity_minor" BIGINT NOT NULL,
    "version" INTEGER NOT NULL,
    "last_movement_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("business_id","location_id","variant_id")
);

-- CreateTable
CREATE TABLE "inventory_stock_thresholds" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "low_stock_threshold_minor" BIGINT,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_stock_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_opening_batches_business_id_id_key" ON "inventory_opening_batches"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_business_id_id_key" ON "goods_receipts"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_adjustments_business_id_id_key" ON "inventory_adjustments"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_adjustments_business_id_id_kind_key" ON "inventory_adjustments"("business_id", "id", "kind");

-- CreateIndex
CREATE INDEX "inventory_movements_business_id_variant_id_idx" ON "inventory_movements"("business_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_business_id_id_key" ON "inventory_movements"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_reversal_target_key" ON "inventory_movements"("business_id", "id", "location_id", "variant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_business_id_location_id_variant_id_id_key" ON "inventory_movements"("business_id", "location_id", "variant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_stock_item_version_key" ON "inventory_movements"("business_id", "location_id", "variant_id", "balance_version");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_business_id_reverses_movement_id_key" ON "inventory_movements"("business_id", "reverses_movement_id");

-- CreateIndex
CREATE INDEX "inventory_balances_business_id_variant_id_idx" ON "inventory_balances"("business_id", "variant_id");

-- CreateIndex
CREATE INDEX "inventory_stock_thresholds_business_id_variant_id_idx" ON "inventory_stock_thresholds"("business_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_thresholds_business_id_id_key" ON "inventory_stock_thresholds"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stock_thresholds_stock_item_key" ON "inventory_stock_thresholds"("business_id", "location_id", "variant_id");

-- AddForeignKey
ALTER TABLE "inventory_opening_batches" ADD CONSTRAINT "inventory_opening_batches_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_opening_batches" ADD CONSTRAINT "inventory_opening_batches_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_opening_batches" ADD CONSTRAINT "inventory_opening_batches_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_opening_batches" ADD CONSTRAINT "inventory_opening_batches_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_business_id_reversed_by_membership_id_fkey" FOREIGN KEY ("business_id", "reversed_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_reversed_by_membership_fkey" FOREIGN KEY ("business_id", "reversed_by_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_device_id_fkey" FOREIGN KEY ("business_id", "device_id") REFERENCES "devices"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_opening_batch_id_fkey" FOREIGN KEY ("business_id", "opening_batch_id") REFERENCES "inventory_opening_batches"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_goods_receipt_id_fkey" FOREIGN KEY ("business_id", "goods_receipt_id") REFERENCES "goods_receipts"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_adjustment_id_type_fkey" FOREIGN KEY ("business_id", "adjustment_id", "type") REFERENCES "inventory_adjustments"("business_id", "id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_business_id_pack_id_variant_id_fkey" FOREIGN KEY ("business_id", "pack_id", "variant_id") REFERENCES "product_packs"("business_id", "id", "variant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversal_fkey" FOREIGN KEY ("business_id", "reverses_movement_id", "location_id", "variant_id", "type") REFERENCES "inventory_movements"("business_id", "id", "location_id", "variant_id", "type") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_last_movement_fkey" FOREIGN KEY ("business_id", "location_id", "variant_id", "last_movement_id") REFERENCES "inventory_movements"("business_id", "location_id", "variant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_stock_thresholds" ADD CONSTRAINT "inventory_stock_thresholds_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_stock_thresholds" ADD CONSTRAINT "inventory_stock_thresholds_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_stock_thresholds" ADD CONSTRAINT "inventory_stock_thresholds_business_id_variant_id_fkey" FOREIGN KEY ("business_id", "variant_id") REFERENCES "product_variants"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Custom SQL (hand-written and reviewed; not generated by Prisma).
-- Build 2 Slice 5 (docs/plans/004-build-2-catalog-inventory.md; ADR-008
-- sections 7, 8, 9 and 11).
--
-- The composite tenant foreign keys above are generated from the Prisma
-- schema: every reference stays in its business, a pack is pinned to the
-- movement's variant, an adjustment movement's type equals its document's
-- kind, a reversal pins the original's location, variant and type, and a
-- balance's last movement belongs to the same stock item. This section adds
-- CHECK constraints, partial unique indexes and privileges. Every object here
-- is listed in scripts/verify-schema.mjs. RLS stays off. No business rule
-- lives in the database: there are no triggers or functions. Quantities are
-- integer minor units of the variant's stock unit, bounded by 10^15; text is
-- normalized by the application and the database checks only the stored shape.
-- ---------------------------------------------------------------------------

-- Document headers: who recorded them, through which channel, and when; an
-- optional trimmed note of 1..500 characters.
ALTER TABLE "inventory_opening_batches"
    ADD CONSTRAINT "inventory_opening_batches_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "inventory_opening_batches_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "inventory_opening_batches_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at"),
    ADD CONSTRAINT "inventory_opening_batches_note_valid" CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" = btrim("note")));

-- Goods receipts: an optional trimmed 1..64 character reference; POSTED, or
-- REVERSED with who, when and a trimmed 1..500 character reason (all three
-- present together, and only when REVERSED).
ALTER TABLE "goods_receipts"
    ADD CONSTRAINT "goods_receipts_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "goods_receipts_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "goods_receipts_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at"),
    ADD CONSTRAINT "goods_receipts_note_valid" CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" = btrim("note"))),
    ADD CONSTRAINT "goods_receipts_reference_valid" CHECK ("reference" IS NULL OR (char_length("reference") BETWEEN 1 AND 64 AND "reference" = btrim("reference"))),
    ADD CONSTRAINT "goods_receipts_status_valid" CHECK ("status" IN ('POSTED', 'REVERSED')),
    ADD CONSTRAINT "goods_receipts_reversed_shape" CHECK (
        ("status" = 'REVERSED') = ("reversed_at" IS NOT NULL)
        AND ("reversed_at" IS NULL) = ("reversed_by_membership_id" IS NULL)
        AND ("reversed_at" IS NULL) = ("reversal_reason" IS NULL)
    ),
    ADD CONSTRAINT "goods_receipts_reversal_reason_valid" CHECK ("reversal_reason" IS NULL OR (char_length("reversal_reason") BETWEEN 1 AND 500 AND "reversal_reason" = btrim("reversal_reason")));

-- Adjustments and write-offs: the kind's closed reason-code list; OTHER needs
-- a trimmed 1..500 character reason note. The general note is separate.
ALTER TABLE "inventory_adjustments"
    ADD CONSTRAINT "inventory_adjustments_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "inventory_adjustments_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "inventory_adjustments_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at"),
    ADD CONSTRAINT "inventory_adjustments_note_valid" CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" = btrim("note"))),
    ADD CONSTRAINT "inventory_adjustments_status_valid" CHECK ("status" IN ('POSTED', 'REVERSED')),
    ADD CONSTRAINT "inventory_adjustments_reversed_shape" CHECK (
        ("status" = 'REVERSED') = ("reversed_at" IS NOT NULL)
        AND ("reversed_at" IS NULL) = ("reversed_by_membership_id" IS NULL)
        AND ("reversed_at" IS NULL) = ("reversal_reason" IS NULL)
    ),
    ADD CONSTRAINT "inventory_adjustments_reversal_reason_valid" CHECK ("reversal_reason" IS NULL OR (char_length("reversal_reason") BETWEEN 1 AND 500 AND "reversal_reason" = btrim("reversal_reason"))),
    ADD CONSTRAINT "inventory_adjustments_kind_valid" CHECK ("kind" IN ('ADJUSTMENT', 'WRITE_OFF')),
    ADD CONSTRAINT "inventory_adjustments_reason_valid" CHECK (
        ("kind" = 'ADJUSTMENT' AND "reason_code" IN ('FOUND_STOCK', 'DATA_ENTRY_CORRECTION', 'OTHER'))
        OR ("kind" = 'WRITE_OFF' AND "reason_code" IN ('DAMAGED', 'EXPIRED', 'SPOILED', 'THEFT_OR_LOSS', 'OTHER'))
    ),
    ADD CONSTRAINT "inventory_adjustments_other_requires_note" CHECK ("reason_code" <> 'OTHER' OR "reason_note" IS NOT NULL),
    ADD CONSTRAINT "inventory_adjustments_reason_note_valid" CHECK ("reason_note" IS NULL OR (char_length("reason_note") BETWEEN 1 AND 500 AND "reason_note" = btrim("reason_note")));

-- Movements (ADR-008 sections 7.1 and 8): the four Slice 5 types; a non-zero
-- delta and the resulting balance within 10^15; exactly one document
-- reference, the one the type requires; the direction an original or a
-- reversal of each type must have; an optional pack snapshot (all four columns
-- or none) whose count times factor is exactly the delta's magnitude, computed
-- in NUMERIC so neither the ABS nor the product can overflow BIGINT; reversals
-- carry no pack and no reason code but the reversal reason as their note.
ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "inventory_movements_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "inventory_movements_recorded_after_occurred" CHECK ("recorded_at" >= "occurred_at"),
    ADD CONSTRAINT "inventory_movements_type_valid" CHECK ("type" IN ('OPENING', 'PURCHASE_RECEIPT', 'ADJUSTMENT', 'WRITE_OFF')),
    ADD CONSTRAINT "inventory_movements_delta_nonzero" CHECK ("quantity_delta_minor" <> 0 AND "quantity_delta_minor" BETWEEN -1000000000000000 AND 1000000000000000),
    ADD CONSTRAINT "inventory_movements_balance_after_range" CHECK ("balance_after_minor" BETWEEN -1000000000000000 AND 1000000000000000),
    ADD CONSTRAINT "inventory_movements_balance_version_positive" CHECK ("balance_version" >= 1),
    ADD CONSTRAINT "inventory_movements_one_source" CHECK (num_nonnulls("opening_batch_id", "goods_receipt_id", "adjustment_id") = 1),
    ADD CONSTRAINT "inventory_movements_opening_source" CHECK (("type" = 'OPENING') = ("opening_batch_id" IS NOT NULL)),
    ADD CONSTRAINT "inventory_movements_receipt_source" CHECK (("type" = 'PURCHASE_RECEIPT') = ("goods_receipt_id" IS NOT NULL)),
    ADD CONSTRAINT "inventory_movements_adjustment_source" CHECK (("type" IN ('ADJUSTMENT', 'WRITE_OFF')) = ("adjustment_id" IS NOT NULL)),
    ADD CONSTRAINT "inventory_movements_direction" CHECK (
        ("type" = 'OPENING' AND "reverses_movement_id" IS NULL AND "quantity_delta_minor" > 0)
        OR ("type" = 'PURCHASE_RECEIPT' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" > 0)))
        OR ("type" = 'WRITE_OFF' AND (("reverses_movement_id" IS NULL) = ("quantity_delta_minor" < 0)))
        OR ("type" = 'ADJUSTMENT')
    ),
    ADD CONSTRAINT "inventory_movements_not_self_reversal" CHECK ("reverses_movement_id" <> "id"),
    ADD CONSTRAINT "inventory_movements_pack_shape" CHECK (
        ("pack_id" IS NULL) = ("pack_name" IS NULL)
        AND ("pack_id" IS NULL) = ("pack_count" IS NULL)
        AND ("pack_id" IS NULL) = ("pack_factor_minor" IS NULL)
    ),
    ADD CONSTRAINT "inventory_movements_pack_arithmetic" CHECK (
        "pack_id" IS NULL
        OR (
            "pack_count" BETWEEN 1 AND 1000000000000000
            AND "pack_factor_minor" BETWEEN 2 AND 1000000000
            AND abs("quantity_delta_minor"::numeric) = "pack_count"::numeric * "pack_factor_minor"::numeric
        )
    ),
    ADD CONSTRAINT "inventory_movements_pack_reversal" CHECK ("reverses_movement_id" IS NULL OR "pack_id" IS NULL),
    ADD CONSTRAINT "inventory_movements_reason_note_valid" CHECK ("reason_note" IS NULL OR (char_length("reason_note") BETWEEN 1 AND 500 AND "reason_note" = btrim("reason_note"))),
    ADD CONSTRAINT "inventory_movements_reason_shape" CHECK (
        ("reverses_movement_id" IS NULL AND "type" IN ('OPENING', 'PURCHASE_RECEIPT')
            AND "reason_code" IS NULL AND "reason_note" IS NULL)
        OR ("reverses_movement_id" IS NULL AND "type" = 'ADJUSTMENT'
            AND "reason_code" IN ('FOUND_STOCK', 'DATA_ENTRY_CORRECTION', 'OTHER')
            AND ("reason_code" <> 'OTHER' OR "reason_note" IS NOT NULL))
        OR ("reverses_movement_id" IS NULL AND "type" = 'WRITE_OFF'
            AND "reason_code" IN ('DAMAGED', 'EXPIRED', 'SPOILED', 'THEFT_OR_LOSS', 'OTHER')
            AND ("reason_code" <> 'OTHER' OR "reason_note" IS NOT NULL))
        OR ("reverses_movement_id" IS NOT NULL AND "reason_code" IS NULL AND "reason_note" IS NOT NULL)
    );

-- Balances (ADR-008 section 7.3): within 10^15 in either direction, with no
-- non-negative CHECK (stock policy belongs to the domain). Version 0 is a row
-- with no movement: no last movement and a zero quantity.
ALTER TABLE "inventory_balances"
    ADD CONSTRAINT "inventory_balances_quantity_range" CHECK ("quantity_minor" BETWEEN -1000000000000000 AND 1000000000000000),
    ADD CONSTRAINT "inventory_balances_version_non_negative" CHECK ("version" >= 0),
    ADD CONSTRAINT "inventory_balances_last_movement_shape" CHECK (("version" = 0) = ("last_movement_id" IS NULL)),
    ADD CONSTRAINT "inventory_balances_empty_is_zero" CHECK ("version" > 0 OR "quantity_minor" = 0);

-- Thresholds (ADR-008 section 7.4): NULL (cleared) or 0..10^15.
ALTER TABLE "inventory_stock_thresholds"
    ADD CONSTRAINT "inventory_stock_thresholds_threshold_range" CHECK ("low_stock_threshold_minor" IS NULL OR "low_stock_threshold_minor" BETWEEN 0 AND 1000000000000000),
    ADD CONSTRAINT "inventory_stock_thresholds_version_positive" CHECK ("version" >= 1),
    ADD CONSTRAINT "inventory_stock_thresholds_updated_after_created" CHECK ("updated_at" >= "created_at");

-- Partial unique indexes: one OPENING movement per stock item, ever; one
-- original line per document and variant (reversals are excluded and limited
-- to one per original by the (business_id, reverses_movement_id) key).
CREATE UNIQUE INDEX "inventory_movements_one_opening" ON "inventory_movements" ("business_id", "location_id", "variant_id") WHERE "type" = 'OPENING';
CREATE UNIQUE INDEX "inventory_movements_opening_line_unique" ON "inventory_movements" ("business_id", "opening_batch_id", "variant_id") WHERE "opening_batch_id" IS NOT NULL AND "reverses_movement_id" IS NULL;
CREATE UNIQUE INDEX "inventory_movements_receipt_line_unique" ON "inventory_movements" ("business_id", "goods_receipt_id", "variant_id") WHERE "goods_receipt_id" IS NOT NULL AND "reverses_movement_id" IS NULL;
CREATE UNIQUE INDEX "inventory_movements_adjustment_line_unique" ON "inventory_movements" ("business_id", "adjustment_id", "variant_id") WHERE "adjustment_id" IS NOT NULL AND "reverses_movement_id" IS NULL;

-- Privileges: nothing is deleted or truncated. Movements and opening batches
-- are insert-only. Receipt and adjustment headers change only POSTED to
-- REVERSED, so UPDATE is granted on the four reversal columns alone (which
-- also backs their SELECT ... FOR UPDATE row locks). Balances and thresholds
-- are updated in place under version checks. One statement per table, so the
-- migration scan in verify-schema.mjs sees each grant next to its table name.
GRANT SELECT, INSERT ON "inventory_opening_batches" TO tali_app;
GRANT SELECT, INSERT ON "goods_receipts" TO tali_app;
GRANT UPDATE ("status", "reversed_at", "reversed_by_membership_id", "reversal_reason") ON "goods_receipts" TO tali_app;
GRANT SELECT, INSERT ON "inventory_adjustments" TO tali_app;
GRANT UPDATE ("status", "reversed_at", "reversed_by_membership_id", "reversal_reason") ON "inventory_adjustments" TO tali_app;
GRANT SELECT, INSERT ON "inventory_movements" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "inventory_balances" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "inventory_stock_thresholds" TO tali_app;
