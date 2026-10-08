// Post-migration schema verification (plan section 23). Run after
// `prisma migrate deploy` against a database, as the owner role
// (MIGRATION_DATABASE_URL). Verifies what Prisma's drift check cannot see:
// custom constraints, partial indexes and privileges. Also scans committed
// migrations for destructive SQL against protected tables.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const APP_ROLE = "tali_app";
const migrationsDir = fileURLToPath(new URL("../prisma/migrations", import.meta.url));

/**
 * Tables the application role may never UPDATE or DELETE, including tables
 * that no longer exist, so the scan keeps covering every migration that
 * touched them. Audit and keyed-idempotency records are insert-only
 * (ADR-004 sections 4.2 and 8.1). Unit reference data is read-only and price
 * history is insert-only (ADR-008 sections 3.4 and 4.2). Inventory movements
 * and opening batches are append-only (ADR-008 sections 7.1 and 11).
 */
const PROTECTED_TABLES = [
  "foundation_spike.protected_entry",
  "public.business_audit_records",
  "public.platform_audit_records",
  "public.user_idempotency_records",
  "public.business_idempotency_records",
  "public.units_of_measure",
  "public.product_variant_prices",
  "public.inventory_movements",
  "public.inventory_opening_batches",
];

/**
 * Tables that are never hard-deleted (ADR-005 section 20; ADR-008 section 14):
 * no migration may drop, truncate or delete from them, or grant DELETE,
 * TRUNCATE or ALL on them. UPDATE grants are checked by
 * EXPECTED_APP_PRIVILEGES.
 */
const NO_DELETE_TABLES = [
  "public.currencies",
  "public.users",
  "public.external_identities",
  "public.businesses",
  "public.business_locations",
  "public.business_memberships",
  "public.business_invitations",
  "public.devices",
  "public.product_categories",
  "public.products",
  "public.product_variants",
  "public.product_packs",
  "public.goods_receipts",
  "public.inventory_adjustments",
  "public.inventory_balances",
  "public.inventory_stock_thresholds",
];

/**
 * Migrations whose destructive statements were explicitly approved by the
 * maintainers. The tali:allow-destructive marker is honoured only inside these
 * migrations; anywhere else it is itself a failure.
 */
const APPROVED_DESTRUCTIVE_MIGRATIONS = {
  "20260928025500_remove_foundation_spike":
    "Removes the temporary Wave B foundation_spike test schema (no business data); approved 2026-09-27.",
};

/** Schemas that were removed and must never exist again. */
const REMOVED_SCHEMAS = ["foundation_spike"];

/**
 * Test-only schemas (packages/database/test/support/fixtures.ts). They are
 * created by the integration-test setup in the disposable test database only:
 * never mentioned by a migration, never present in a verified database.
 */
const TEST_ONLY_SCHEMAS = ["test_fixtures"];

/**
 * Exact table privileges expected for the application role (Build 1 Slice 2
 * and Slice 5, Build 2 Slice 2 and Slice 5 migrations). No table grants
 * DELETE or TRUNCATE; audit, idempotency, price-history, movement and
 * opening-batch tables are insert-only; currencies and units of measure are
 * read-only. Receipt and adjustment headers have no table-level UPDATE: see
 * EXPECTED_APP_COLUMN_PRIVILEGES.
 */
const EXPECTED_APP_PRIVILEGES = {
  "public.currencies": ["SELECT"],
  "public.users": ["INSERT", "SELECT", "UPDATE"],
  "public.external_identities": ["INSERT", "SELECT"],
  "public.businesses": ["INSERT", "SELECT", "UPDATE"],
  "public.business_locations": ["INSERT", "SELECT", "UPDATE"],
  "public.business_memberships": ["INSERT", "SELECT", "UPDATE"],
  "public.business_audit_records": ["INSERT", "SELECT"],
  "public.platform_audit_records": ["INSERT", "SELECT"],
  "public.user_idempotency_records": ["INSERT", "SELECT"],
  "public.business_idempotency_records": ["INSERT", "SELECT"],
  "public.business_invitations": ["INSERT", "SELECT", "UPDATE"],
  "public.devices": ["INSERT", "SELECT", "UPDATE"],
  "public.units_of_measure": ["SELECT"],
  "public.product_categories": ["INSERT", "SELECT", "UPDATE"],
  "public.products": ["INSERT", "SELECT", "UPDATE"],
  "public.product_variants": ["INSERT", "SELECT", "UPDATE"],
  "public.product_packs": ["INSERT", "SELECT", "UPDATE"],
  "public.product_variant_prices": ["INSERT", "SELECT"],
  "public.inventory_opening_batches": ["INSERT", "SELECT"],
  "public.goods_receipts": ["INSERT", "SELECT"],
  "public.inventory_adjustments": ["INSERT", "SELECT"],
  "public.inventory_movements": ["INSERT", "SELECT"],
  "public.inventory_balances": ["INSERT", "SELECT", "UPDATE"],
  "public.inventory_stock_thresholds": ["INSERT", "SELECT", "UPDATE"],
};

/**
 * Exact column-level privileges expected for the application role, read from
 * pg_attribute.attacl. The only column grants are UPDATE on the four reversal
 * columns of the receipt and adjustment headers (POSTED to REVERSED; ADR-008
 * section 11); no other column of any table carries a grant to the role.
 */
const REVERSAL_COLUMNS = ["reversal_reason", "reversed_at", "reversed_by_membership_id", "status"];
const EXPECTED_APP_COLUMN_PRIVILEGES = {
  "public.goods_receipts": Object.fromEntries(REVERSAL_COLUMNS.map((column) => [column, ["UPDATE"]])),
  "public.inventory_adjustments": Object.fromEntries(REVERSAL_COLUMNS.map((column) => [column, ["UPDATE"]])),
};

const ENVELOPE_SOURCE_CHANNELS =
  "ARRAY['web'::text, 'mobile'::text, 'whatsapp'::text, 'api'::text, 'webhook'::text, 'ai_assistant'::text, 'offline_sync'::text, 'system'::text]";
const UUID_TEXT = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text";

/** The audit envelope CHECKs shared by both audit tables (ADR-004 section 8.2). */
function auditEnvelopeChecks(table) {
  return [
    {
      table,
      name: `${table}_action_format`,
      definition: "CHECK (((char_length(action) <= 100) AND (action ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'::text)))",
    },
    {
      table,
      name: `${table}_entity_type_format`,
      definition: "CHECK (((char_length(entity_type) <= 64) AND (entity_type ~ '^[a-z][a-z_]*$'::text)))",
    },
    {
      table,
      name: `${table}_actor_name_length`,
      definition:
        "CHECK (((actor_name IS NULL) OR ((char_length(actor_name) >= 1) AND (char_length(actor_name) <= 100))))",
    },
    {
      table,
      name: `${table}_source_channel_valid`,
      definition: `CHECK ((source_channel = ANY (${ENVELOPE_SOURCE_CHANNELS})))`,
    },
    {
      table,
      name: `${table}_correlation_id_format`,
      definition: "CHECK ((correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'::text))",
    },
    {
      table,
      name: `${table}_reason_bounds`,
      definition:
        "CHECK (((reason IS NULL) OR (((char_length(reason) >= 1) AND (char_length(reason) <= 500)) AND (reason ~ '[^[:space:]]'::text))))",
    },
    { table, name: `${table}_payload_object`, definition: "CHECK ((json_typeof(payload) = 'object'::text))" },
    { table, name: `${table}_payload_size`, definition: "CHECK ((octet_length((payload)::text) <= 8192))" },
    {
      table,
      name: `${table}_payload_schema_version_positive`,
      definition: "CHECK ((payload_schema_version >= 1))",
    },
  ];
}

/** The keyed-idempotency CHECKs shared by both scopes (ADR-004 sections 4.2 and 13). */
function idempotencyChecks(table) {
  return [
    {
      table,
      name: `${table}_operation_format`,
      definition:
        "CHECK (((char_length(operation) <= 100) AND (operation ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)*\\.v[1-9][0-9]*$'::text)))",
    },
    { table, name: `${table}_fingerprint_length`, definition: "CHECK ((octet_length(fingerprint) = 32))" },
    { table, name: `${table}_fingerprint_version_positive`, definition: "CHECK ((fingerprint_version >= 1))" },
    { table, name: `${table}_result_size`, definition: "CHECK ((octet_length((result)::text) <= 16384))" },
    {
      table,
      name: `${table}_resource_type_format`,
      definition: "CHECK (((char_length(resource_type) <= 64) AND (resource_type ~ '^[a-z][a-z_]*$'::text)))",
    },
    {
      table,
      name: `${table}_retention`,
      definition: "CHECK ((expires_at >= (created_at + '720:00:00'::interval)))",
    },
  ];
}

/** An optional, trimmed text column of 1..max characters. */
function trimmedTextCheck(table, column, max) {
  return {
    table,
    name: `${table}_${column}_valid`,
    definition: `CHECK (((${column} IS NULL) OR (((char_length(${column}) >= 1) AND (char_length(${column}) <= ${max})) AND (${column} = btrim(${column})))))`,
  };
}

/** The recording CHECKs shared by every inventory document and movement (ADR-008 section 11). */
function inventoryRecordingChecks(table) {
  return [
    {
      table,
      name: `${table}_source_channel_valid`,
      definition: `CHECK ((source_channel = ANY (${ENVELOPE_SOURCE_CHANNELS})))`,
    },
    {
      table,
      name: `${table}_correlation_id_format`,
      definition: "CHECK ((correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$'::text))",
    },
    { table, name: `${table}_recorded_after_occurred`, definition: "CHECK ((recorded_at >= occurred_at))" },
  ];
}

/** POSTED or REVERSED, with who, when and why present exactly when REVERSED. */
function documentReversalChecks(table) {
  return [
    {
      table,
      name: `${table}_status_valid`,
      definition: "CHECK ((status = ANY (ARRAY['POSTED'::text, 'REVERSED'::text])))",
    },
    {
      table,
      name: `${table}_reversed_shape`,
      definition:
        "CHECK ((((status = 'REVERSED'::text) = (reversed_at IS NOT NULL)) AND ((reversed_at IS NULL) = (reversed_by_membership_id IS NULL)) AND ((reversed_at IS NULL) = (reversal_reason IS NULL))))",
    },
    trimmedTextCheck(table, "reversal_reason", 500),
  ];
}

const QUANTITY_BOUND = "'1000000000000000'::bigint";
const ADJUSTMENT_REASON_CODES = "ARRAY['FOUND_STOCK'::text, 'DATA_ENTRY_CORRECTION'::text, 'OTHER'::text]";
const WRITE_OFF_REASON_CODES =
  "ARRAY['DAMAGED'::text, 'EXPIRED'::text, 'SPOILED'::text, 'THEFT_OR_LOSS'::text, 'OTHER'::text]";

/** The Build 2 Slice 5 inventory CHECKs (ADR-008 sections 7, 8 and 11; plan section O). */
const INVENTORY_CHECKS = [
  ...inventoryRecordingChecks("inventory_opening_batches"),
  trimmedTextCheck("inventory_opening_batches", "note", 500),
  ...inventoryRecordingChecks("goods_receipts"),
  trimmedTextCheck("goods_receipts", "note", 500),
  trimmedTextCheck("goods_receipts", "reference", 64),
  ...documentReversalChecks("goods_receipts"),
  ...inventoryRecordingChecks("inventory_adjustments"),
  trimmedTextCheck("inventory_adjustments", "note", 500),
  ...documentReversalChecks("inventory_adjustments"),
  {
    table: "inventory_adjustments",
    name: "inventory_adjustments_kind_valid",
    definition: "CHECK ((kind = ANY (ARRAY['ADJUSTMENT'::text, 'WRITE_OFF'::text])))",
  },
  {
    table: "inventory_adjustments",
    name: "inventory_adjustments_reason_valid",
    definition: `CHECK ((((kind = 'ADJUSTMENT'::text) AND (reason_code = ANY (${ADJUSTMENT_REASON_CODES}))) OR ((kind = 'WRITE_OFF'::text) AND (reason_code = ANY (${WRITE_OFF_REASON_CODES})))))`,
  },
  {
    table: "inventory_adjustments",
    name: "inventory_adjustments_other_requires_note",
    definition: "CHECK (((reason_code <> 'OTHER'::text) OR (reason_note IS NOT NULL)))",
  },
  trimmedTextCheck("inventory_adjustments", "reason_note", 500),
  ...inventoryRecordingChecks("inventory_movements"),
  {
    table: "inventory_movements",
    name: "inventory_movements_type_valid",
    definition:
      "CHECK ((type = ANY (ARRAY['OPENING'::text, 'PURCHASE_RECEIPT'::text, 'ADJUSTMENT'::text, 'WRITE_OFF'::text])))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_delta_nonzero",
    definition: `CHECK (((quantity_delta_minor <> 0) AND ((quantity_delta_minor >= '-1000000000000000'::bigint) AND (quantity_delta_minor <= ${QUANTITY_BOUND}))))`,
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_balance_after_range",
    definition: `CHECK (((balance_after_minor >= '-1000000000000000'::bigint) AND (balance_after_minor <= ${QUANTITY_BOUND})))`,
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_balance_version_positive",
    definition: "CHECK ((balance_version >= 1))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_one_source",
    definition: "CHECK ((num_nonnulls(opening_batch_id, goods_receipt_id, adjustment_id) = 1))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_opening_source",
    definition: "CHECK (((type = 'OPENING'::text) = (opening_batch_id IS NOT NULL)))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_receipt_source",
    definition: "CHECK (((type = 'PURCHASE_RECEIPT'::text) = (goods_receipt_id IS NOT NULL)))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_adjustment_source",
    definition: "CHECK (((type = ANY (ARRAY['ADJUSTMENT'::text, 'WRITE_OFF'::text])) = (adjustment_id IS NOT NULL)))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_direction",
    definition:
      "CHECK ((((type = 'OPENING'::text) AND (reverses_movement_id IS NULL) AND (quantity_delta_minor > 0)) OR ((type = 'PURCHASE_RECEIPT'::text) AND ((reverses_movement_id IS NULL) = (quantity_delta_minor > 0))) OR ((type = 'WRITE_OFF'::text) AND ((reverses_movement_id IS NULL) = (quantity_delta_minor < 0))) OR (type = 'ADJUSTMENT'::text)))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_not_self_reversal",
    definition: "CHECK ((reverses_movement_id <> id))",
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_pack_shape",
    definition:
      "CHECK ((((pack_id IS NULL) = (pack_name IS NULL)) AND ((pack_id IS NULL) = (pack_count IS NULL)) AND ((pack_id IS NULL) = (pack_factor_minor IS NULL))))",
  },
  // Exact NUMERIC arithmetic: cast before ABS and before the product, so
  // neither can overflow BIGINT; no floating-point type is involved.
  {
    table: "inventory_movements",
    name: "inventory_movements_pack_arithmetic",
    definition: `CHECK (((pack_id IS NULL) OR (((pack_count >= 1) AND (pack_count <= ${QUANTITY_BOUND})) AND ((pack_factor_minor >= 2) AND (pack_factor_minor <= 1000000000)) AND (abs((quantity_delta_minor)::numeric) = ((pack_count)::numeric * (pack_factor_minor)::numeric)))))`,
  },
  {
    table: "inventory_movements",
    name: "inventory_movements_pack_reversal",
    definition: "CHECK (((reverses_movement_id IS NULL) OR (pack_id IS NULL)))",
  },
  trimmedTextCheck("inventory_movements", "reason_note", 500),
  {
    table: "inventory_movements",
    name: "inventory_movements_reason_shape",
    definition: `CHECK ((((reverses_movement_id IS NULL) AND (type = ANY (ARRAY['OPENING'::text, 'PURCHASE_RECEIPT'::text])) AND (reason_code IS NULL) AND (reason_note IS NULL)) OR ((reverses_movement_id IS NULL) AND (type = 'ADJUSTMENT'::text) AND (reason_code = ANY (${ADJUSTMENT_REASON_CODES})) AND ((reason_code <> 'OTHER'::text) OR (reason_note IS NOT NULL))) OR ((reverses_movement_id IS NULL) AND (type = 'WRITE_OFF'::text) AND (reason_code = ANY (${WRITE_OFF_REASON_CODES})) AND ((reason_code <> 'OTHER'::text) OR (reason_note IS NOT NULL))) OR ((reverses_movement_id IS NOT NULL) AND (reason_code IS NULL) AND (reason_note IS NOT NULL))))`,
  },
  {
    table: "inventory_balances",
    name: "inventory_balances_quantity_range",
    definition: `CHECK (((quantity_minor >= '-1000000000000000'::bigint) AND (quantity_minor <= ${QUANTITY_BOUND})))`,
  },
  {
    table: "inventory_balances",
    name: "inventory_balances_version_non_negative",
    definition: "CHECK ((version >= 0))",
  },
  {
    table: "inventory_balances",
    name: "inventory_balances_last_movement_shape",
    definition: "CHECK (((version = 0) = (last_movement_id IS NULL)))",
  },
  {
    table: "inventory_balances",
    name: "inventory_balances_empty_is_zero",
    definition: "CHECK (((version > 0) OR (quantity_minor = 0)))",
  },
  {
    table: "inventory_stock_thresholds",
    name: "inventory_stock_thresholds_threshold_range",
    definition: `CHECK (((low_stock_threshold_minor IS NULL) OR ((low_stock_threshold_minor >= 0) AND (low_stock_threshold_minor <= ${QUANTITY_BOUND}))))`,
  },
  {
    table: "inventory_stock_thresholds",
    name: "inventory_stock_thresholds_version_positive",
    definition: "CHECK ((version >= 1))",
  },
  {
    table: "inventory_stock_thresholds",
    name: "inventory_stock_thresholds_updated_after_created",
    definition: "CHECK ((updated_at >= created_at))",
  },
];

/**
 * Every custom CHECK constraint, compared with PostgreSQL's canonical
 * rendering (pg_get_constraintdef), so any change to a constraint fails.
 * @type {{ table: string; name: string; definition: string }[]}
 */
const EXPECTED_CHECKS = [
  { table: "currencies", name: "currencies_code_format", definition: "CHECK (((code)::text ~ '^[A-Z]{3}$'::text))" },
  {
    table: "currencies",
    name: "currencies_minor_unit_digits_range",
    definition: "CHECK (((minor_unit_digits >= 0) AND (minor_unit_digits <= 4)))",
  },
  {
    table: "users",
    name: "users_display_name_length",
    definition: "CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 100)))",
  },
  { table: "users", name: "users_display_name_trimmed", definition: "CHECK ((display_name = btrim(display_name)))" },
  {
    table: "users",
    name: "users_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DISABLED'::text])))",
  },
  {
    table: "external_identities",
    name: "external_identities_provider_valid",
    definition: "CHECK ((provider = ANY (ARRAY['COGNITO'::text, 'LOCAL'::text])))",
  },
  {
    table: "external_identities",
    name: "external_identities_provider_subject_length",
    definition: "CHECK (((char_length(provider_subject) >= 1) AND (char_length(provider_subject) <= 255)))",
  },
  {
    table: "businesses",
    name: "businesses_name_length",
    definition: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))",
  },
  { table: "businesses", name: "businesses_name_trimmed", definition: "CHECK ((name = btrim(name)))" },
  {
    table: "businesses",
    name: "businesses_time_zone_length",
    definition: "CHECK (((char_length(time_zone) >= 1) AND (char_length(time_zone) <= 64)))",
  },
  {
    table: "businesses",
    name: "businesses_time_zone_format",
    definition: "CHECK ((time_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'::text))",
  },
  {
    table: "businesses",
    name: "businesses_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text])))",
  },
  {
    table: "business_locations",
    name: "business_locations_name_length",
    definition: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))",
  },
  { table: "business_locations", name: "business_locations_name_trimmed", definition: "CHECK ((name = btrim(name)))" },
  {
    table: "business_locations",
    name: "business_locations_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'ARCHIVED'::text])))",
  },
  {
    table: "business_locations",
    name: "business_locations_default_is_active",
    definition: "CHECK (((NOT is_default) OR (status = 'ACTIVE'::text)))",
  },
  {
    table: "business_memberships",
    name: "business_memberships_role_valid",
    definition:
      "CHECK ((role = ANY (ARRAY['OWNER'::text, 'MANAGER'::text, 'CASHIER'::text, 'STOCK_KEEPER'::text, 'ACCOUNTANT'::text])))",
  },
  {
    table: "business_memberships",
    name: "business_memberships_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text])))",
  },
  {
    table: "business_memberships",
    name: "business_memberships_version_positive",
    definition: "CHECK ((version >= 1))",
  },
  ...["users", "businesses", "business_locations", "business_memberships"].map((table) => ({
    table,
    name: `${table}_updated_after_created`,
    definition: "CHECK ((updated_at >= created_at))",
  })),
  ...auditEnvelopeChecks("business_audit_records"),
  {
    table: "business_audit_records",
    name: "business_audit_records_actor_type_valid",
    definition: "CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'integration'::text])))",
  },
  {
    table: "business_audit_records",
    name: "business_audit_records_actor_shape",
    definition:
      "CHECK ((((actor_type = 'user'::text) AND (actor_user_id IS NOT NULL) AND (actor_membership_id IS NOT NULL) AND (actor_name IS NULL)) OR ((actor_type = ANY (ARRAY['system'::text, 'integration'::text])) AND (actor_user_id IS NULL) AND (actor_membership_id IS NULL) AND (actor_name IS NOT NULL))))",
  },
  ...auditEnvelopeChecks("platform_audit_records"),
  {
    table: "platform_audit_records",
    name: "platform_audit_records_actor_type_valid",
    definition: "CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text])))",
  },
  {
    table: "platform_audit_records",
    name: "platform_audit_records_actor_shape",
    definition:
      "CHECK ((((actor_type = 'user'::text) AND (actor_user_id IS NOT NULL) AND (actor_name IS NULL)) OR ((actor_type = 'system'::text) AND (actor_user_id IS NULL) AND (actor_name IS NOT NULL))))",
  },
  ...idempotencyChecks("user_idempotency_records"),
  {
    table: "user_idempotency_records",
    name: "user_idempotency_records_actor_is_user",
    definition: "CHECK (((actor_type = 'user'::text) AND (actor_id = (user_id)::text)))",
  },
  ...idempotencyChecks("business_idempotency_records"),
  {
    table: "business_idempotency_records",
    name: "business_idempotency_records_actor_type_valid",
    definition: "CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'integration'::text])))",
  },
  {
    table: "business_idempotency_records",
    name: "business_idempotency_records_actor_id_format",
    definition: `CHECK ((((char_length(actor_id) >= 1) AND (char_length(actor_id) <= 128)) AND ((actor_type <> 'user'::text) OR (actor_id ~ ${UUID_TEXT}))))`,
  },
  {
    table: "business_invitations",
    name: "business_invitations_token_hash_length",
    definition: "CHECK ((octet_length(token_hash) = 32))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_role_valid",
    definition:
      "CHECK ((role = ANY (ARRAY['MANAGER'::text, 'CASHIER'::text, 'STOCK_KEEPER'::text, 'ACCOUNTANT'::text])))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['PENDING'::text, 'ACCEPTED'::text, 'REVOKED'::text])))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_expires_after_created",
    definition: "CHECK ((expires_at > created_at))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_accepted_shape",
    definition:
      "CHECK ((((status = 'ACCEPTED'::text) = (accepted_by_membership_id IS NOT NULL)) AND ((accepted_by_membership_id IS NULL) = (accepted_at IS NULL))))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_revoked_shape",
    definition:
      "CHECK ((((status = 'REVOKED'::text) = (revoked_by_membership_id IS NOT NULL)) AND ((revoked_by_membership_id IS NULL) = (revoked_at IS NULL))))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_accepted_in_window",
    definition: "CHECK (((accepted_at IS NULL) OR ((accepted_at >= created_at) AND (accepted_at < expires_at))))",
  },
  {
    table: "business_invitations",
    name: "business_invitations_revoked_after_created",
    definition: "CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)))",
  },
  {
    table: "devices",
    name: "devices_credential_hash_length",
    definition: "CHECK ((octet_length(credential_hash) = 32))",
  },
  { table: "devices", name: "devices_platform_valid", definition: "CHECK ((platform = 'ANDROID'::text))" },
  {
    table: "devices",
    name: "devices_label_length",
    definition: "CHECK (((char_length(label) >= 1) AND (char_length(label) <= 60)))",
  },
  { table: "devices", name: "devices_label_trimmed", definition: "CHECK ((label = btrim(label)))" },
  {
    table: "devices",
    name: "devices_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text])))",
  },
  {
    table: "devices",
    name: "devices_revoked_shape",
    definition:
      "CHECK ((((status = 'REVOKED'::text) = (revoked_by_membership_id IS NOT NULL)) AND ((revoked_by_membership_id IS NULL) = (revoked_at IS NULL))))",
  },
  {
    table: "devices",
    name: "devices_revoked_after_registered",
    definition: "CHECK (((revoked_at IS NULL) OR (revoked_at >= registered_at)))",
  },
  {
    table: "units_of_measure",
    name: "units_of_measure_code_format",
    definition: "CHECK (((code)::text ~ '^[A-Z]{1,16}$'::text))",
  },
  {
    table: "units_of_measure",
    name: "units_of_measure_kind_valid",
    definition: "CHECK ((kind = ANY (ARRAY['COUNT'::text, 'MASS'::text, 'VOLUME'::text])))",
  },
  {
    table: "units_of_measure",
    name: "units_of_measure_scale_range",
    definition: "CHECK (((scale >= 0) AND (scale <= 3)))",
  },
  {
    table: "product_categories",
    name: "product_categories_name_length",
    definition: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60)))",
  },
  { table: "product_categories", name: "product_categories_name_trimmed", definition: "CHECK ((name = btrim(name)))" },
  {
    table: "product_categories",
    name: "product_categories_normalized_name_length",
    definition: "CHECK (((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 120)))",
  },
  {
    table: "products",
    name: "products_name_length",
    definition: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120)))",
  },
  { table: "products", name: "products_name_trimmed", definition: "CHECK ((name = btrim(name)))" },
  {
    table: "products",
    name: "products_description_valid",
    definition:
      "CHECK (((description IS NULL) OR (((char_length(description) >= 1) AND (char_length(description) <= 500)) AND (description ~ '[^[:space:]]'::text))))",
  },
  ...["product_categories", "products", "product_variants"].flatMap((table) => [
    {
      table,
      name: `${table}_status_valid`,
      definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'ARCHIVED'::text])))",
    },
    { table, name: `${table}_version_positive`, definition: "CHECK ((version >= 1))" },
  ]),
  {
    table: "product_variants",
    name: "product_variants_default_only",
    definition: "CHECK ((is_default = true))",
  },
  {
    table: "product_variants",
    name: "product_variants_price_version_non_negative",
    definition: "CHECK ((price_version >= 0))",
  },
  {
    table: "product_variants",
    name: "product_variants_sku_pair",
    definition: "CHECK (((sku IS NULL) = (sku_normalized IS NULL)))",
  },
  {
    table: "product_variants",
    name: "product_variants_sku_valid",
    definition:
      "CHECK (((sku IS NULL) OR (((char_length(sku) >= 1) AND (char_length(sku) <= 64)) AND (sku = btrim(sku)))))",
  },
  {
    table: "product_variants",
    name: "product_variants_sku_normalized_format",
    definition: "CHECK (((sku_normalized IS NULL) OR (sku_normalized ~ '^[A-Z0-9 ._/-]{1,64}$'::text)))",
  },
  {
    table: "product_variants",
    name: "product_variants_barcode_pair",
    definition: "CHECK (((barcode IS NULL) = (barcode_normalized IS NULL)))",
  },
  {
    table: "product_variants",
    name: "product_variants_barcode_format",
    definition: "CHECK (((barcode IS NULL) OR (barcode ~ '^[0-9A-Za-z-]{1,64}$'::text)))",
  },
  {
    table: "product_variants",
    name: "product_variants_barcode_normalized_format",
    definition: "CHECK (((barcode_normalized IS NULL) OR (barcode_normalized ~ '^[0-9A-Za-z-]{1,64}$'::text)))",
  },
  {
    table: "product_variants",
    name: "product_variants_price_shape",
    definition:
      "CHECK ((((current_price_minor IS NULL) AND (current_price_currency IS NULL) AND (price_version = 0)) OR ((current_price_minor IS NOT NULL) AND (current_price_currency IS NOT NULL) AND (current_price_minor > 0) AND (price_version >= 1))))",
  },
  {
    table: "product_packs",
    name: "product_packs_name_length",
    definition: "CHECK (((char_length(name) >= 1) AND (char_length(name) <= 40)))",
  },
  { table: "product_packs", name: "product_packs_name_trimmed", definition: "CHECK ((name = btrim(name)))" },
  {
    table: "product_packs",
    name: "product_packs_factor_range",
    definition: "CHECK (((factor_minor >= 2) AND (factor_minor <= 1000000000)))",
  },
  {
    table: "product_packs",
    name: "product_packs_status_valid",
    definition: "CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))",
  },
  ...["product_categories", "products", "product_variants", "product_packs"].map((table) => ({
    table,
    name: `${table}_updated_after_created`,
    definition: "CHECK ((updated_at >= created_at))",
  })),
  {
    table: "product_variant_prices",
    name: "product_variant_prices_amount_positive",
    definition: "CHECK ((amount_minor > 0))",
  },
  {
    table: "product_variant_prices",
    name: "product_variant_prices_price_version_positive",
    definition: "CHECK ((price_version >= 1))",
  },
  {
    table: "product_variant_prices",
    name: "product_variant_prices_reason_valid",
    definition:
      "CHECK (((reason IS NULL) OR (((char_length(reason) >= 1) AND (char_length(reason) <= 500)) AND (reason ~ '[^[:space:]]'::text))))",
  },
  ...INVENTORY_CHECKS,
];

/** @type {{ schema: string; name: string; columns: string; predicate: string }[]} */
const EXPECTED_PARTIAL_UNIQUE_INDEXES = [
  {
    schema: "public",
    name: "business_locations_one_active_default",
    columns: "business_id",
    predicate: "(is_default AND (status = 'ACTIVE'::text))",
  },
  {
    schema: "public",
    name: "product_variants_one_default_per_product",
    columns: "business_id,product_id",
    predicate: "is_default",
  },
  {
    schema: "public",
    name: "product_variants_active_barcode_unique",
    columns: "business_id,barcode_normalized",
    predicate: "((status = 'ACTIVE'::text) AND (barcode_normalized IS NOT NULL))",
  },
  {
    schema: "public",
    name: "product_categories_active_name_unique",
    columns: "business_id,normalized_name",
    predicate: "(status = 'ACTIVE'::text)",
  },
  {
    schema: "public",
    name: "product_packs_active_name_unique",
    columns: "business_id,variant_id,name",
    predicate: "(status = 'ACTIVE'::text)",
  },
  // One OPENING per stock item ever; one original line per document and variant (ADR-008 sections 7.1 and 8).
  {
    schema: "public",
    name: "inventory_movements_one_opening",
    columns: "business_id,location_id,variant_id",
    predicate: "(type = 'OPENING'::text)",
  },
  ...[
    ["opening_line", "opening_batch_id"],
    ["receipt_line", "goods_receipt_id"],
    ["adjustment_line", "adjustment_id"],
  ].map(([rule, column]) => ({
    schema: "public",
    name: `inventory_movements_${rule}_unique`,
    columns: `business_id,${column},variant_id`,
    predicate: `((${column} IS NOT NULL) AND (reverses_movement_id IS NULL))`,
  })),
];

/**
 * Composite tenant foreign keys (ADR-005 section 19): a reference from one
 * tenant-owned row to another carries business_id, so PostgreSQL rejects a
 * cross-business reference. Prisma's drift check covers foreign keys too; this
 * list keeps the tenant-safety property explicit.
 * @type {{ table: string; name: string; definition: string }[]}
 */
const EXPECTED_TENANT_FOREIGN_KEYS = [
  {
    table: "business_audit_records",
    name: "business_audit_records_business_id_actor_membership_id_fkey",
    definition:
      "FOREIGN KEY (business_id, actor_membership_id) REFERENCES business_memberships(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  {
    table: "business_audit_records",
    name: "business_audit_records_business_id_location_id_fkey",
    definition:
      "FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  {
    table: "business_audit_records",
    name: "business_audit_records_business_id_device_id_fkey",
    definition:
      "FOREIGN KEY (business_id, device_id) REFERENCES devices(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  ...[
    ["business_invitations", "created_by_membership_id"],
    ["business_invitations", "accepted_by_membership_id"],
    ["business_invitations", "revoked_by_membership_id"],
    ["devices", "registered_by_membership_id"],
    ["devices", "revoked_by_membership_id"],
    ["products", "created_by_membership_id"],
    ["product_variant_prices", "set_by_membership_id"],
  ].map(([table, column]) => ({
    table,
    name: `${table}_business_id_${column}_fkey`,
    definition: `FOREIGN KEY (business_id, ${column}) REFERENCES business_memberships(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
  })),
  ...[
    ["products", "category_id", "product_categories"],
    ["product_variants", "product_id", "products"],
    ["product_packs", "variant_id", "product_variants"],
    ["product_variant_prices", "variant_id", "product_variants"],
  ].map(([table, column, target]) => ({
    table,
    name: `${table}_business_id_${column}_fkey`,
    definition: `FOREIGN KEY (business_id, ${column}) REFERENCES ${target}(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
  })),
  // A stored price is in its own business's currency (ADR-008 section 3.4).
  ...[
    ["product_variants", "current_price_currency"],
    ["product_variant_prices", "currency"],
  ].map(([table, column]) => ({
    table,
    name: `${table}_business_id_${column}_fkey`,
    definition: `FOREIGN KEY (business_id, ${column}) REFERENCES businesses(id, currency_code) ON UPDATE RESTRICT ON DELETE RESTRICT`,
  })),
  // Inventory (ADR-008 sections 7, 8 and 11): every reference stays in its business.
  ...[
    ["inventory_opening_batches", "location_id", "business_locations"],
    ["inventory_opening_batches", "actor_membership_id", "business_memberships"],
    ["inventory_opening_batches", "device_id", "devices"],
    ["goods_receipts", "location_id", "business_locations"],
    ["goods_receipts", "actor_membership_id", "business_memberships"],
    ["goods_receipts", "reversed_by_membership_id", "business_memberships"],
    ["goods_receipts", "device_id", "devices"],
    ["inventory_adjustments", "location_id", "business_locations"],
    ["inventory_adjustments", "actor_membership_id", "business_memberships"],
    ["inventory_adjustments", "device_id", "devices"],
    ["inventory_movements", "location_id", "business_locations"],
    ["inventory_movements", "variant_id", "product_variants"],
    ["inventory_movements", "actor_membership_id", "business_memberships"],
    ["inventory_movements", "device_id", "devices"],
    ["inventory_movements", "opening_batch_id", "inventory_opening_batches"],
    ["inventory_movements", "goods_receipt_id", "goods_receipts"],
    ["inventory_balances", "location_id", "business_locations"],
    ["inventory_balances", "variant_id", "product_variants"],
    ["inventory_stock_thresholds", "location_id", "business_locations"],
    ["inventory_stock_thresholds", "variant_id", "product_variants"],
  ].map(([table, column, target]) => ({
    table,
    name: `${table}_business_id_${column}_fkey`,
    definition: `FOREIGN KEY (business_id, ${column}) REFERENCES ${target}(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
  })),
  {
    table: "inventory_adjustments",
    name: "inventory_adjustments_reversed_by_membership_fkey",
    definition:
      "FOREIGN KEY (business_id, reversed_by_membership_id) REFERENCES business_memberships(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  // A movement's type is its adjustment document's kind.
  {
    table: "inventory_movements",
    name: "inventory_movements_business_id_adjustment_id_type_fkey",
    definition:
      "FOREIGN KEY (business_id, adjustment_id, type) REFERENCES inventory_adjustments(business_id, id, kind) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  // A pack snapshot names a pack of the movement's own variant.
  {
    table: "inventory_movements",
    name: "inventory_movements_business_id_pack_id_variant_id_fkey",
    definition:
      "FOREIGN KEY (business_id, pack_id, variant_id) REFERENCES product_packs(business_id, id, variant_id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  // A reversal has its original's location, variant and type.
  {
    table: "inventory_movements",
    name: "inventory_movements_reversal_fkey",
    definition:
      "FOREIGN KEY (business_id, reverses_movement_id, location_id, variant_id, type) REFERENCES inventory_movements(business_id, id, location_id, variant_id, type) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
  // A balance's last movement belongs to the same stock item (plan decision D18).
  {
    table: "inventory_balances",
    name: "inventory_balances_last_movement_fkey",
    definition:
      "FOREIGN KEY (business_id, location_id, variant_id, last_movement_id) REFERENCES inventory_movements(business_id, location_id, variant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT",
  },
];

/**
 * Total unique indexes that carry a rule. Globally unique one-time-secret
 * digests: acceptance finds an invitation by its token digest alone. A SKU is
 * unique per business across every status, and a price version per variant
 * (ADR-008 sections 3.4 and 5.1). (businesses.id, currency_code) is the
 * target of the price-currency foreign keys; (business_id, id, variant_id)
 * on packs lets later references pin a pack to its variant.
 * @type {{ schema: string; name: string; columns: string }[]}
 */
const EXPECTED_UNIQUE_INDEXES = [
  { schema: "public", name: "business_invitations_token_hash_key", columns: "token_hash" },
  { schema: "public", name: "businesses_id_currency_code_key", columns: "id,currency_code" },
  {
    schema: "public",
    name: "product_variants_business_id_sku_normalized_key",
    columns: "business_id,sku_normalized",
  },
  { schema: "public", name: "product_packs_business_id_id_variant_id_key", columns: "business_id,id,variant_id" },
  {
    schema: "public",
    name: "product_variant_prices_business_id_variant_id_price_version_key",
    columns: "business_id,variant_id,price_version",
  },
  // Inventory (ADR-008 sections 7 and 8): the adjustment kind target, the
  // reversal and last-movement targets, the gap-free balance version per stock
  // item, one reversal per original, and one threshold row per stock item.
  {
    schema: "public",
    name: "inventory_adjustments_business_id_id_kind_key",
    columns: "business_id,id,kind",
  },
  {
    schema: "public",
    name: "inventory_movements_reversal_target_key",
    columns: "business_id,id,location_id,variant_id,type",
  },
  {
    schema: "public",
    name: "inventory_movements_business_id_location_id_variant_id_id_key",
    columns: "business_id,location_id,variant_id,id",
  },
  {
    schema: "public",
    name: "inventory_movements_stock_item_version_key",
    columns: "business_id,location_id,variant_id,balance_version",
  },
  {
    schema: "public",
    name: "inventory_movements_business_id_reverses_movement_id_key",
    columns: "business_id,reverses_movement_id",
  },
  {
    schema: "public",
    name: "inventory_balances_pkey",
    columns: "business_id,location_id,variant_id",
  },
  {
    schema: "public",
    name: "inventory_stock_thresholds_stock_item_key",
    columns: "business_id,location_id,variant_id",
  },
];

/** Reference rows every migrated database must contain (ADR-005 section 5: the pilot currency). */
const EXPECTED_CURRENCIES = [{ code: "NGN", minorUnitDigits: 2 }];

/** The exact unit reference rows (ADR-008 section 4.2): no more, no fewer, unchanged. */
const EXPECTED_UNITS = [
  { code: "BOTTLE", kind: "COUNT", scale: 0 },
  { code: "G", kind: "MASS", scale: 0 },
  { code: "KG", kind: "MASS", scale: 3 },
  { code: "L", kind: "VOLUME", scale: 3 },
  { code: "ML", kind: "VOLUME", scale: 0 },
  { code: "PACK", kind: "COUNT", scale: 0 },
  { code: "PIECE", kind: "COUNT", scale: 0 },
  { code: "SACHET", kind: "COUNT", scale: 0 },
  { code: "TIN", kind: "COUNT", scale: 0 },
];

const failures = [];
const fail = (message) => failures.push(message);

// ---- 1. Committed migrations: destructive SQL against protected tables ------
const migrationNames = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const ALLOW_MARKER = "tali:allow-destructive";
// Dropping a schema, or anything with CASCADE, can remove protected tables
// without naming them, so these are destructive regardless of the table.
const ALWAYS_DESTRUCTIVE = /^\s*DROP\s+SCHEMA\b|^\s*DROP\b[^;]*\bCASCADE\b/i;
for (const name of migrationNames) {
  const approved = Object.hasOwn(APPROVED_DESTRUCTIVE_MIGRATIONS, name);
  const lines = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8").split("\n");
  lines.forEach((line, index) => {
    const where = `${name}/migration.sql:${index + 1}`;
    for (const schema of TEST_ONLY_SCHEMAS) {
      if (new RegExp(`\\b${schema}\\b`, "i").test(line)) {
        fail(`${where}: test-only schema ${schema} must never appear in the migration chain: ${line.trim()}`);
      }
    }
    if (line.includes(ALLOW_MARKER) && !approved) {
      fail(`${where}: ${ALLOW_MARKER} used in a migration without recorded approval: ${line.trim()}`);
    }
    const allowed = approved && line.includes(ALLOW_MARKER);
    if (ALWAYS_DESTRUCTIVE.test(line) && !allowed) {
      fail(`${where}: schema drop or CASCADE requires explicit approval: ${line.trim()}`);
    }
    for (const table of PROTECTED_TABLES) {
      const tableName = table.split(".")[1];
      const destructive = new RegExp(
        `^\\s*(DROP\\s+TABLE|TRUNCATE|DELETE\\s+FROM|GRANT\\s+[^;]*\\b(UPDATE|DELETE|TRUNCATE|ALL)\\b[^;]*\\bON\\b)[^;]*\\b${tableName}\\b`,
        "i",
      );
      if (destructive.test(line) && !allowed) {
        fail(`${where}: destructive statement on protected table ${table}: ${line.trim()}`);
      }
    }
    for (const table of NO_DELETE_TABLES) {
      const tableName = table.split(".")[1];
      const destructive = new RegExp(
        `^\\s*(DROP\\s+TABLE|TRUNCATE|DELETE\\s+FROM|GRANT\\s+[^;]*\\b(DELETE|TRUNCATE|ALL)\\b[^;]*\\bON\\b)[^;]*\\b${tableName}\\b`,
        "i",
      );
      if (destructive.test(line) && !allowed) {
        fail(`${where}: delete-capable statement on never-deleted table ${table}: ${line.trim()}`);
      }
    }
  });
}

// ---- 2. Live database --------------------------------------------------------
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (connectionString === undefined) {
  console.error("MIGRATION_DATABASE_URL is not set.");
  process.exit(1);
}
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const applied = await client.query(
    `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
     FROM public._prisma_migrations ORDER BY migration_name`,
  );
  const appliedNames = applied.rows.filter((row) => row.finished && !row.rolled_back).map((row) => row.migration_name);
  if (JSON.stringify(appliedNames) !== JSON.stringify(migrationNames)) {
    fail(`applied migrations ${JSON.stringify(appliedNames)} differ from committed ${JSON.stringify(migrationNames)}`);
  }
  for (const row of applied.rows.filter((r) => !r.finished || r.rolled_back)) {
    fail(`migration ${row.migration_name} is unfinished or rolled back`);
  }

  for (const schema of REMOVED_SCHEMAS) {
    const { rows } = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
    if (rows.length > 0) fail(`removed schema ${schema} exists`);
  }
  for (const schema of TEST_ONLY_SCHEMAS) {
    const { rows } = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema]);
    if (rows.length > 0) fail(`test-only schema ${schema} exists; it belongs only to a running integration test`);
  }

  const tableExists = async (table) =>
    (await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [table])).rows[0].present;

  for (const check of EXPECTED_CHECKS) {
    if (!(await tableExists(check.table))) {
      fail(`table ${check.table} for CHECK constraint ${check.name} is missing`);
      continue;
    }
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = $1 AND contype = 'c' AND conrelid = $2::regclass`,
      [check.name, check.table],
    );
    if (rows.length !== 1 || rows[0].definition !== check.definition) {
      fail(`CHECK constraint ${check.name} on ${check.table} missing or changed (${rows[0]?.definition ?? "absent"})`);
    }
  }

  for (const key of EXPECTED_TENANT_FOREIGN_KEYS) {
    if (!(await tableExists(key.table))) {
      fail(`table ${key.table} for foreign key ${key.name} is missing`);
      continue;
    }
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = $1 AND contype = 'f' AND conrelid = $2::regclass`,
      [key.name, key.table],
    );
    if (rows.length !== 1 || rows[0].definition !== key.definition) {
      fail(`tenant foreign key ${key.name} on ${key.table} missing or changed (${rows[0]?.definition ?? "absent"})`);
    }
  }

  if (await tableExists("public.currencies")) {
    for (const currency of EXPECTED_CURRENCIES) {
      const { rows } = await client.query(`SELECT minor_unit_digits FROM public.currencies WHERE code = $1`, [
        currency.code,
      ]);
      if (rows.length !== 1 || rows[0].minor_unit_digits !== currency.minorUnitDigits) {
        fail(`reference currency ${currency.code} (${currency.minorUnitDigits} minor-unit digits) missing or changed`);
      }
    }
  } else {
    fail("table public.currencies is missing");
  }

  if (await tableExists("public.units_of_measure")) {
    const { rows } = await client.query(`SELECT code, kind, scale FROM public.units_of_measure ORDER BY code`);
    if (JSON.stringify(rows) !== JSON.stringify(EXPECTED_UNITS)) {
      fail(`unit reference rows differ from the expected set: ${JSON.stringify(rows)}`);
    }
  } else {
    fail("table public.units_of_measure is missing");
  }

  for (const index of EXPECTED_PARTIAL_UNIQUE_INDEXES) {
    const { rows } = await client.query(
      `SELECT ix.indisunique AS unique, pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS columns
       FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [index.schema, index.name],
    );
    if (
      rows.length !== 1 ||
      !rows[0].unique ||
      rows[0].predicate !== index.predicate ||
      rows[0].columns !== index.columns
    ) {
      fail(`partial unique index ${index.schema}.${index.name} missing or changed`);
    }
  }

  for (const index of EXPECTED_UNIQUE_INDEXES) {
    const { rows } = await client.query(
      `SELECT ix.indisunique AS unique, ix.indpred IS NULL AS total,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS columns
       FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [index.schema, index.name],
    );
    if (rows.length !== 1 || !rows[0].unique || !rows[0].total || rows[0].columns !== index.columns) {
      fail(`unique index ${index.schema}.${index.name} missing or changed`);
    }
  }

  const grants = await client.query(
    `SELECT table_schema || '.' || table_name AS table, array_agg(privilege_type::text ORDER BY privilege_type) AS privileges
     FROM information_schema.role_table_grants WHERE grantee = $1 GROUP BY 1`,
    [APP_ROLE],
  );
  const actual = Object.fromEntries(grants.rows.map((row) => [row.table, row.privileges]));
  for (const table of new Set([...Object.keys(EXPECTED_APP_PRIVILEGES), ...Object.keys(actual)])) {
    const expected = JSON.stringify(EXPECTED_APP_PRIVILEGES[table] ?? []);
    if (JSON.stringify(actual[table] ?? []) !== expected) {
      fail(`${APP_ROLE} privileges on ${table}: expected ${expected}, found ${JSON.stringify(actual[table] ?? [])}`);
    }
  }

  // Column-level grants are invisible to role_table_grants; read every column ACL entry for the role (and PUBLIC).
  const columnGrants = await client.query(
    `SELECT n.nspname || '.' || c.relname AS table, a.attname AS column, acl.grantee = 0 AS public,
            array_agg(acl.privilege_type::text ORDER BY acl.privilege_type) AS privileges
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(a.attacl) AS acl
     WHERE a.attacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND (acl.grantee = 0 OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1))
     GROUP BY 1, 2, 3 ORDER BY 1, 2`,
    [APP_ROLE],
  );
  const actualColumns = {};
  for (const row of columnGrants.rows) {
    if (row.public) {
      fail(`PUBLIC has column privileges ${JSON.stringify(row.privileges)} on ${row.table}.${row.column}`);
      continue;
    }
    actualColumns[row.table] = { ...actualColumns[row.table], [row.column]: row.privileges };
  }
  for (const table of new Set([...Object.keys(EXPECTED_APP_COLUMN_PRIVILEGES), ...Object.keys(actualColumns)])) {
    const sorted = (grants = {}) =>
      JSON.stringify(Object.fromEntries(Object.entries(grants).sort(([a], [b]) => (a < b ? -1 : 1))));
    const expected = sorted(EXPECTED_APP_COLUMN_PRIVILEGES[table]);
    if (sorted(actualColumns[table]) !== expected) {
      fail(`${APP_ROLE} column privileges on ${table}: expected ${expected}, found ${sorted(actualColumns[table])}`);
    }
  }

  const publicGrants = await client.query(
    `SELECT table_schema || '.' || table_name AS table, privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'PUBLIC' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
  );
  for (const row of publicGrants.rows) fail(`PUBLIC has ${row.privilege_type} on ${row.table}`);

  // RLS stays off in Build 1 (ADR-002 section 21); enabling it needs its own decision.
  const rls = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND (c.relrowsecurity OR c.relforcerowsecurity)
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  for (const row of rls.rows) fail(`row-level security is enabled on ${row.name} without an accepted decision`);

  const role = await client.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    [APP_ROLE],
  );
  const attributes = role.rows[0];
  if (attributes === undefined || Object.values(attributes).some(Boolean)) {
    fail(`${APP_ROLE} must exist with no SUPERUSER, CREATEDB, CREATEROLE or BYPASSRLS`);
  }

  const owned = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE pg_get_userbyid(c.relowner) = $1
     UNION ALL SELECT nspname FROM pg_namespace WHERE pg_get_userbyid(nspowner) = $1`,
    [APP_ROLE],
  );
  if (owned.rows.length > 0) fail(`${APP_ROLE} owns objects: ${owned.rows.map((row) => row.name).join(", ")}`);

  const createOnSchemas = await client.query(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' AND has_schema_privilege($1, oid, 'CREATE')`,
    [APP_ROLE],
  );
  if (createOnSchemas.rows.length > 0) {
    fail(`${APP_ROLE} can CREATE in schemas: ${createOnSchemas.rows.map((row) => row.nspname).join(", ")}`);
  }

  const defaults = await client.query(`SELECT count(*)::int AS n FROM pg_default_acl`);
  if (defaults.rows[0].n !== 0) fail("default privileges are configured; grants must be explicit per migration");
} finally {
  await client.end();
}

if (failures.length > 0) {
  console.error(`Schema verification FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `Schema verification passed (${migrationNames.length} migration(s), ${Object.keys(APPROVED_DESTRUCTIVE_MIGRATIONS).length} approved destructive migration(s), ${Object.keys(EXPECTED_APP_PRIVILEGES).length} table grant sets, ${Object.keys(EXPECTED_APP_COLUMN_PRIVILEGES).length} column grant sets, ${EXPECTED_CHECKS.length} CHECK, ${EXPECTED_PARTIAL_UNIQUE_INDEXES.length} partial unique index, ${EXPECTED_UNIQUE_INDEXES.length} unique index, ${EXPECTED_TENANT_FOREIGN_KEYS.length} tenant foreign keys, ${EXPECTED_CURRENCIES.length} reference currency, ${EXPECTED_UNITS.length} units of measure, removed schemas absent: ${REMOVED_SCHEMAS.join(", ")}, test-only schemas absent: ${TEST_ONLY_SCHEMAS.join(", ")}).`,
);
