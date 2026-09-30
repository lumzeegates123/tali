# Build 1 Slice 2: PostgreSQL persistence for identity and tenancy

- Date: 2026-09-29
- Scope: Slice 2 of `docs/plans/003-build-1-identity-tenancy.md`, under ADR-002, ADR-004, ADR-005 and ADR-006 (all
  ACCEPTED). The Prisma schema and migrations for the Build 1 tables, PostgreSQL adapters for every Slice 1 port,
  the unit of work's lock timeout and bounded retry, `verify-schema.mjs` expectations, and integration and
  concurrency tests against real PostgreSQL.
- Not in this slice: API endpoints, guards, DTOs, web or mobile screens, Cognito, AWS, CDK, RLS, the real
  `FingerprintHasher` adapter, invitations and devices (Slice 5), and a `BusinessIdempotencyStore` adapter.

## Summary

| Area | Result |
| --- | --- |
| Schema and migrations (10 tables, 60 named CHECKs, composite tenant FKs, partial unique index) | PASS |
| Grants (no DELETE or TRUNCATE for `tali_app`; insert-only audit, idempotency and identity tables) | PASS, tested as `tali_app` |
| Repositories for every Slice 1 port | PASS |
| Claim-first idempotency store, 16 KiB byte-exact limit, IN_PROGRESS on lock timeout | PASS |
| Unit of work: bounded `lock_timeout`, retry of 40001/40P01 only, at most 3 attempts | PASS |
| Owner invariant under concurrency (ADR-005 section 10 lock) | PASS, including the no-lock control |
| Tenant isolation at the database | PASS |
| `verify-schema.mjs` (fails, never repairs) | PASS against the local and test databases |
| Containment and boundaries | PASS |
| Full verification, integration suite and gitleaks | PASS (see Verification) |

## Schema (`packages/database/prisma/schema`, multi-file)

| Table | Tenant key | Notes |
| --- | --- | --- |
| `currencies` | reference | ISO 4217 code and minor-unit digits 0..4. Seeded with NGN only; tests add KES, JPY, BHD as fixtures. |
| `users` | none | Display name and status only: no business, role, email or phone. |
| `external_identities` | none | Provider `COGNITO` or `LOCAL` only (`FAKE` is rejected by a CHECK); unique `(provider, provider_subject)`. |
| `businesses` | self | Currency FK to `currencies`; structural time-zone CHECKs. |
| `business_locations` | `business_id` | Default must be ACTIVE (CHECK); at most one ACTIVE default per business (partial unique index). |
| `business_memberships` | `business_id` | Five roles and two statuses as CHECKs, `version >= 1`, unique `(business_id, user_id)`. |
| `business_audit_records` | `business_id` | ADR-004 section 8.2 envelope; composite FKs `(business_id, actor_membership_id)` and `(business_id, location_id)`. |
| `platform_audit_records` | subject user | Same envelope; actor is the user or a named system process. |
| `user_idempotency_records` | `user_id` | Unique `(user_id, idempotency_key)`; 32-byte fingerprint; result at most 16384 bytes; retention at least 720 hours. |
| `business_idempotency_records` | `business_id` | Unique `(business_id, actor_type, actor_id, idempotency_key)`. Table only; no adapter until a business-scoped keyed operation exists. |

- Every enumerated value is a named CHECK, never a PostgreSQL enum. There are no triggers, functions, database-side
  UUID defaults or RLS (ADR-002 section 21). All IDs come from the application's ID generator.
- Every tenant-owned table has a `(business_id, id)` unique key so child tables can reference it with a composite
  FK; every FK is `ON DELETE RESTRICT ON UPDATE RESTRICT`.
- Each mutable table has an `updated_at >= created_at` CHECK (ADR-005 section 19).

### Migrations

| Migration | Content |
| --- | --- |
| `20260929212026_build1_identity_tenancy` | Tables, indexes and FKs (generated with `migrate dev --create-only`), then a hand-written section: CHECKs, the partial unique index, grants and the NGN seed. |
| `20260929213019_build1_timestamp_consistency` | The four `updated_at >= created_at` CHECKs, added as a second migration so the first one's applied checksum is untouched. |

No `db push`, no `migrate reset`, and the earlier foundation migrations are unchanged. `migrate diff` from the
migration chain replayed into an empty shadow database shows no drift against either the Prisma schema or the
migrated database.

### Privileges (`tali_app`)

| Table | Grants |
| --- | --- |
| `currencies` | SELECT |
| `users`, `businesses`, `business_locations`, `business_memberships` | SELECT, INSERT, UPDATE |
| `external_identities`, both audit tables, both idempotency tables | SELECT, INSERT |

No table grants DELETE or TRUNCATE, and nothing is granted to PUBLIC. UPDATE on `businesses` also backs the
`SELECT ... FOR UPDATE` owner lock.

### `scripts/verify-schema.mjs`

It fails with a list of differences and never repairs anything. It now checks, exactly:
- the 60 named CHECK definitions (compared with `pg_get_constraintdef`) and the partial index predicate;
- the composite tenant FKs, including their `RESTRICT` actions;
- the exact `tali_app` privileges per table, with no PUBLIC grants;
- that RLS is off on every table, and that the NGN seed is present;
- a migration-text scan: no DROP, TRUNCATE, DELETE FROM, or GRANT of DELETE, TRUNCATE or ALL on the protected and
  no-delete tables.

The ESLint Prisma delegate ban now covers every Build 1 model: update, upsert and delete are banned on the
insert-only and reference models, and delete/deleteMany on the others.

## Adapters (`packages/database/src`)

- **Error mapping** (`errors/postgres-errors.ts`). Prisma 7.10 with adapter-pg does not obscure SQLSTATEs, so no
  stop-and-report was needed. Raw and model errors are `PrismaClientKnownRequestError` P2010 with
  `meta.driverAdapterError.cause.originalCode`. Serialization failures and deadlocks arrive as a bare
  `DriverAdapterError("TransactionWriteConflict")` with `cause.originalCode`. `sqlStateOf` walks both shapes, and
  never treats a Prisma `P....` code as a SQLSTATE.
- **Unit of work** (`unit-of-work/prisma-unit-of-work.ts`):
  - every transaction first runs `set_config('lock_timeout', ..., true)`; the default is 5000 ms, configurable from
    1 to 5000;
  - a 40001 or 40P01 (or P2034) re-runs the whole callback, up to 3 attempts in total, with jittered exponential
    backoff (20 ms base, 200 ms cap) and a 30 s deadline. After the last attempt the error is
    `ConcurrentModificationError`, whose cause is the internal `TransactionConflict`;
  - a lock timeout (55P03) becomes `ConcurrentModificationError` and is not retried;
  - an `ApplicationError` (including `IDEMPOTENCY_IN_PROGRESS`) and every other error propagate unchanged;
  - nested runs join the outer transaction; the policy applies to the outermost run only.
- **Repositories** (`repositories/`): users (registration uses a SAVEPOINT, because the app role cannot DELETE),
  businesses, currencies, locations, memberships, the audit writer and the user idempotency store. All raw SQL is
  parameterized Prisma tagged templates. Business-owned reads and writes filter by `businessId`; the membership
  update matches on `(business_id, id, version)`.
- **Idempotency store**: `insert` checks the result's UTF-8 byte length (`Buffer.byteLength` of the exact JSON text
  sent) before writing, then runs `INSERT ... ON CONFLICT (user_id, idempotency_key) DO NOTHING`. One row means
  `inserted`, zero means `duplicate`. A concurrent claimer waits on the unique index; a wait past `lock_timeout`
  raises `IdempotencyInProgressError`. The database CHECK enforces the same 16384-byte limit independently.
- **Owner lock**: `lockBusinessForMembershipChange` runs `SELECT ... FROM businesses WHERE id = $1 FOR UPDATE`, and
  `countActiveOwners` counts ACTIVE OWNER memberships. The sequence is lock, re-read actor, re-read target, count,
  pure domain transition, write (ADR-005 section 10).
- **Composition**: `createDatabase()` now returns `repositories` as well. The package root's runtime export is still
  only `createDatabase`; Prisma types do not leave the package.

## Application changes (minimal)

- Error codes `IDEMPOTENCY_IN_PROGRESS` and `CONCURRENT_MODIFICATION` (both retryable, both HTTP 409 in the API
  error filter), with `IdempotencyInProgressError` and `ConcurrentModificationError`. Slice 1 deferred them to this
  slice.
- `MembershipRepository` gains `lockBusinessForMembershipChange`, `countActiveOwners` and `update`, and
  `assertMembershipTransition` guards `update` (same identity, version plus one). ADR-005 section 10 requires the
  lock and count; `update` is its write step. No use case calls them yet (member management is Slice 5).
- `InMemoryTenancyStore` implements the three methods.
- `packages/application` still has no runtime dependency beyond `@tali/domain`.

## Tests

All database integration tests run against the Docker PostgreSQL 18 test database. The code under test connects as
`tali_app`; the owner role is used only for setup and assertions.

| New integration file | Tests | Proves |
| --- | --- | --- |
| `j-idempotency-store` | 10 | Round trip; 16384 bytes accepted and 16385 rejected (ASCII and multibyte, counted in UTF-8 bytes); rejection before any write with the whole transaction rolled back; the database CHECK alone; a waiter gets `duplicate` after commit and claims the key after rollback; `IDEMPOTENCY_IN_PROGRESS` at a 150 ms `lock_timeout`, well under 2 s. |
| `k-create-business` | 12 | Atomic success with exact row contents; replay; `IDEMPOTENCY_KEY_REUSED`; the key scoped to the user; rollback through a test-only failing decorator, then a successful retry; unsupported currency; 5 rounds of concurrent same-key requests (one created, one replayed, no raw uniqueness error); IN_PROGRESS against a held transaction; concurrent different commands. |
| `l-owner-invariant` | 11 | The two last owners demoting or suspending themselves concurrently: exactly one succeeds and the other gets `LAST_ACTIVE_OWNER`; without the lock, the same interleaving leaves zero owners (control); crossed changes are refused under the lock; the lock is held to commit and does not block other businesses; lock timeout gives CONCURRENT_MODIFICATION after 1 attempt; an optimistic stale update changes nothing. |
| `m-schema-constraints` | 17 | Every CHECK, the partial unique index, the unique keys and the composite tenant FKs, as `tali_app`. `FAKE` is rejected. |
| `n-app-privileges` | 19 | `current_user` is `tali_app`; DELETE and TRUNCATE are denied on all 10 tables; UPDATE is denied on the 5 insert-only tables; currencies are read-only; no DDL and no `SET ROLE tali_owner`; the Prisma path gets 42501 with the SQLSTATE preserved. |
| `o-repositories` | 14 | Registration round trip; the savepoint on an already-linked identity; 4 concurrent first sign-ins create one user; tenant-scoped reads; a forged-business update matches nothing; hidden suspended memberships and businesses; keyset pagination; currencies NGN, KES, JPY, BHD; audit payload bytes. |
| `p-unit-of-work-retry` | 19 | `lock_timeout` default, configuration and transaction-local scope; settings validation; retry of 40001 and 40P01 with rollback of each failed attempt; exhaustion after 3 attempts; `maxAttempts` 1; the deadline; backoff bounds; no retry of an ApplicationError, a plain Error or 23505; 55P03 is not retried; a real PostgreSQL deadlock is retried and both transactions commit. |

Updated existing files:
- `a-transactions`: write skew without retry is now CONCURRENT_MODIFICATION with a 40001 cause, and a new test shows
  both transactions commit with the default retry.
- `b-row-locking`: NOWAIT now gives CONCURRENT_MODIFICATION with a 55P03 cause.
- `e-custom-migration`: the four migrations; exactly the Build 1 tables; NGN as the only migrated currency.
- `fixture-safety`: the new fixture functions refuse non-test targets.

Unit tests: `postgres-errors.test.ts` (6) in `@tali/database`; `in-memory-tenancy-store.test.ts` (4) in
`@tali/application`; 2 new rows in the API error filter test.

| Suite | Result |
| --- | --- |
| `@tali/database` integration | 16 files, 189 passed (7 new files, 102 new tests) |
| `@tali/database` unit | 2 files, 11 passed |
| `@tali/application` | 16 files, 205 passed |
| `@tali/api` unit | 3 files, 24 passed |
| `@tali/worker` integration | 9 passed, 1 skipped (Linux-only) |
| `@tali/api` integration | 24 passed, 1 skipped (Linux-only); one earlier run had a load-related failure (see below) |
| `pnpm test:integration` (all packages, final run) | PASS (exit 0, 11 of 11 tasks) |

## Verification

| Check | Result |
| --- | --- |
| Text integrity | PASS (382 files, UTF-8 without BOM) |
| Format (`prettier --check`) | PASS |
| Build, lint (`--max-warnings=0`), typecheck | PASS |
| Boundaries (dependency-cruiser) | PASS (323 modules, 1,114 dependencies) |
| Unit tests (all packages) | PASS |
| `pnpm verify` | PASS (exit 0) |
| `verify-schema.mjs` on the local and test databases | PASS |
| `verify-schema.mjs` mutation probe (a CHECK dropped, then DELETE granted to `tali_app`) | FAILED as expected, listing each difference; PASS after restoring |
| `prisma migrate status`, drift check (local and test) | Up to date, no drift |
| gitleaks v8.30.1 (Docker, the CI image): `git` over history | No leaks (10 commits) |
| gitleaks v8.30.1: `dir` over a copy of every changed and untracked file | No leaks (46 files) |

`.gitleaks.toml` is unchanged, and there is no `.gitleaksignore` or allowlist. No dependency was added, and no
version changed.

### Recurring load-related failures (investigated)

- **`@tali/api` "starts and listens with valid configuration".** The test kills the compiled API after a fixed 4 s
  and expects the "api listening" log line. Measured on this machine with the machine idle, startup took 2.7 to 3.2 s
  over four runs. During the parallel turbo run the process had not logged anything when it was killed (empty
  stdout, empty stderr), so this is a time budget overrun, not a startup error. The test passes when run alone
  (twice). It also failed once during Slice 1's full runs, before any Slice 2 change. The larger generated Prisma client (10
  models) may add to startup time. **Stabilized before the Slice 2 commit:** the test
  now waits for readiness instead of a fixed time. It waits for the existing "api listening" log line, polling
  every 50 ms with a 20 s deadline, and fails at once if the process exits early. It then requires a 200 from
  `/health/live` and an empty stderr, and always stops the child and waits for it to exit. Production startup is
  unchanged. It passed 10 of 10 runs alone and 5 of 5 alongside the database integration suite, and it passes in
  `pnpm verify` and the full integration suite.
- **`@tali/web` "Failed to start forks worker".** Vitest could not spawn workers once during a full `pnpm verify`
  on this heavily loaded machine. The web app is untouched, and its 20 tests pass on rerun and in the final `verify`.

## Deviations and decisions to note

1. **Audit actor columns.** System and integration actors are recorded in `actor_name` (the process or provider
   name), and user actors in `actor_user_id` and `actor_membership_id`. A CHECK enforces the shape.
2. **`json`, not `jsonb`.** Audit payloads and idempotency results are `json`, so the stored text is exactly what
   the adapter measured and `octet_length(col::text)` is a byte-exact limit. `jsonb` would reformat the text.
3. **Actor columns on user idempotency records.** `actor_type` and `actor_id` are stored, and a CHECK ties them to
   `user_id`. This keeps the record shape the same as the business-scoped table.
4. **`external_identities` is SELECT and INSERT only.** An identity link is immutable in Build 1.
5. **`device_id` has no FK.** Devices arrive in Slice 5; the audit column exists now for the ADR-004 envelope.
6. **`business_idempotency_records` has no adapter.** The table is created now (as decided), and the adapter comes
   with the first business-scoped keyed operation.
7. **Invitations are deferred to Slice 5** (as decided).
8. **A second migration for the timestamp CHECKs**, rather than editing an applied migration.
9. **`MembershipRepository.update`**, a port addition implied by ADR-005 section 10 (see Application changes).
10. **Migration from empty** is proven by `migrate diff --from-migrations` into an empty shadow database, plus CI's
    fresh database. The integration suite's database is reused between local runs.

None of these conflicts with an accepted ADR.

## Before Slice 3

Nothing blocks Slice 3. It must provide the transport guard and `BusinessContext` resolution over these adapters,
the P0 endpoints, the `LocalIdentityProvider`, and the real `FingerprintHasher` adapter. The API must map
`IDEMPOTENCY_IN_PROGRESS` and `CONCURRENT_MODIFICATION` to retryable 409 responses (the filter already does).
