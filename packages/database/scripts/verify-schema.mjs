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
 * touched them.
 */
const PROTECTED_TABLES = ["foundation_spike.protected_entry"];

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

/** Exact table privileges expected for the application role. */
const EXPECTED_APP_PRIVILEGES = {};

/** @type {{ table: string; name: string; contains: string }[]} */
const EXPECTED_CHECKS = [];

/** @type {{ schema: string; name: string; predicate: string }[]} */
const EXPECTED_PARTIAL_UNIQUE_INDEXES = [];

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

  for (const check of EXPECTED_CHECKS) {
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = $1 AND contype = 'c' AND conrelid = $2::regclass`,
      [check.name, check.table],
    );
    if (rows.length !== 1 || !String(rows[0].definition).includes(check.contains)) {
      fail(`CHECK constraint ${check.name} on ${check.table} missing or changed (${rows[0]?.definition ?? "absent"})`);
    }
  }

  for (const index of EXPECTED_PARTIAL_UNIQUE_INDEXES) {
    const { rows } = await client.query(
      `SELECT ix.indisunique AS unique, pg_get_expr(ix.indpred, ix.indrelid) AS predicate
       FROM pg_index ix JOIN pg_class c ON c.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [index.schema, index.name],
    );
    if (rows.length !== 1 || !rows[0].unique || !String(rows[0].predicate).includes(index.predicate)) {
      fail(`partial unique index ${index.schema}.${index.name} missing or changed`);
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
  `Schema verification passed (${migrationNames.length} migration(s), ${Object.keys(APPROVED_DESTRUCTIVE_MIGRATIONS).length} approved destructive migration(s), ${Object.keys(EXPECTED_APP_PRIVILEGES).length} table grant sets, ${EXPECTED_CHECKS.length} CHECK, ${EXPECTED_PARTIAL_UNIQUE_INDEXES.length} partial unique index, removed schemas absent: ${REMOVED_SCHEMAS.join(", ")}).`,
);
