# Build 3 Slice 1: ledger domain and application

- Date: 2026-10-16
- Branch: `feature/build-3-slice-1-ledger-domain`
- Baseline: `542a9ba9715950d46508d43e0806a18055b49838`
- Status: **COMPLETE** (all S1 gates passed; awaiting human review; nothing committed).
- Governing ADRs: ADR-009 (ACCEPTED 2026-10-15), ADR-004, ADR-005, ADR-006; Plan 005 S1; `mvp-scope.md`.
- Scope: pure ledger domain and application foundation only.
- Not in this slice: migrations, Prisma schema, PostgreSQL repositories, `db:ledger-consistency`, sales, inventory
  valuation, tax configuration, API controllers, web/mobile clients (S2–S9).
- Dependencies: **none added**. The lockfile is unchanged. ADR-009/010/011 are unchanged.

## Summary

| Area | Result |
| ---- | ------ |
| Account types, normal-balance mapping, 13 system roles | PASS |
| Chart template v1 (accountant codes/names; no currency/tenant) | PASS |
| `assertValidChartTemplate` requires exact `SYSTEM_ACCOUNT_ROLE` set | PASS |
| `PostingPlan` balancing, zero-line omission, currency checks | PASS |
| Reversal mirroring (direction swap; original immutable) | PASS |
| `ProvisionChartOfAccounts` idempotent; audit once | PASS |
| Partial/inconsistent chart → `LEDGER_CHART_INCOMPLETE` (no repair) | PASS |
| Internal `LedgerPostingService` (no public post API) | PASS |
| `ledger:read` OWNER + ACCOUNTANT only | PASS |
| `ledger.chart_provisioned` bounded payload | PASS |
| AI / client / posting-importer / database-ledger boundary rules | PASS |
| No migrations / schema / DB persistence | PASS |
| No new npm dependencies | PASS |

## Pre-commit review fixes (2026-10-16)

Code review verdict was **APPROVE WITH FIXES**. Applied before commit:

1. **Restored AI rule identity** to `ai-no-catalog-inventory` (ADR-009 extends; does not rename). Target path still
   includes catalog, inventory and ledger.
2. **Added `ledger-posting-importers`**: only `ledger`, `inventory` and `sales` (future path) may import
   `modules/ledger/posting.ts`. Posting is not re-exported from `ledger/index.ts`.
   `application-module-public-surface` allows that posting entry as the sole deep-import exception.
3. **Incomplete chart fail-closed**: `ProvisionChartOfAccounts` returns idempotent success only when the chart
   matches the template exactly; partial/corrupt charts throw `LEDGER_CHART_INCOMPLETE` with no write and no audit.
4. **Template completeness in the domain validator**: `assertValidChartTemplate` requires every accepted system role
   exactly once (plus unique codes and role→type checks).

### Error code distinction

| Code | When |
| ---- | ---- |
| `LEDGER_NOT_PROVISIONED` | Posting needs a role that is absent (often zero chart / missing role). |
| `LEDGER_CHART_INCOMPLETE` | Provisioning finds some accounts for the template version but the set is partial or inconsistent. |

## Files changed (exact)

### Domain (`packages/domain`)

- `src/modules/ledger/account-type.ts`
- `src/modules/ledger/roles.ts`
- `src/modules/ledger/chart-template.ts` (`assertValidChartTemplate`)
- `src/modules/ledger/posting-plan.ts`
- `src/modules/ledger/ids.ts`
- `src/modules/ledger/index.ts`
- `src/modules/ledger/ledger.test.ts`
- `src/index.ts` (export ledger module)

### Application (`packages/application`)

- `src/modules/ledger/ports.ts`
- `src/modules/ledger/provision-chart.ts` (`chartMatchesTemplate`, incomplete fail-closed)
- `src/modules/ledger/posting.ts` (explicit posting entry; not barrel-exported)
- `src/modules/ledger/reads.ts`
- `src/modules/ledger/audit-actions.ts`
- `src/modules/ledger/index.ts` (reads/provision/ports only)
- `src/modules/ledger/ledger.test.ts`
- `src/testing/in-memory-ledger-store.ts` (`removeRole`, `corruptAccount`)
- `src/testing/index.ts`
- `src/modules/identity/permissions.ts` (`ledgerPermissions`, OWNER/ACCOUNTANT grants)
- `src/modules/identity/permissions.test.ts`
- `src/modules/identity/index.ts`
- `src/errors/application-error.ts` (`LEDGER_NOT_PROVISIONED`, `LEDGER_CHART_INCOMPLETE`)
- `src/index.ts`
- `src/audit/tali-audit-registry.ts`
- `src/audit/audit-payload.test.ts`

### Boundaries and API mapping

- `.dependency-cruiser.cjs` (`ai-no-catalog-inventory` extended; `ledger-posting-importers`; client + DB ledger
  rules; posting entry exception on module public surface)
- `tooling/dependency-cruiser/application-boundary-self-test.mjs`
- `apps/api/src/errors/error-envelope.filter.ts`
- `apps/api/src/errors/error-envelope.filter.test.ts`

### Documentation

- `docs/audits/build-3-slice-1.md` (this file)
- `docs/plans/005-build-3-sales-ledger.md` (S1 status → COMPLETE; S2 not started)

## Architecture decisions applied

1. **No public journal API.** Posting is only `LedgerPostingService.post` inside a source mutation's transaction.
2. **Roles, not codes.** Plans name `SystemAccountRole`; the posting service resolves accounts per business.
3. **Fail closed.** Missing role on post → `LEDGER_NOT_PROVISIONED`; incomplete chart on provision →
   `LEDGER_CHART_INCOMPLETE`; nothing written in either case.
4. **One currency.** Plan currency must match `BusinessContext.currency`; no FX; no hardcoded NGN.
5. **Chart template v1** is immutable domain data; provisioning is idempotent by `(businessId, templateVersion)`.
6. **Audit** records only `templateVersion` and `accountCount`.
7. **Period control hook** `assertPeriodAllowsPosting` always allows in Build 3 (documented extension point).
8. **Posting import allowlist** (ADR-009 section 3): inventory and sales (and ledger) only.

## Test evidence

- Domain: chart uniqueness, type→normal balance, `assertValidChartTemplate` reject/accept cases, balanced/unbalanced
  /mixed-currency/zero-omission plans, reversal immutability, non-NGN currency, 200 seeded property-style plans.
- Application: provisioning + idempotent replay + isolated tenants + rollback; partial and corrupt chart →
  `LEDGER_CHART_INCOMPLETE` with no repair/audit; posting + missing role + currency mismatch + cross-tenant +
  multi-line balances; `ledger:read` matrix; 40 seeded application postings.
- Permission catalogue tests updated for Build 3 `ledger:read`.
- Audit registry includes `ledger.chart_provisioned`.

## Boundary evidence

- `ai-no-catalog-inventory` (historical name retained; reachability includes `modules/ledger`).
- `ledger-posting-importers`: inventory/sales/ledger → `ledger/posting.ts` allowed; catalog/business denied.
- Self-test covers AI → ledger posting/ports; inventory/sales allowed posting; unrelated modules denied.
- Clients forbidden from importing `packages/application/src/modules/ledger/`.
- Application/domain forbidden from importing `packages/database/src/.*/ledger` (S2 path reserved).

## No persistence / migration / schema

No `ledger_accounts`, `journal_entries` or `journal_lines` tables; no Prisma changes; no migrations; no PostgreSQL
repositories; no `db:ledger-consistency`; no operator chart-provisioning command. S1 ports are implemented only by
`InMemoryLedgerStore` for tests.

## Known limitations / S2 handoff

- Wire `ProvisionChartOfAccounts` into business creation and the operator command.
- Implement PostgreSQL repositories, grants (SELECT/INSERT only), typed source FKs, consistency script.
- HTTP read routes for accounts, balances and journal entry (`ledger:read`).
- Sales/valuation modules call `LedgerPostingService` via `../ledger/posting.js` when they arrive (S3–S5).

## PR #22 review fix: reversal source identity

ADR-009 section 13 requires a reversal to carry the same typed source as its original entry. The `REVERSAL` path of
`LedgerPostingService.post` now loads the original and rejects the request with `ValidationError`
("reversal source must match the original journal source", path `source`) unless both `source.kind` and `source.id`
equal the original's. The check runs before any insert, so a mismatch writes nothing; the request source is never
silently replaced. Application tests cover a same-source reversal (entry kind `REVERSAL`, `reversesEntryId`, same
source, mirrored directions, unchanged roles, accounts and amounts) and rejection of a different source id and a
different source kind, each leaving only the unchanged original entry.

## Gate results

| Gate | Result |
| ---- | ------ |
| Focused domain ledger tests | 31 passed |
| Focused application ledger tests | 21 passed (18 at submission + 3 reversal source identity tests) |
| Focused API error-envelope tests | 36 passed |
| `pnpm boundaries` | self-test pass; no violations (718 modules, 3739 dependencies) |
| `pnpm verify` | exit 0 (18 of 18; 2026-10-16 pre-commit fix pass and reversal source fix pass) |
| `git diff --check` | clean |

One earlier pre-commit-fix `pnpm verify` failed under parallel host load with no assertion failure: web Vitest
workers did not start (5 of 19 files ran). Web (296) and mobile (450) then passed unchanged in isolation; the
unchanged retry of `pnpm verify` exited 0. No timeout or configuration was changed. DB integration suites were not
run; S1 does not touch schema or repositories.
