# Prisma foundation spike: go/no-go report

- Date: 2026-09-27 (Wave B)
- Scope: ADR-002 section 5 conditional acceptance of Prisma
- Versions: `prisma`, `@prisma/client`, `@prisma/adapter-pg` 7.10.0 (latest stable; the
  npm `latest` tag currently points at 8.0.0-rc.17, a release candidate, which was
  not used), `pg` 8.23.0, PostgreSQL 18.6 (`postgres:18.6-alpine`), Node.js 24.21.0,
  TypeScript 6.0.3.
- Test database: disposable `tali_test` (docker-compose `postgres-test`, tmpfs),
  migrated with `prisma migrate deploy`. Code under test connects as the
  least-privileged application role `tali_app`; setup and assertions use the owner
  role `tali_owner` through a separate `pg` pool.
- Evidence: `packages/database/test/integration/*.integration.test.ts` (62 tests)
  and `packages/database/src/containment.test.ts` (5 tests). All passed, 4
  consecutive runs, no flakes.
- Spike objects: five tables in the isolated PostgreSQL schema `foundation_spike`
  (`prisma/schema/foundation-spike.prisma`). They are not domain schema, are never
  used by application code, and must be dropped by a forward migration before the
  first business module. They were dropped at the Wave B closeout (see "Closeout" at the end).

## Recommendation: GO

All seven criteria pass. Three pass with limitations that are understood,
bounded, and mitigated in this wave. None requires evaluating Kysely or Drizzle.

| Criterion | Result |
| --- | --- |
| A. Interactive transactions | PASS WITH LIMITATION |
| B. `SELECT ... FOR UPDATE` | PASS WITH LIMITATION |
| C. `FOR UPDATE SKIP LOCKED` batch claiming | PASS WITH LIMITATION |
| D. BIGINT <-> `bigint` | PASS |
| E. Custom SQL migration via `migrate deploy` | PASS WITH LIMITATION |
| F. Multi-file schema | PASS |
| G. Type containment | PASS |

B and C share one limitation (raw SQL for locking clauses); it is listed under
each for completeness.

## A. Interactive transactions: PASS WITH LIMITATION

Tests (`a-transactions.integration.test.ts`, `unit-of-work.integration.test.ts`):

1. Multi-statement commit: two inserts and an update in one `PrismaUnitOfWork.run`;
   a read inside the transaction sees the earlier write; both rows are committed.
2. Rollback on thrown error: two inserts then `throw`; zero rows afterwards.
3. Rollback on database error: insert then duplicate primary key; zero rows.
4. Uncommitted writes are invisible to another connection until commit.
5. Configurable isolation: `current_setting('transaction_isolation')` inside the
   transaction returns `read committed`, `repeatable read`, `serializable` for the
   three `IsolationLevel` values; default is `read committed`.
6. Isolation is real, not just a setting: under `repeatable-read` a concurrent
   committed update is invisible (1 then 1); under `read-committed` it is visible
   (2 then 3).
7. Serializable write skew: of two conflicting serializable transactions exactly
   one is aborted.
8. Transaction timeout: a transaction exceeding its configured timeout (300 ms) is
   aborted and fully rolled back.
9. Nested `run()` joins the outer transaction (same scope); an outer failure rolls
   back the nested use case's writes; a nested run may not raise the isolation
   level; independent concurrent runs are separate transactions.

Limitations and implications:

- A serialization failure (SQLSTATE 40001) surfaces as a `DriverAdapterError`
  named `TransactionWriteConflict`, not as a SQLSTATE. When a retry policy for
  serializable use cases is added, the adapter must map that error to a retryable
  application error. Not needed in Wave B.
- Interactive transactions hold a pooled connection for their whole duration and
  are bounded by `maxWait`/`timeout` (defaults set to 5 s / 15 s, configurable via
  `DatabaseOptions`). Use cases must not perform network calls inside a unit of
  work. This is the intended design regardless of ORM.

## B. `SELECT ... FOR UPDATE`: PASS WITH LIMITATION

Tests (`b-row-locking.integration.test.ts`):

1. Lock held for the transaction: while transaction 1 holds `FOR UPDATE`, a
   `FOR UPDATE NOWAIT` from transaction 2 fails immediately with
   `lock_not_available` (55P03); after commit the same lock succeeds.
2. Blocking and visibility: transaction 2's `FOR UPDATE` blocks until transaction
   1 commits, then reads transaction 1's write (event order asserted:
   `second-lock-requested`, `first-commit`, `second-lock-acquired:counter=1`).
3. No lost updates: 10 concurrent read-modify-write increments under `FOR UPDATE`
   yield exactly 10.

Limitation and implication: Prisma's query API has no locking clause, so row
locks use `$queryRaw` tagged templates (parameterized) on the transaction client.
ADR-002 already permits exactly this inside `packages/database`, and
`$queryRawUnsafe` stays banned by lint. Locking queries return raw rows, which
the repository maps explicitly; a small amount of hand-written SQL per locking
repository is expected.

## C. `FOR UPDATE SKIP LOCKED` batch claiming: PASS WITH LIMITATION

Tests (`c-skip-locked.integration.test.ts`):

1. Non-blocking claim: while worker A holds a claim on jobs 1-4, worker B's claim
   returns jobs 5-8 immediately (under 2 s, not blocked).
2. Two concurrent simulated workers drain 200 jobs in batches of 7, with locks held
   briefly so they genuinely overlap: zero jobs claimed by both, all 200 claimed,
   both workers claimed work, and the per-worker counts in the table match.
3. A claim inside a transaction that fails is rolled back, and the jobs are
   claimable again.

Limitation: same as B. The claim is a single parameterized
`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` issued with
`$queryRaw`. This is the shape the future outbox relay will use.

## D. BIGINT <-> `bigint`: PASS

Tests (`d-bigint.integration.test.ts`):

1. Model API round trip for `MAX_SAFE_INTEGER + 2`, int8 maximum
   (9223372036854775807), int8 minimum, 1 and 0: the value read back is
   `typeof "bigint"`, exactly equal, and maps straight into domain `Money`
   (`Money.ofMinor(row.amountMinor, currency)`).
2. `$queryRaw` returns an `int8` column as `bigint` (not `number`, not `string`).
3. The stored value, read as text through a separate connection, is exactly
   `9007199254740993`.
4. `sum()` of values beyond `MAX_SAFE_INTEGER` returns an exact `bigint`.
5. A value beyond int8 range is rejected with an error, not truncated.

No coercion to `number` occurs at any point.

## E. Custom SQL migration via `migrate deploy`: PASS WITH LIMITATION

Migration `20260927231057_foundation_spike` was generated with
`prisma migrate dev --create-only`, then extended by hand with:

- a CHECK constraint (`amount_minor >= 0`);
- a partial unique index (one `is_default` row per `scope_key`);
- `REVOKE ALL ON SCHEMA ... FROM PUBLIC`;
- explicit `GRANT`s to `tali_app`;
- a `REVOKE UPDATE, DELETE, TRUNCATE` on the append-only stand-in table.

Tests (`e-custom-migration.integration.test.ts`, scripts, and manual checks):

1. `migrate deploy` applies the migration to an empty database (global setup, CI,
   and a freshly recreated container); `_prisma_migrations` records it as finished
   and not rolled back.
2. A second `migrate deploy` reports "No pending migrations to apply"; `migrate
   status` reports "Database schema is up to date".
3. No drift failure: `migrate diff --from-migrations --to-schema --exit-code` and
   `--from-migrations --to-config-datasource --exit-code` both exit 0. `migrate dev`
   after applying generated no follow-up migration (the custom objects did not
   cause Prisma to try to drop them).
4. The CHECK constraint rejects a negative amount (through Prisma as the app role,
   and SQLSTATE 23514 at SQL level).
5. The partial unique index allows many non-default rows, one default per scope,
   and rejects a second default (SQLSTATE 23505); a violation inside a unit of work
   rolls back the whole transaction.
6. Negative controls for the drift check itself: a manually added column and a
   schema edit without a migration were both reported (exit 2).

Limitation: Prisma's drift detection is blind to objects it does not model.
Manually dropping the partial index or the CHECK constraint was reported as "No
difference detected", and grants are not compared at all. This is also why the
custom SQL causes no false drift.

Mitigation, implemented in this wave: `scripts/verify-schema.mjs` runs after
`migrate deploy` in CI. It verifies at the catalog level that:

- every committed migration is applied and finished;
- each expected CHECK constraint and partial unique index exists with its
  definition;
- `tali_app` holds exactly the expected table privileges, and has no role
  attributes, no ownership, no `CREATE` on any schema, and no default privileges;
- no committed migration contains a destructive statement against a protected
  table.

Negative controls all failed verification as intended: a dropped CHECK, a dropped
partial index, a rogue `GRANT UPDATE`, default privileges, and an appended
`DELETE FROM` line.

Implication: every future custom SQL object must be added to the expectations in
`verify-schema.mjs` in the same change. Prisma 7.10 offers a `partialIndexes`
preview feature that would make partial indexes visible to Prisma. It was not
adopted because it is a preview; revisit when it is GA.

## F. Multi-file schema: PASS

`prisma/schema/` contains `base.prisma` (generator and datasource) and
`foundation-spike.prisma` (models), configured through `prisma.config.ts`
(`schema: "prisma/schema"`). `prisma validate`, `prisma generate`, `migrate dev`,
`migrate deploy`, `migrate status` and `migrate diff --to-schema prisma/schema` all
operate on the directory. Multi-schema (`schemas = ["public", "foundation_spike"]`,
`@@schema`) is GA in this version and works with it. The generated client (`prisma-client` generator,
ESM, `.js` import extensions) compiles cleanly under the repository's strict
TypeScript settings (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`noPropertyAccessFromIndexSignature`).

## G. Type containment: PASS

Checks:

1. `src/containment.test.ts` emits the package's public declarations in memory
   with the TypeScript compiler (comments stripped), follows every declaration
   file reachable from each `exports` entry point (`.`, `./testing`), and fails on
   any reference to `@prisma/`, `prisma`, `generated/`, `PrismaClient`, `pg` or
   `Pool`. A non-vacuity assertion confirms internal declarations do reference the
   generated client. Negative control: temporarily exporting
   `createPrismaClient` from `src/index.ts` failed the test.
2. The runtime public root exports only `createDatabase`; the `Database` interface
   exposes `unitOfWork: UnitOfWork` (application port), `ping()` and
   `disconnect()`. `TransactionScope` is the application's opaque brand; the
   Prisma transaction client is resolved through a module-private `WeakMap` and
   is unusable after the transaction ends.
3. dependency-cruiser:
   - `prisma-only-in-database` and `pg-only-in-database` confine the vendor
     packages;
   - `database-spike-not-in-production` keeps the spike module out of shipped
     code;
   - `database-testing-is-not-production` does the same for the testing helpers;
   - the package `exports` block deep imports such as
     `@tali/database/src/generated/...`, which fail at compile time and at runtime.
4. ESLint bans `@prisma/client` outside `packages/database`, `@prisma/*` and `pg`
   in domain/application, and `$queryRawUnsafe`/`$executeRawUnsafe` everywhere.
   On protected models it also bans `update`/`updateMany`/`upsert`/`delete`/
   `deleteMany`. All of these were verified with probe files.
5. `src/foundation-spike/**` is excluded from the build, so no spike code ships.

## Role protection (Wave B section 7)

The bootstrap (`sql/bootstrap-roles.sql`) creates two roles:

- `tali_owner`, which owns the databases and schemas and runs migrations;
- `tali_app`, the runtime role, created with `LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOBYPASSRLS NOINHERIT` and given only `CONNECT` and `USAGE`.

Table privileges come only from migrations. Results on the spike table
`protected_entry` (`role-protection.integration.test.ts`, 16 tests):

- `tali_app`: `INSERT` and `SELECT` succeed. `UPDATE`, `DELETE` and `TRUNCATE`
  fail with 42501 (insufficient_privilege), both in SQL and through Prisma
  (`update`, `deleteMany`), and the row is unchanged.
- `tali_app` cannot create tables in any schema, alter or drop tables, create
  schemas, or read `_prisma_migrations`. A self-`GRANT UPDATE, DELETE` is a
  PostgreSQL warning that grants nothing, and UPDATE/DELETE still fail afterwards.
- `tali_app` keeps full DML on ordinary spike tables, so the protection is
  table-specific.
- `tali_owner` can add a column, add an index and drop the column on the protected
  table (inside a rolled-back transaction), so schema-migration capability is
  retained.
- `information_schema.role_table_grants` for `tali_app` on `protected_entry` is
  exactly `INSERT, SELECT`.

Implication: this is the pattern for ledger and audit tables. Protection is
enforced by grants (REVOKE, not triggers), checked at lint time and verified in
CI by `verify-schema.mjs`.

## Operational findings

- pnpm 11 blocks dependency install scripts by default. Two were allowed
  explicitly in `pnpm-workspace.yaml` (`allowBuilds`):
  - `prisma` preinstall, which only checks the Node version;
  - `@prisma/engines` postinstall, which downloads the checksum-verified schema
    engine used by `migrate`.

  The Prisma 7 runtime has no native query engine (it uses the TypeScript query
  compiler with the `pg` driver adapter).
- Prisma 7 does not read `.env` itself. `prisma.config.ts` loads the
  repository-root `.env` when present; CI sets variables explicitly.
- Prisma 7 refuses `migrate reset` when it detects an AI agent unless the user
  gives explicit consent. This is compatible with the rule that reset is
  local/test only. The test database is reset by recreating its tmpfs container
  instead.
- The CLI prints a major-version update banner (to 8.0 RC). Scripts set
  `PRISMA_HIDE_UPDATE_MESSAGE=1`. Upgrading to Prisma 8 requires re-running this
  spike.
- Criterion outcomes do not depend on Prisma-specific behaviour beyond the above.
  If a later Prisma release regresses any of them, the integration tests fail in
  CI.

## Deviations from ADR-002

None. ADR-002 anticipated raw parameterized SQL for locking, custom SQL in
migrations, grant-based protection and a separate migration role; all were used
as described.

## Closeout (2026-09-27)

- The outcome is recorded in ADR-002 section 27.
- The forward migration `20260928025500_remove_foundation_spike` drops the five
  spike tables explicitly, then the schema without `CASCADE`. The maintainers
  explicitly approved this, and the approval is recorded in the migration header
  and in `APPROVED_DESTRUCTIVE_MIGRATIONS` in `verify-schema.mjs`.
  `20260927231057_foundation_spike` was not edited. The chain was verified from
  zero on a fresh database: deploy, status, drift, schema verification, and no
  `foundation_spike` objects remaining.
- `verify-schema.mjs` changes:
  - The `tali:allow-destructive` marker now counts only inside migrations listed
    as approved.
  - Any `DROP SCHEMA`, or any `DROP ... CASCADE`, is treated as destructive,
    because it can remove protected tables without naming them.
  - `foundation_spike` must not exist.
- The spike's Prisma models and `src/foundation-spike` were removed. The criteria
  tests now run against test-only fixture tables in the `test_fixtures` schema,
  created by the integration global setup in the disposable `*_test` database and
  dropped by its teardown. They are never a migration. The Prisma-level tests
  there use parameterized `$queryRaw`/`$executeRaw`, because no Prisma model
  exists yet.
- Operational finding: Prisma resets only the schemas listed in the datasource
  when it prepares a shadow database. After `foundation_spike` left the list,
  shadow databases that already held it failed to replay migration 1 ("relation
  already exists"). Fresh databases (CI) are unaffected. The disposable shadow
  databases here were cleaned once.
