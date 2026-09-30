-- CreateTable
CREATE TABLE "business_audit_records" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_membership_id" UUID,
    "actor_name" TEXT,
    "device_id" UUID,
    "location_id" UUID,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "idempotency_key" UUID,
    "reason" TEXT,
    "payload" JSON NOT NULL,
    "payload_schema_version" INTEGER NOT NULL,

    CONSTRAINT "business_audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_records" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "subject_user_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_name" TEXT,
    "source_channel" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "idempotency_key" UUID,
    "reason" TEXT,
    "payload" JSON NOT NULL,
    "payload_schema_version" INTEGER NOT NULL,

    CONSTRAINT "platform_audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "time_zone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_memberships" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currencies" (
    "code" VARCHAR(3) NOT NULL,
    "minor_unit_digits" SMALLINT NOT NULL,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "user_idempotency_records" (
    "user_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "fingerprint" BYTEA NOT NULL,
    "fingerprint_version" INTEGER NOT NULL,
    "result" JSON NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_idempotency_records" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "fingerprint" BYTEA NOT NULL,
    "fingerprint_version" INTEGER NOT NULL,
    "result" JSON NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_locations" (
    "business_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_audit_records_business_id_id_key" ON "business_audit_records"("business_id", "id");

-- CreateIndex
CREATE INDEX "business_memberships_user_id_idx" ON "business_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_memberships_business_id_id_key" ON "business_memberships"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_memberships_business_id_user_id_key" ON "business_memberships"("business_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_idempotency_records_user_id_idempotency_key_key" ON "user_idempotency_records"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "business_idempotency_records_business_id_id_key" ON "business_idempotency_records"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "business_idempotency_records_business_id_actor_type_actor_i_key" ON "business_idempotency_records"("business_id", "actor_type", "actor_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "external_identities_user_id_idx" ON "external_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_provider_provider_subject_key" ON "external_identities"("provider", "provider_subject");

-- CreateIndex
CREATE UNIQUE INDEX "business_locations_business_id_id_key" ON "business_locations"("business_id", "id");

-- AddForeignKey
ALTER TABLE "business_audit_records" ADD CONSTRAINT "business_audit_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_audit_records" ADD CONSTRAINT "business_audit_records_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_audit_records" ADD CONSTRAINT "business_audit_records_business_id_actor_membership_id_fkey" FOREIGN KEY ("business_id", "actor_membership_id") REFERENCES "business_memberships"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_audit_records" ADD CONSTRAINT "business_audit_records_business_id_location_id_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "business_locations"("business_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_records" ADD CONSTRAINT "platform_audit_records_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_records" ADD CONSTRAINT "platform_audit_records_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_idempotency_records" ADD CONSTRAINT "user_idempotency_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_idempotency_records" ADD CONSTRAINT "business_idempotency_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Custom SQL (hand-written and reviewed; not generated by Prisma).
-- Build 1 Slice 2 (docs/plans/003-build-1-identity-tenancy.md sections 2 and 9;
-- ADR-004 sections 4 and 8; ADR-005 sections 3 to 10, 19 and 20).
--
-- The composite tenant foreign keys above are generated from the Prisma
-- schema. This section adds what the Prisma schema cannot express: CHECK
-- constraints, the partial unique index, privileges and reference data. Every
-- object here is listed in scripts/verify-schema.mjs. RLS stays off
-- (ADR-002 section 21). No business rule lives in the database: there are no
-- triggers or functions.
-- ---------------------------------------------------------------------------

-- currencies: ISO 4217 alphabetic code and minor-unit exponent 0..4.
ALTER TABLE "currencies"
    ADD CONSTRAINT "currencies_code_format" CHECK ("code" ~ '^[A-Z]{3}$'),
    ADD CONSTRAINT "currencies_minor_unit_digits_range" CHECK ("minor_unit_digits" BETWEEN 0 AND 4);

-- users: display name 1..100 characters, already trimmed by the domain contract.
ALTER TABLE "users"
    ADD CONSTRAINT "users_display_name_length" CHECK (char_length("display_name") BETWEEN 1 AND 100),
    ADD CONSTRAINT "users_display_name_trimmed" CHECK ("display_name" = btrim("display_name")),
    ADD CONSTRAINT "users_status_valid" CHECK ("status" IN ('ACTIVE', 'DISABLED'));

-- external_identities: persisted providers are the real execution modes only.
-- The test fake reports one of these and adds no category (ADR-005 section 3).
ALTER TABLE "external_identities"
    ADD CONSTRAINT "external_identities_provider_valid" CHECK ("provider" IN ('COGNITO', 'LOCAL')),
    ADD CONSTRAINT "external_identities_provider_subject_length" CHECK (char_length("provider_subject") BETWEEN 1 AND 255);

-- businesses: the time zone is already a canonical IANA name chosen by the
-- domain's reference dataset; these checks are structural bounds only (they
-- reject raw offsets such as '+01:00').
ALTER TABLE "businesses"
    ADD CONSTRAINT "businesses_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    ADD CONSTRAINT "businesses_name_trimmed" CHECK ("name" = btrim("name")),
    ADD CONSTRAINT "businesses_time_zone_length" CHECK (char_length("time_zone") BETWEEN 1 AND 64),
    ADD CONSTRAINT "businesses_time_zone_format" CHECK ("time_zone" ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'),
    ADD CONSTRAINT "businesses_status_valid" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'));

-- business_locations: a default location is ACTIVE, and a business has at most
-- one ACTIVE default location. "At least one" is guaranteed by CreateBusiness.
ALTER TABLE "business_locations"
    ADD CONSTRAINT "business_locations_name_length" CHECK (char_length("name") BETWEEN 1 AND 120),
    ADD CONSTRAINT "business_locations_name_trimmed" CHECK ("name" = btrim("name")),
    ADD CONSTRAINT "business_locations_status_valid" CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
    ADD CONSTRAINT "business_locations_default_is_active" CHECK (NOT "is_default" OR "status" = 'ACTIVE');

CREATE UNIQUE INDEX "business_locations_one_active_default"
    ON "business_locations" ("business_id")
    WHERE "is_default" AND "status" = 'ACTIVE';

-- business_memberships: the five approved roles (no roles table), two statuses,
-- and a positive optimistic-concurrency version.
ALTER TABLE "business_memberships"
    ADD CONSTRAINT "business_memberships_role_valid" CHECK ("role" IN ('OWNER', 'MANAGER', 'CASHIER', 'STOCK_KEEPER', 'ACCOUNTANT')),
    ADD CONSTRAINT "business_memberships_status_valid" CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
    ADD CONSTRAINT "business_memberships_version_positive" CHECK ("version" >= 1);

-- business_audit_records: the ADR-004 section 8.2 envelope. A user actor always
-- names the membership it acted through; other actors are named instead.
ALTER TABLE "business_audit_records"
    ADD CONSTRAINT "business_audit_records_action_format" CHECK (char_length("action") <= 100 AND "action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
    ADD CONSTRAINT "business_audit_records_entity_type_format" CHECK (char_length("entity_type") <= 64 AND "entity_type" ~ '^[a-z][a-z_]*$'),
    ADD CONSTRAINT "business_audit_records_actor_type_valid" CHECK ("actor_type" IN ('user', 'system', 'integration')),
    ADD CONSTRAINT "business_audit_records_actor_shape" CHECK (
        ("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "actor_membership_id" IS NOT NULL AND "actor_name" IS NULL)
        OR ("actor_type" IN ('system', 'integration') AND "actor_user_id" IS NULL AND "actor_membership_id" IS NULL AND "actor_name" IS NOT NULL)),
    ADD CONSTRAINT "business_audit_records_actor_name_length" CHECK ("actor_name" IS NULL OR char_length("actor_name") BETWEEN 1 AND 100),
    ADD CONSTRAINT "business_audit_records_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "business_audit_records_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "business_audit_records_reason_bounds" CHECK ("reason" IS NULL OR (char_length("reason") BETWEEN 1 AND 500 AND "reason" ~ '[^[:space:]]')),
    ADD CONSTRAINT "business_audit_records_payload_object" CHECK (json_typeof("payload") = 'object'),
    ADD CONSTRAINT "business_audit_records_payload_size" CHECK (octet_length("payload"::text) <= 8192),
    ADD CONSTRAINT "business_audit_records_payload_schema_version_positive" CHECK ("payload_schema_version" >= 1);

-- platform_audit_records: the same envelope with the subject user instead of a
-- business. Actors are the user themselves or a named system process.
ALTER TABLE "platform_audit_records"
    ADD CONSTRAINT "platform_audit_records_action_format" CHECK (char_length("action") <= 100 AND "action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
    ADD CONSTRAINT "platform_audit_records_entity_type_format" CHECK (char_length("entity_type") <= 64 AND "entity_type" ~ '^[a-z][a-z_]*$'),
    ADD CONSTRAINT "platform_audit_records_actor_type_valid" CHECK ("actor_type" IN ('user', 'system')),
    ADD CONSTRAINT "platform_audit_records_actor_shape" CHECK (
        ("actor_type" = 'user' AND "actor_user_id" IS NOT NULL AND "actor_name" IS NULL)
        OR ("actor_type" = 'system' AND "actor_user_id" IS NULL AND "actor_name" IS NOT NULL)),
    ADD CONSTRAINT "platform_audit_records_actor_name_length" CHECK ("actor_name" IS NULL OR char_length("actor_name") BETWEEN 1 AND 100),
    ADD CONSTRAINT "platform_audit_records_source_channel_valid" CHECK ("source_channel" IN ('web', 'mobile', 'whatsapp', 'api', 'webhook', 'ai_assistant', 'offline_sync', 'system')),
    ADD CONSTRAINT "platform_audit_records_correlation_id_format" CHECK ("correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$'),
    ADD CONSTRAINT "platform_audit_records_reason_bounds" CHECK ("reason" IS NULL OR (char_length("reason") BETWEEN 1 AND 500 AND "reason" ~ '[^[:space:]]')),
    ADD CONSTRAINT "platform_audit_records_payload_object" CHECK (json_typeof("payload") = 'object'),
    ADD CONSTRAINT "platform_audit_records_payload_size" CHECK (octet_length("payload"::text) <= 8192),
    ADD CONSTRAINT "platform_audit_records_payload_schema_version_positive" CHECK ("payload_schema_version" >= 1);

-- user_idempotency_records (ADR-004 section 4.2): the actor is always the user.
-- The result limit is 16 KiB of stored UTF-8 bytes; retention is at least 30
-- days, measured in hours so the check does not depend on the session time zone.
ALTER TABLE "user_idempotency_records"
    ADD CONSTRAINT "user_idempotency_records_actor_is_user" CHECK ("actor_type" = 'user' AND "actor_id" = "user_id"::text),
    ADD CONSTRAINT "user_idempotency_records_operation_format" CHECK (char_length("operation") <= 100 AND "operation" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*\.v[1-9][0-9]*$'),
    ADD CONSTRAINT "user_idempotency_records_fingerprint_length" CHECK (octet_length("fingerprint") = 32),
    ADD CONSTRAINT "user_idempotency_records_fingerprint_version_positive" CHECK ("fingerprint_version" >= 1),
    ADD CONSTRAINT "user_idempotency_records_result_size" CHECK (octet_length("result"::text) <= 16384),
    ADD CONSTRAINT "user_idempotency_records_resource_type_format" CHECK (char_length("resource_type") <= 64 AND "resource_type" ~ '^[a-z][a-z_]*$'),
    ADD CONSTRAINT "user_idempotency_records_retention" CHECK ("expires_at" >= "created_at" + interval '720 hours');

-- business_idempotency_records (ADR-004 section 4.2): the actor is part of the
-- uniqueness scope; a user actor is identified by its user ID.
ALTER TABLE "business_idempotency_records"
    ADD CONSTRAINT "business_idempotency_records_actor_type_valid" CHECK ("actor_type" IN ('user', 'system', 'integration')),
    ADD CONSTRAINT "business_idempotency_records_actor_id_format" CHECK (
        char_length("actor_id") BETWEEN 1 AND 128
        AND ("actor_type" <> 'user' OR "actor_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    ADD CONSTRAINT "business_idempotency_records_operation_format" CHECK (char_length("operation") <= 100 AND "operation" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*\.v[1-9][0-9]*$'),
    ADD CONSTRAINT "business_idempotency_records_fingerprint_length" CHECK (octet_length("fingerprint") = 32),
    ADD CONSTRAINT "business_idempotency_records_fingerprint_version_positive" CHECK ("fingerprint_version" >= 1),
    ADD CONSTRAINT "business_idempotency_records_result_size" CHECK (octet_length("result"::text) <= 16384),
    ADD CONSTRAINT "business_idempotency_records_resource_type_format" CHECK (char_length("resource_type") <= 64 AND "resource_type" ~ '^[a-z][a-z_]*$'),
    ADD CONSTRAINT "business_idempotency_records_retention" CHECK ("expires_at" >= "created_at" + interval '720 hours');

-- Privileges. Explicit grants only (there are no default privileges). The
-- application role never receives DELETE or TRUNCATE on any Build 1 table
-- (ADR-005 section 20). One statement per table, so the migration scan in
-- verify-schema.mjs sees each grant next to its table name.
--   currencies:                  reference data, read-only.
--   users, businesses,
--   business_locations,
--   business_memberships:        read, create and change state (UPDATE also
--                                backs the SELECT ... FOR UPDATE business lock).
--   external_identities:         read and create; an identity link is immutable.
--   audit and idempotency tables: insert-only (ADR-004 sections 4.2 and 8.1).
GRANT SELECT ON "currencies" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "users" TO tali_app;
GRANT SELECT, INSERT ON "external_identities" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "businesses" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "business_locations" TO tali_app;
GRANT SELECT, INSERT, UPDATE ON "business_memberships" TO tali_app;
GRANT SELECT, INSERT ON "business_audit_records" TO tali_app;
GRANT SELECT, INSERT ON "platform_audit_records" TO tali_app;
GRANT SELECT, INSERT ON "user_idempotency_records" TO tali_app;
GRANT SELECT, INSERT ON "business_idempotency_records" TO tali_app;

-- Currency reference data: the private-pilot production currency only
-- (ADR-005 section 5). NGN has the ISO 4217 minor-unit exponent 2. Further
-- legitimate ISO 4217 rows arrive through reviewed migrations; tests add their
-- own fixture currencies to the disposable test database.
INSERT INTO "currencies" ("code", "minor_unit_digits") VALUES ('NGN', 2);
