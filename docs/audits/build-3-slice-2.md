# Build 3 Slice 2: ledger account persistence and chart provisioning

- Date: 2026-10-16
- Branch: `feature/build-3-slice-2-ledger-persistence`
- Baseline: `e12f87d` (merge of PR #22, Build 3 S1)
- Status: **COMPLETE** (all reduced-scope S2 gates passed, including after the pre-commit review fixes). S3 has not
  started.
- Governing ADRs: ADR-009 (ACCEPTED 2026-10-15), ADR-004, ADR-005, ADR-006; Plan 005 S2; `mvp-scope.md`.
- Dependencies: **none added**. The lockfile is unchanged. ADR-009/010/011 are unchanged.

## Scope decision: S2 split (maintainer, 2026-10-16)

Plan 005 originally put `ledger_accounts`, `journal_entries` and `journal_lines` in S2. ADR-009 section 13 requires
every journal entry to carry exactly one **typed** source column with a composite tenant foreign key, and assigns
each source column to a later slice (`opening_batch_id`, `goods_receipt_id`, `adjustment_id`, `stocktake_id` and
`valuation_id` to the valuation slice S3; `sale_id` to the sales persistence slice S5). In S2 no source column may
yet exist, so a journal entry could only be persisted with a polymorphic source pair, a placeholder
foreign key, or a nullable source, each of which ADR-009 forbids. This was surfaced as a stop condition before any
change to the accepted architecture.

The maintainer chose the **split-plan** option:

- S2 delivers `ledger_accounts` persistence, its grants and repository, atomic chart provisioning in business
  creation, the idempotent operator command for existing businesses, chart checks in `db:ledger-consistency`, and
  `verify-schema` coverage.
- `journal_entries`, `journal_lines`, the PostgreSQL journal repository and the journal checks in
  `db:ledger-consistency` move to S3, which introduces the first typed source columns.
- ADR-009 is not edited. Plan 005 records the split.

## Summary

| Area | Result |
| ---- | ------ |
| `ledger_accounts` table: PK, `(business_id, id)`, `(business_id, code)`, `(business_id, system_role)` unique | PASS |
| RESTRICT tenant FK to `businesses`; 9 CHECK constraints (type, balance, role, role↔type, status, code, name) | PASS |
| Grants: `tali_app` SELECT, INSERT only (UPDATE, DELETE, TRUNCATE denied, 42501) | PASS |
| `LedgerAccountRepository` (tenant-scoped reads, fail-closed row mapping, conflict translation) | PASS |
| Chart provisioned inside the CreateBusiness transaction (no nested unit of work) | PASS |
| Operator command for existing businesses: idempotent, business row lock, system actor | PASS |
| `db:ledger-consistency` (read only, app role, chart checks, `MISSING_CHART` fails the check) | PASS |
| Mixed, unknown and unreadable charts fail closed as `LEDGER_CHART_INCOMPLETE` during provisioning | PASS |
| Local rollout: migration, operator command, clean `db:ledger-consistency` | PASS |
| `verify-schema` expectations for the table, grants, CHECKs and unique indexes | PASS |
| Migration additive only, no data backfill, atomic on failure | PASS |
| No journal tables, sales, valuation, tax, API ledger routes or UI | PASS |
| No new npm dependencies; no ADR edits; no old migration edits | PASS |

## Files changed (exact)

### Database (`packages/database`)

- `prisma/migrations/20261016120000_build3_ledger_accounts/migration.sql` (new)
- `prisma/schema/ledger.prisma` (new), `prisma/schema/business.prisma` (relation)
- `scripts/verify-schema.mjs`
- `scripts/check-ledger-consistency.mjs` (new), `package.json` (`db:ledger-consistency`)
- `src/repositories/ledger-account-repository.ts` (new)
- `src/ledger/consistency-query.ts` (new)
- `src/database.ts` (`ledgerAccounts` repository)
- `src/testing/tenancy-fixtures.ts`, `src/testing/index.ts`
- `test/support/tenancy.ts`, `test/support/ledger.ts` (new)
- `test/integration/e-custom-migration.integration.test.ts`, `test/integration/k-create-business.integration.test.ts`
- `test/integration/zh-ledger-account-constraints.integration.test.ts` (new)
- `test/integration/zi-ledger-account-repository.integration.test.ts` (new)
- `test/integration/zj-ledger-chart-provisioning.integration.test.ts` (new)
- `test/integration/zk-ledger-consistency-script.integration.test.ts` (new)
- `test/integration/zl-ledger-migration-safety.integration.test.ts` (new)

### Domain (`packages/domain`)

- `src/modules/ledger/chart-template.ts` (`findChartTemplate`), `src/modules/ledger/index.ts`

### Application (`packages/application`)

- `src/modules/ledger/provision-chart.ts` (`ChartOfAccountsProvisioning.provisionInTransaction`)
- `src/modules/ledger/provision-existing-business.ts` (new), `provision-existing-business.test.ts` (new)
- `src/modules/ledger/ports.ts` (`LedgerBusinessLock`, `listProvisionedTemplateVersions`,
  `StoredLedgerAccountInvalidError`), `src/modules/ledger/index.ts`
- `src/modules/ledger/ledger.test.ts`
- `src/modules/business/create-business.ts`, `create-business.test.ts`
- `src/testing/tenancy-harness.ts`, `src/testing/in-memory-ledger-store.ts`

### API (`apps/api`)

- `src/operator/provision-ledger-charts.ts` (new), `provision-ledger-charts.test.ts` (new)
- `src/operator/provision-ledger-charts-cli.ts` (new), `package.json` (`ops:provision-ledger-charts`)
- `src/composition/api-services.ts`
- `test/integration/ledger-chart-provisioning.integration.test.ts` (new)

### Documentation

- `docs/audits/build-3-slice-2.md` (this file)
- `docs/plans/005-build-3-sales-ledger.md` (S2 status and split; S3 outcome gains the journal tables)

## Design

1. **Transaction-scoped provisioning.** `provisionInTransaction(scope, envelope)` runs inside the caller's
   transaction and opens no unit of work. CreateBusiness calls it after the membership audit record, so the
   business, owner membership, default location, 13 accounts and the `ledger.chart_provisioned` audit commit or roll
   back together. The S1 `ProvisionChartOfAccounts` use case wraps the same step in its own unit of work.
2. **Operator command (ADR-009 section 29, M16).** `ProvisionExistingBusinessChart` locks the business row
   (`SELECT ... FOR UPDATE` via the structural `LedgerBusinessLock` port, avoiding a ledger→business module import),
   returns `NOT_FOUND` for an unknown business, and provisions with the system actor
   `ledger.chart_provisioning` and source channel `system`. It provisions ACTIVE and SUSPENDED businesses. The
   stored chart is classified before any write:

   | Stored chart | Result |
   | ------------ | ------ |
   | No accounts | provision template V1 |
   | Exactly V1 | no-op, `alreadyProvisioned` |
   | Partial or corrupt V1 (missing, renamed or recoded account) | `LEDGER_CHART_INCOMPLETE` |
   | Mixed template versions | `LEDGER_CHART_INCOMPLETE` |
   | Only an unknown template version | `LEDGER_CHART_INCOMPLETE` |
   | A stored row that cannot be restored (for example no system role) | `LEDGER_CHART_INCOMPLETE` |
   | A known template version different from the requested one | `ConflictError` |

   The repository only reports the distinct stored versions (`listProvisionedTemplateVersions`); the application
   service decides, using the domain helper `findChartTemplate`. Nothing is repaired and no audit record is
   written in any failing case. Concurrent runs serialize on the row lock; the
   `(business_id, system_role)` and `(business_id, code)` unique keys are a second guard and surface as
   `ConflictError` if the lock is bypassed.
3. **CLI.** `pnpm --filter @tali/api ops:provision-ledger-charts -- --business <id> [--business <id> ...]` runs as
   the application role. Output is limited to business IDs, status (`PROVISIONED`, `ALREADY_PROVISIONED`,
   `FAILED code=...`), counts and a correlation ID. Malformed IDs are shown as `<invalid>`. Exit 1 on any failure.
   One leading `--` (passed through by `pnpm --filter ... <script> -- ...`) is ignored. There is no `--all` option.
4. **Consistency script.** `db:ledger-consistency` runs as `tali_app` inside `BEGIN READ ONLY` and always rolls
   back; it never repairs. It reports `MISSING_CHART` (an ACTIVE business with no ledger accounts),
   `ACCOUNT_WITHOUT_SYSTEM_ROLE`, `UNKNOWN_TEMPLATE_VERSION`, `TEMPLATE_MISMATCH`, `MIXED_TEMPLATE_VERSIONS` and
   `CHART_INCOMPLETE` by business and account ID only (no business name, account name or code). Any issue exits 1.
   SUSPENDED businesses without a chart are not reported. The SQL template rows are tested against
   `CHART_TEMPLATE_V1`.
5. **Repository row mapping fails closed** with `StoredLedgerAccountInvalidError` on a null system role, a normal
   balance that does not match the type, a non-`ACTIVE` status, or any value the domain rejects. Validation is not
   weakened; provisioning maps this error to `LEDGER_CHART_INCOMPLETE`.
6. **Immutability.** The app role cannot UPDATE, DELETE or TRUNCATE `ledger_accounts`; the business FK is RESTRICT.

## Migration safety, backfill and dependency review

- `zl` deploys the eight pre-S2 migrations on the shadow database and seeds representative Build 2 data for two
  businesses: user, business, default location, owner membership, category, product, priced variant, price
  history row, opening stock document, `OPENING` movement and its balance, a draft stocktake with a counted line,
  an audit record and a user idempotency record. A test asserts every seeded table is non-empty. It then injects `SELECT 1 / 0;`
  before the S2 `GRANT`, and confirms the schema fingerprint, grants and Build 2 data hashes are unchanged (nothing
  partial). After `migrate resolve`, the real migration applies: Build 2 data unchanged, 0 ledger accounts, exactly
  the expected added objects (table, 3 unique indexes, PK, FK, 9 CHECKs, NOT NULLs, `tali_app` SELECT and INSERT only).
- No data backfill: the migration creates no rows. Existing businesses get a chart only through the operator command.
- No existing migration was edited; the migration is additive (statement-start checks in `zl`).
- No package was added or upgraded; `pnpm-lock.yaml` is unchanged.
- No S3, S4 or S5 work: no journal, valuation, cost, `SALE` movement, sales, tax, ledger HTTP route or UI code.

## Test evidence

| Suite | Tests |
| ----- | ----- |
| Application `create-business.test.ts` (chart in creation, replay, rollback per failing step) | 28 |
| Application `ledger.test.ts` | 21 |
| Application `provision-existing-business.test.ts` (incl. mixed, unknown-only and unreadable charts) | 8 |
| API `provision-ledger-charts.test.ts` (argument parsing incl. leading `--`, report format) | 11 |
| DB `zh` constraints and privileges | 43 |
| DB `zi` repository (currency NGN/JPY, tenant isolation, conflict rollback, fail closed, version list) | 7 |
| DB `zj` provisioning (rerun, SUSPENDED, 6 corruption cases, NotFound/Validation, parallel runs, lock races) | 14 |
| DB `zk` consistency script (healthy, `MISSING_CHART` then operator fix, SUSPENDED, broken data, no URL) | 7 |
| DB `zl` migration safety (representative Build 2 data, injected failure, data unchanged, additive only) | 6 |
| DB `k` create business (13 accounts, chart audit, rollback on ledger insert / chart audit failure) | 14 |
| DB `e` custom migration | 16 |
| API `ledger-chart-provisioning` integration (HTTP creation, operator runner end to end) | 2 |

Cross-tenant: repository reads for business A never return business B accounts; the operator command for one
business leaves others unchanged; consistency issues are attributed to the correct business.

## Pre-commit review fixes

The pre-commit review returned APPROVE WITH FIXES. Findings and fixes:

1. **Missing charts were informational.** After the S2 rollout every ACTIVE business must have template V1, so
   `db:ledger-consistency` now reports `INCONSISTENT MISSING_CHART business=<business-id>` for each ACTIVE business
   with no ledger accounts and exits 1. The informational count was removed. SUSPENDED businesses are not reported;
   the operator command may still provision them. The migration still creates no rows.
2. **Mixed and unknown template versions.** The repository port `findProvisionedTemplateVersion` was replaced by
   `listProvisionedTemplateVersions`, so provisioning sees every stored version. Mixed versions and an unknown-only
   version now fail as `LEDGER_CHART_INCOMPLETE` (see the table in Design item 2).
3. **Invalid stored role.** A stored account the repository cannot restore raised a generic error during
   provisioning. The repository now raises `StoredLedgerAccountInvalidError`, which provisioning maps to
   `LEDGER_CHART_INCOMPLETE` with no writes and no audit record. Row validation is unchanged.
4. **Migration-safety fixture.** `zl` now seeds representative Build 2 data across catalog, inventory, stocktake,
   audit and idempotency tables, and runs the real migration path (injected failure, then `migrate resolve`, then
   deploy).
5. **CLI argument passing.** `pnpm --filter @tali/api ops:provision-ledger-charts -- --business <id>` passes the
   literal `--` to the script; the parser now ignores one leading `--` (more than one is still a usage error).

## Local rollout record (2026-10-17)

The local database contained two businesses created before S2. Sequence:

1. Migration: the S2 migration is applied to the local database (`db:migrate:status`: 9 migrations, up to date).
   Deployed environments use `pnpm --filter @tali/database db:migrate:deploy`.
2. `pnpm --filter @tali/database db:ledger-consistency` failed as expected before provisioning (exit 1):

   ```text
   INCONSISTENT MISSING_CHART business=01a0f892-d47c-7256-bc13-9c751620f006
   INCONSISTENT MISSING_CHART business=01a12ce5-8bcf-745d-8462-efb6f97cb76e
   Ledger consistency check failed: 2 issue(s). Nothing was changed.
   ```

3. Operator command (exit 0), with the local development server configuration from `.env.example` in the shell:

   ```text
   pnpm --filter @tali/api ops:provision-ledger-charts -- --business 01a0f892-d47c-7256-bc13-9c751620f006 --business 01a12ce5-8bcf-745d-8462-efb6f97cb76e
   ```

   Both businesses reported `status=PROVISIONED`; summary `provisioned=2 already_provisioned=0 failed=0`
   (correlation `01a14d38-7696-77ce-9f8d-c23e9265f165`). A rerun reported both `ALREADY_PROVISIONED`; summary
   `provisioned=0 already_provisioned=2 failed=0` (correlation `01a14d38-cc56-7099-bed8-170a34dc864a`), exit 0.
4. `pnpm --filter @tali/database db:ledger-consistency` passed (exit 0): "Ledger consistency check passed: every
   active business has a chart matching its template."

The business IDs are local development data. Deployed environments follow the same order: migrate, run the
operator command for each existing business, then require a clean `db:ledger-consistency`.

## Gate results

| Gate | Result |
| ---- | ------ |
| `pnpm verify` | exit 0 (18 of 18 tasks) |
| `pnpm test:integration` | exit 0; database 39 files / 564 tests; API 12 files / 181 passed, 1 skipped; worker 9 passed, 1 skipped |
| `db:migrate:status` (local) | 9 migrations, up to date |
| `db:drift` (local) | no drift (migrations vs schema, migrations vs database) |
| `db:verify-schema` (local) | passed (27 table grant sets, 184 CHECK, 18 unique index, 51 tenant foreign keys) |
| `db:ledger-consistency` (local) | passed after the operator command (failed with 2 `MISSING_CHART` before it) |
| `db:inventory-consistency` (local) | passed |
| `pnpm boundaries` | self-test pass; no violations (733 modules, 3825 dependencies) |
| `pnpm text-integrity` | 818 files, UTF-8 without BOM |
| `git diff --check` | clean |

During the fix pass one full `pnpm verify` run failed in `apps/web` (vitest workers timed out while starting) and
`apps/mobile` (one 30 s Jest timeout) under heavy host load. S2 does not touch either app. Both passed when rerun on
their own (web 19 files / 296 tests; mobile 25 suites / 450 tests), and the following full `pnpm verify` exited 0.
No timeout, retry or configuration was changed. An earlier S2 run had a similar one-off failure in the API
source-scan guard `inventory-state-reader.test.ts`, which passed on rerun.

## Known limitations / S3 handoff

- The operator command takes explicit `--business` IDs; there is no `--all` option.
- The operator CLI reports an unexpected (non-domain) error as a failure without further diagnostics. Improving this
  was out of scope for the fix pass.
- The CLI needs the full server configuration (`loadServerConfig`), not only `DATABASE_URL`.
- S3 adds `journal_entries` and `journal_lines` (SELECT, INSERT only) with the valuation-slice typed source columns
  (ADR-009 section 13), the PostgreSQL journal repository behind the S1 posting port, and the journal checks in
  `db:ledger-consistency` (balanced entries, one original per source, at most one reversal, composite tenant FKs).
- No HTTP ledger read routes yet (S6).
