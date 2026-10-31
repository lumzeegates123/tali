-- Build 3 Slice 3 amendment (ADR-009 section 38, 2026-10-29):
-- REVERSAL_RESIDUAL stock valuations and the narrow CHECK changes that let
-- an exact reversal fact record a negative intermediate value_after when
-- paired with a same-transaction residual ORIGINAL journal.
--
-- Forward-only and atomic. Does not rewrite 20261018120000_build3_valuation_journal.
-- Additive: no backfill of residual rows.

BEGIN;

ALTER TABLE "stock_valuations"
    ADD COLUMN "trigger_movement_id" UUID;

ALTER TABLE "inventory_movement_valuations"
    DROP CONSTRAINT "inventory_movement_valuations_value_after_non_negative";

ALTER TABLE "inventory_movement_valuations"
    ADD CONSTRAINT "inventory_movement_valuations_value_after_shape"
    CHECK (("value_after_minor" >= 0) OR ("cost_basis" = 'REVERSAL_OF_ORIGINAL'));

ALTER TABLE "stock_valuations"
    DROP CONSTRAINT "stock_valuations_kind_valid",
    DROP CONSTRAINT "stock_valuations_previous_value_non_negative";

ALTER TABLE "stock_valuations"
    ADD CONSTRAINT "stock_valuations_kind_valid"
        CHECK ("kind" IN ('INITIAL_OPENING', 'OPERATIONAL', 'REVERSAL_RESIDUAL')),
    ADD CONSTRAINT "stock_valuations_previous_value_shape"
        CHECK (("kind" = 'REVERSAL_RESIDUAL') OR ("previous_value_minor" >= 0)),
    ADD CONSTRAINT "stock_valuations_trigger_shape"
        CHECK (("kind" = 'REVERSAL_RESIDUAL') = ("trigger_movement_id" IS NOT NULL)),
    ADD CONSTRAINT "stock_valuations_residual_clears_value"
        CHECK (("kind" <> 'REVERSAL_RESIDUAL') OR ("new_value_minor" = 0));

CREATE UNIQUE INDEX "stock_valuations_one_residual_per_trigger"
    ON "stock_valuations" ("business_id", "trigger_movement_id")
    WHERE "trigger_movement_id" IS NOT NULL;

ALTER TABLE "stock_valuations"
    ADD CONSTRAINT "stock_valuations_trigger_movement_fkey"
    FOREIGN KEY ("business_id", "location_id", "variant_id", "trigger_movement_id")
    REFERENCES "inventory_movements" ("business_id", "location_id", "variant_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMENT ON COLUMN "stock_valuations"."trigger_movement_id" IS
    'Reversal inventory movement that produced this residual correction.';

COMMIT;
