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
 * (ADR-004 sections 4.2 and 8.1).
 */
const PROTECTED_TABLES = [
  "foundation_spike.protected_entry",
  "public.business_audit_records",
  "public.platform_audit_records",
  "public.user_idempotency_records",
  "public.business_idempotency_records",
];

/**
 * Build 1 tables that are never hard-deleted (ADR-005 section 20): no
 * migration may drop, truncate or delete from them, or grant DELETE,
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
 * and Slice 5 migrations). No table grants DELETE or TRUNCATE; audit and
 * idempotency tables are insert-only; currencies are read-only.
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
];

/** @type {{ schema: string; name: string; predicate: string }[]} */
const EXPECTED_PARTIAL_UNIQUE_INDEXES = [
  {
    schema: "public",
    name: "business_locations_one_active_default",
    predicate: "(is_default AND (status = 'ACTIVE'::text))",
  },
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
  ].map(([table, column]) => ({
    table,
    name: `${table}_business_id_${column}_fkey`,
    definition: `FOREIGN KEY (business_id, ${column}) REFERENCES business_memberships(business_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT`,
  })),
];

/**
 * Globally unique one-time-secret digests: acceptance finds an invitation by
 * its token digest alone, so the digest must identify at most one row.
 * @type {{ schema: string; name: string; columns: string }[]}
 */
const EXPECTED_UNIQUE_INDEXES = [
  { schema: "public", name: "business_invitations_token_hash_key", columns: "token_hash" },
];

/** Reference rows every migrated database must contain (ADR-005 section 5: the pilot currency). */
const EXPECTED_CURRENCIES = [{ code: "NGN", minorUnitDigits: 2 }];

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

  for (const index of EXPECTED_PARTIAL_UNIQUE_INDEXES) {
    const { rows } = await client.query(
      `SELECT ix.indisunique AS unique, pg_get_expr(ix.indpred, ix.indrelid) AS predicate
       FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [index.schema, index.name],
    );
    if (rows.length !== 1 || !rows[0].unique || rows[0].predicate !== index.predicate) {
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
  `Schema verification passed (${migrationNames.length} migration(s), ${Object.keys(APPROVED_DESTRUCTIVE_MIGRATIONS).length} approved destructive migration(s), ${Object.keys(EXPECTED_APP_PRIVILEGES).length} table grant sets, ${EXPECTED_CHECKS.length} CHECK, ${EXPECTED_PARTIAL_UNIQUE_INDEXES.length} partial unique index, ${EXPECTED_UNIQUE_INDEXES.length} unique index, ${EXPECTED_TENANT_FOREIGN_KEYS.length} tenant foreign keys, ${EXPECTED_CURRENCIES.length} reference currency, removed schemas absent: ${REMOVED_SCHEMAS.join(", ")}, test-only schemas absent: ${TEST_ONLY_SCHEMAS.join(", ")}).`,
);
