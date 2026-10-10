# Build 2 Slice 6: stocktake and inventory API

- Date: 2026-10-09
- Status: **COMPLETE** (all gates passed; pending human review; nothing committed or pushed).
- Branch: `feature/build-2-slice-6-stocktake-inventory-api`, based on `main` at
  `a8965d0891dc825a2b5b6efe0490eba7e5ff0459` (the PR #17 merge of Slice 5).
- Scope: Slice 6 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05), as the
  human-approved Slice 6 plan describes, delivered in six internal waves: W1 domain, W2 application, W3 schema and
  migration, W4 repositories, W5 the inventory and stocktake HTTP API with shared contracts, W6 final gates and this
  audit. Quantity-only stocktakes with `COUNT_CORRECTION`, the balance, item and movement reads, and the HTTP API for
  every Slice 5 and Slice 6 inventory use case, including low-stock thresholds.
- Not in this slice (Slice 7 and later): inventory UI on web or mobile, the LOW STOCK indicator, and any `SALE`,
  return, cost, valuation, COGS, ledger or tax behaviour. **Slice 7 is not started.**
- Change set against `main`: 77 files (36 new, 41 modified, 0 deleted), including this audit and Plan 004.
- Dependencies: **none added**. No `package.json` or lockfile change. ADR-008 is unchanged. No `apps/web`,
  `apps/mobile` or `apps/worker` file is changed.

## Summary

| Area                                                                                                      | Result   |
| --------------------------------------------------------------------------------------------------------- | -------- |
| Domain: stocktake header and line state machines, `COUNT_CORRECTION` planning, shared stock application   | PASS     |
| Application: create, count, remove, post, cancel; stocktake, item, balance and movement reads; `STOCKTAKE_STALE` | PASS |
| Database: `stocktakes`, `stocktake_lines`, movement `stocktake_id`, replaced and new movement CHECKs      | PASS     |
| Migration atomicity: explicit `BEGIN`/`COMMIT`, proven against a failure-injected copy                     | PASS     |
| API: exactly 22 inventory routes, all behind authentication, business and device guards, no `:locationId` | PASS     |
| BLIND and FULL stocktake visibility; `STOCKTAKE_STALE` details; movement field allow-list                 | PASS     |
| Business and location isolation (items, documents, stocktakes, thresholds, cursors)                        | PASS     |
| Concurrency suite (nine scenario groups, single attempt, no deadlock)                                     | PASS     |
| Prisma format, validate, generate; migrate deploy and status; drift; verify-schema; consistency           | clean    |
| `pnpm verify`                                                                                             | exit 0 (second, unchanged run; see failed runs) |
| `pnpm test:integration`                                                                                   | exit 0   |
| Post-integration migrate status, drift, verify-schema and consistency                                     | clean    |
| gitleaks (history, changed tree, temporary committed clone)                                               | no leaks |

## Governing decisions

- **ADR-008** (ACCEPTED 2026-10-05), in particular section 7.1 (the fifth movement type), section 8 (typed source
  column, CHECK and FK in the introducing migration), sections 9 and 10 (lock order, negative stock), section 12
  (stocktakes, staleness, posting), section 20 (error codes) and section 22 (forward-only migrations). Unchanged.
- **ADR-004, ADR-005 and ADR-006**: application boundary manifest, tenancy and the dependency rules; unchanged and
  enforced by `pnpm boundaries`.
- **Plan 004**, S6 content and gates.
- **Slice 5 obligations** (`docs/audits/build-2-slice-5.md`, "Slice 6 obligations"): every listed item is delivered
  here.
- **Human-approved Slice 6 plan decisions** referenced in code: D1 one DRAFT per location (any key is `CONFLICT`); D3
  one count form per line (direct, or packs plus optional loose); D4 `STOCKTAKE_STALE` details (at most 50 variant
  IDs and a total, nothing else); D8 a line is stale when its balance version or stock unit changed since counting; D9
  at most 1,000 distinct line rows per stocktake, `REMOVED` rows included; D10 posting with only `REMOVED` lines is
  rejected. The migration comment names this plan "plan 005"; it is the approved Slice 6 plan, not a file in
  `docs/plans/`.

## A. Scope and baseline

- Baseline: `a8965d0` with 7 migrations; verify-schema at Slice 5 reported 24 table grant sets, 2 column grant sets,
  158 CHECKs, 9 partial unique indexes, 12 unique indexes and 41 tenant foreign keys.
- Slice 6 adds one forward-only migration (`20261008120000_build2_stocktake`), giving 8 migrations, 26 table grant
  sets (+2), 4 column grant sets (+2), 175 CHECKs (+17), 11 partial unique indexes (+2), 15 unique indexes (+3) and 50
  tenant foreign keys (+9). These were measured by the unmodified verifier on a freshly recreated database.
- Lint: the only tooling change adds `stocktake` and `stocktakeLine` to `NO_DELETE_MODEL_DELEGATES`, so no code can
  call a delete on either model.

## B. Stocktake domain (`packages/domain/src/modules/inventory/stocktake.ts`)

- Header states `DRAFT`, `POSTED`, `CANCELLED`; transitions only from `DRAFT`; posting an already `POSTED` stocktake
  is a no-op at the application level; `CANCELLED` cannot be posted and `POSTED` cannot be cancelled. Every decision
  is version-guarded.
- Line states `COUNTED` and `REMOVED`. A line captures the counted quantity, the stock unit at count, the expected
  on-hand at count and the balance version at count. A recount requires the current line version (0 or omitted is
  `VERSION_CONFLICT`). The variance is written once, at posting, only on `COUNTED` lines.
- The 1,000-row line bound (D9) is distinct from the 200-line document request cap.

## C. COUNT_CORRECTION (`count-correction.ts`, `stock-application.ts`)

- `planCountCorrections` sets each counted stock item to its counted quantity: variance = counted - on-hand, in the
  stock unit; a unit mismatch is `UNIT_MISMATCH`; counted quantities are never negative, so the resulting balance is
  never negative and the manual-decrease `INSUFFICIENT_STOCK` rule cannot fire.
- Zero variance writes no movement and no balance, but still records a zero variance on the line.
- Movements, balances and variances are produced in ascending variant order; the shared `applyEntries` helper (also
  used by Slice 5 documents) applies deltas and versions.
- A `COUNT_CORRECTION` is never reversible, carries no pack snapshot and no reason code or note; a stock count never
  overwrites a quantity field (`20-financial-integrity.mdc`).

## D. Migration (`20261008120000_build2_stocktake/migration.sql`)

- Order: the two stocktake tables with keys, FKs and CHECKs; the movement `stocktake_id` column and its two FKs; the
  four movement CHECKs that name types or sources (`type_valid`, `one_source`, `direction`, `reason_shape`) dropped
  and re-added by name without `CASCADE`; the three `COUNT_CORRECTION` CHECKs and the one-correction-per-line partial
  unique; no audit change; column-level privileges.
- **The whole file is wrapped in `BEGIN;` ... `COMMIT;`.** Prisma 7.10 `migrate deploy` does not run a migration file
  in one transaction: an experiment without the wrapper left partial DDL (the stocktake tables created and the four
  movement CHECKs dropped but not re-added). With the wrapper any failing statement aborts the transaction and Prisma
  leaves the migration unapplied.
- `zb-stocktake-migration-safety` (8 tests) proves it on the disposable shadow database: the real file has exactly
  one `BEGIN;` first and one `COMMIT;` last and no other transaction statement; a failure-injected copy fails the
  deploy; the failed migration is not recorded while the earlier seven are; no stocktake table, line table or
  `stocktake_id` column exists; the four Slice 5 movement CHECKs keep their original definitions; the schema, index
  and grant fingerprint equals the Slice 5 one; a `COUNT_CORRECTION` movement is still rejected; after resolving the
  failure the real migration applies and builds the full Slice 6 state.
- Re-adding `reason_shape` closes a Slice 5 gap: an original `ADJUSTMENT` or `WRITE_OFF` with a NULL `reason_code`
  made `reason_code IN (...)` UNKNOWN, which a CHECK accepts; the code is now required explicitly. The application
  never wrote such a row, and the migration validates every existing row.
- Existing movements get `stocktake_id` NULL; no row is rewritten.

## E. Schema backstops

- `stocktakes`: status, version, trimmed note of 1 to 500 characters, posted shape (posting columns together and
  exactly when `POSTED`), cancelled shape, and posted or cancelled after created. One `DRAFT` per business and
  location (`stocktakes_one_draft` partial unique).
- `stocktake_lines`: primary key `(business_id, stocktake_id, variant_id)`; status; counted 0 to 10^15; expected and
  variance within 10^15 either way; versions; variance only on `COUNTED` lines.
- Movements: five types; exactly one source among opening, receipt, adjustment and stocktake;
  `count_correction_source` (`COUNT_CORRECTION` exactly when `stocktake_id` is set), `_not_reversible`, `_no_pack`;
  `inventory_movements_count_correction_unique` (one correction per stocktake line).
- Tenant-composite FKs: stocktake to location and the three memberships; line to stocktake, variant and counting
  membership; movement to `(business_id, stocktake_id, variant_id)` on the line and
  `(business_id, stocktake_id, location_id)` on the header, so a correction is pinned to its line's variant and its
  stocktake's location.
- Privileges: `SELECT, INSERT` on both tables; `UPDATE` only on the stocktake lifecycle columns and the line count
  and variance columns; no `DELETE` or `TRUNCATE`; movements stay insert-only. RLS stays off; no triggers or
  functions (0 `ROW LEVEL SECURITY` or `CREATE POLICY` statements across all migrations).
- `za-stocktake-constraints` proves each CHECK, FK and index rejects the violating row, including another business's
  location, memberships, stocktake and variant (23503) and a correction at a location other than its stocktake's.

## F. Locking

- **Count:** stocktake header `FOR UPDATE`, then the counted variant `FOR SHARE`, then a plain balance read (no balance
  lock). A concurrent receipt therefore neither waits for nor blocks a count; its effect is caught at posting by the
  balance version captured on the line.
- **Post:** stocktake header `FOR UPDATE`, then every counted variant `FOR SHARE` in ascending ID order, then every
  balance `FOR UPDATE` in ascending ID order, then the staleness check, the movements, the balance projection, the
  line variances, the header and the audit record, all in one transaction.
- This keeps the Slice 5 global order (document header, variants `FOR SHARE`, balances `FOR UPDATE`). Application
  tests assert the call order (`products.lockVariantsForShare` before `balances.lockForUpdate` on post; no balance
  lock on count).
- Staleness (D8): a counted line is stale when the locked balance version differs from `balanceVersionAtCount` or the
  variant's stock unit differs from the unit at count; any stale line is `STOCKTAKE_STALE` and nothing is written.

## G. API

- Three controllers (`inventory-items`, `inventory-documents`, `stocktakes`) contain no business logic: they parse
  with strict Zod contracts from `@tali/shared`, resolve the default location server-side (`bindDefaultLocation`),
  call the application service and map the result.
- **Exactly 22 inventory routes** (route-guard test `mounts exactly the 22 inventory and stocktake routes`): 9 reads
  (balances, item, item movements, opening batch, goods receipt, adjustment, stocktake list, stocktake, stocktake
  lines) and 13 writes (opening stock, goods receipt, adjustment, write-off, stocktake create, the two reversals,
  threshold set and clear, line count, line remove, post, cancel).
- The global business-scoped route list equals the Build 1 and catalog routes plus these 22 exactly; the routes read
  from metadata equal the routes Express registered; every inventory route has exactly `AuthenticationGuard`,
  `BusinessContextGuard`, `DeviceContextGuard`, with authentication first; no path contains `:locationId`; every
  mutation body schema rejects `locationId`.
- Keyed creations (opening, receipt, adjustment, write-off, stocktake) require `Idempotency-Key`, replay with 201 and
  `Idempotent-Replayed`, and reject a reused key with another body. A stocktake creation replays its DRAFT version-1
  snapshot even after posting.
- Quantities are strings in every response (`nonStringQuantities` is empty after every API test); JSON-number
  quantities, excess precision, both or neither of `quantityMinor` and `decimal`, and unknown fields are 400.
- W6 closed two Plan 004 S6 threshold gate items over HTTP (test-only, no production change): unauthenticated set
  and clear are 401 `UNAUTHENTICATED` with the threshold unchanged, and an archived item with residual stock and a
  threshold above it is listed with `lowStock = false` and absent from `?lowStock=true` (it was `true` before
  archiving).

## H. Security

- **BLIND and FULL.** Actors with `inventory:count-post` (OWNER, MANAGER) see FULL lines, which may contain
  `expectedAtCount` and `variance`; actors with only `inventory:count` (STOCK_KEEPER) see BLIND lines, which never
  contain either key, even as null; CASHIER and ACCOUNTANT cannot read stocktakes. BLIND lines are built fresh and
  parsed with the strict `StocktakeLineBlindSchema` (mapper tests reject both keys, including null values), and the
  HTTP test checks every line returned to each role. BLIND headers keep summary counts.
- **`STOCKTAKE_STALE`.** The envelope details contain exactly `staleVariantIds` (at most 50, ascending) and
  `staleLineCount`, validated in the error filter; any other property on the error is dropped, and invalid details
  become `INTERNAL_ERROR`. No quantity, version or ID appears in the message. The HTTP test checks the keys are
  exactly these two and that nothing was posted.
- **Movements.** Responses never contain `businessId`, `actorMembershipId`, `deviceId`, `correlationId` or any other
  key in `FORBIDDEN_INVENTORY_KEYS` (also recorder, membership, `balanceVersionAtCount` and idempotency fields); every
  successful inventory and stocktake response body is scanned at every depth after each test.
- Untrusted or missing device headers fail closed with 403 `DEVICE_NOT_TRUSTED` on reads and writes, with no stock
  change.

## Tenancy and location

- **Business isolation:** business B's owner gets 404 (or the business guard's denial) for A's balances, items,
  movements, documents, reversals, thresholds (set and clear), keyed writes and stocktakes (read, count, remove, post,
  cancel), with the inventory snapshot unchanged (`never lets business B read or change business A's stock` and
  `... stocktakes`; `zd` "another business's member cannot read, count, remove, post or cancel"; `zc` repository
  scoping on every method).
- **Location isolation:** every read and write uses the server-resolved default location. Stock at a second location
  of the same business is not shown (`reads only the default location`); stocktake lists, items, movement history and
  documents are read at the context's location only (`zd` 558 and 619, `zc` 216); a second DRAFT is independent per
  location (`za` 446, `zc` 175); a correction must be at its stocktake's location (`za` 556).
- **Cursors:** a movement cursor resolves only within the same stock item (`zc` 484); over HTTP any cursor that is not
  a movement of this exact item is rejected without saying why, and paging ends with an empty page after the oldest
  movement.
- Composite tenant FKs back every reference; there is no RLS.

## Concurrency (`ze-stocktake-concurrency`)

The suite has 17 test definitions; the two in groups 3 and 4 run once for a receipt and once for an adjustment. Every
scenario runs on a single unit-of-work attempt (`maxAttempts: 1`), so a deadlock (40P01) or serialization
failure could not be hidden by a retry; forced scenarios hold one transaction open and prove the other waits.

1. Counter versus counter: two recounts from one line version, and two first counts of one variant, give one winner
   and one `VERSION_CONFLICT` (free and forced).
2. Count versus receipt: neither waits for the other; the post is then `STOCKTAKE_STALE`; a receipt committed before
   counting is part of the expected quantity.
3. and 4. Post versus receipt or adjustment, in both orders: post first, the movement waits and applies on the
   corrected balance; movement first, the post waits and is `STOCKTAKE_STALE` with nothing written.
5. Post versus post: one posts, the other is a no-op; corrections are written once.
6. Post versus count: post first, the count is `CONFLICT` on the POSTED stocktake; count first, the post is
   `VERSION_CONFLICT` and writes nothing.
7. Cancel versus post: whichever is second is `CONFLICT`; a cancelled stocktake writes no correction.
8. Create versus create: one DRAFT and one `CONFLICT`, no orphan idempotency record; forced, the second waits on the
   one-DRAFT index and its key runs fresh once the first is terminal.
9. Multi-line posts racing reverse-order receipts and adjustments never deadlock on a single attempt.

The inventory consistency query is empty after every scenario.

## I. Known design boundaries

- One default location per business; no transfers, no multi-location reporting.
- No cost, valuation or ledger effect for `COUNT_CORRECTION`; quantity only.
- Counting and removing lines are draft work and are not audited; starting, cancelling and posting are (bounded
  payloads; per-line quantities stay on the lines and movements).
- `STOCKTAKE_STALE` is not retryable unchanged: stale lines must be recounted. If the rule proves unusable in pilot
  walkthroughs, ADR-008 must be revised rather than the rule weakened (Plan 004 S6 stop condition).
- A count does not lock the balance, by design (section F); staleness is detected at posting.
- The 1,000-row line bound counts `REMOVED` rows.
- Visibility filtering applies to stocktake responses only; balances are not hidden from roles that may read
  inventory.

## J. Final verification

| Check                                                                                                          | Result |
| -------------------------------------------------------------------------------------------------------------- | ------ |
| `prisma format`, `prisma validate`, `prisma generate` (sequential, `packages/database`)                         | exit 0; schema unchanged by format; client 7.10.0 generated |
| Recreated test container; `db:migrate:deploy`, `db:migrate:status`, `db:drift`, `db:verify-schema`, `db:inventory-consistency` | 8 migrations applied; up to date; drift ok both ways; verification passed with the counts in section A; consistency passed |
| `zb-stocktake-migration-safety`                                                                                 | 8 passed |
| Focused database: `za` constraints, `zc` repositories, `zd` use cases, `ze` concurrency, consistency script, custom migration chain | 6 files, 105 passed |
| Focused domain: stocktake, count-correction, movement                                                          | 3 files, 101 passed |
| Focused application: stocktakes, stocktake-post, stocktake-queries, inventory-reads, stocktake-stale            | 5 files, 89 passed |
| Focused shared inventory contracts                                                                             | 26 passed |
| Focused API unit: mappers, error filter, API services, route guards                                            | 4 files, 74 passed |
| Inventory API and stocktake API integration                                                                    | 24 and 17 passed |
| Catalog regression: catalog API; catalog database (`t`, `u`, `v`); catalog domain; catalog application          | 31; 71; 46; 108 passed |
| `pnpm boundaries` (including `ai-no-catalog-inventory`)                                                        | self-test pass; no violations (660 modules, 3353 dependencies) |
| `pnpm text-integrity`, `pnpm format:check`, `pnpm lint`, `git diff --check`                                     | 732 files UTF-8 without BOM or NUL; Prettier clean; ESLint 0 warnings; clean |
| Byte scan of all changed files                                                                                 | UTF-8, no BOM, LF only, no NUL, no UTF-16 |
| Typecheck (uncached, all 18 tasks: domain, application, database, shared, API, web, mobile, worker and tooling) | exit 0 |
| `pnpm verify` (alone)                                                                                          | first run failed (web worker start-up, below); unchanged retry exit 0, 18 of 18 tasks |
| `pnpm test:integration` (alone, after verify)                                                                  | exit 0 on the first run, 12 of 12 tasks |
| Post-integration `db:migrate:status`, `db:drift`, `db:verify-schema`, `db:inventory-consistency`               | up to date; drift ok both ways; same counts; consistency passed |
| gitleaks v8.30.1 (Docker): full history; changed tree (directory scan); disposable clone with the change set committed | no leaks (26 commits; 75 files before the documentation edits, rescanned after them) |

### Tests

| Suite                                   | Result                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| domain unit                             | 24 files, 435 passed (Slice 5: 22 files, 382)                                   |
| application unit                        | 38 files, 604 passed (Slice 5: 33 files, 514)                                   |
| shared unit                             | 6 files, 69 passed (Slice 5: 5 files, 43)                                       |
| API unit and compat                     | 8 files, 92 passed (Slice 5: 6 files, 60)                                       |
| database unit                           | 3 files, 19 passed (unchanged)                                                  |
| web (Vitest)                            | 15 files, 198 passed (unchanged)                                                |
| mobile (jest-expo)                      | 22 suites, 370 passed (unchanged)                                               |
| worker unit, integrations, config, text-integrity, client-bundle-check | 11, 109, 37, 12 and 8 passed (unchanged)        |
| database integration (full)             | 32 files, 462 passed (Slice 5: 27 files, 364)                                   |
| API integration (full)                  | 11 files, 169 passed, 1 skipped (Slice 5: 9 files, 128 passed, 1 skipped)       |
| worker integration                      | 9 passed, 1 skipped (unchanged)                                                 |

The local test container is published on `127.0.0.1:57433` through the existing `TALI_POSTGRES_TEST_PORT`
override, with the existing `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`, `MIGRATION_DATABASE_URL`,
`SHADOW_DATABASE_URL` and `DATABASE_URL` overrides (local-only credentials from `.env.example`). No repository file
was changed for the port. The gitleaks clone was a temporary local clone checked out at the base, with the change
set copied in and committed there only; it was deleted after the scan. No commit was made on the feature branch.

### Failed and retried runs

- **W5:** mapper typecheck errors (branded-ID `Pick` types; SKU and barcode value objects), fixed with structural
  header interfaces and `.value`; an optional-`undefined` count field under `exactOptionalPropertyTypes`, fixed with a
  conditional spread; an idempotency test helper whose `undefined` key fell back to the default, changed to a `null`
  sentinel; a route-guard test edit that split a `describe` block, rewritten with top-level constants; Prettier
  reformatted several files. All test or wiring fixes; no rule weakened.
- **W3:** the experiment without `BEGIN`/`COMMIT` that left partial DDL (section D) on a disposable database; it is
  the reason for the wrapper.
- W1 to W4 checkpoint failures were reported at their human-reviewed checkpoints; none remains.
- **W6, format check: one failure** on the new threshold tests in `inventory-api.integration.test.ts`; Prettier
  rewrapped lines only.
- **W6, `pnpm verify`, first run: web Vitest workers did not start (no assertion failed).** Only `@tali/web#test`
  failed: 7 of its 15 files reported `[vitest-pool]: Failed to start forks worker ... Caused by: Error:
  [vitest-pool-runner]: Timeout waiting for worker to respond`; the 8 files that started passed (79 of 79); the web
  run took 133 s with most of it in environment setup while turbo ran other suites in parallel (16 of 18 tasks
  successful). No web file is in the change set. This is the host-saturation start-up failure recorded in the Slice 3,
  4 and 5 audits. The **unchanged retry exited 0** (18 of 18; web 15 files, 198 passed). No configuration or timeout
  was changed.

## K. Audit entity type

- `business_audit_records_entity_type_format` is a **format** constraint (`^[a-z][a-z_]*$`, at most 64 characters),
  not a closed registry, so the new `stocktake` entity type needed no database change (migration section H).
- The application audit registry remains the closed layer: `stocktake` is added to the entity-type union and the
  three new actions (`inventory.stocktake_started`, `inventory.stocktake_cancelled`, `inventory.stocktake_posted`)
  are registered with bounded payload schemas (`correctionMovementCount + zeroVarianceCount = countedLineCount`).

## L. Windows skips

- The two skipped tests are the existing SIGTERM graceful-shutdown tests, guarded by
  `skipIf(process.platform === "win32")`: `apps/api/test/integration/startup.integration.test.ts` and
  `apps/worker/test/integration/worker-process.integration.test.ts`. Both were added in `b710e4b` (2026-09-27), are
  unchanged since the base and appear in the Slice 5 audit. Slice 6 adds no skip.
- All runs in this audit were on Windows; **no Linux run is claimed**. The SIGTERM tests run only on Linux CI.

## Risk

- **Inventory integrity.** Counts never set stock: posting writes canonical `COUNT_CORRECTION` movements with a
  `location_id` and the stocktake line as source, updating the version-guarded balance projection under the Slice 5
  locks; zero variance writes nothing; a stale count writes nothing. The consistency query is empty after every
  database and API test and after the full integration run.
- **Tenancy and location.** Every repository method takes `businessId`; the location is always server-resolved;
  composite FKs reject cross-tenant and cross-location references at the database.
- **Permissions.** `inventory:count` for create, count and remove; `inventory:count-post` for post and cancel and
  for FULL visibility; checked before the idempotency lookup and re-checked on the acting membership inside the
  transaction.
- **Idempotency.** Stocktake creation is keyed; post and cancel are naturally idempotent (repeat is a no-op);
  counts and removals are version-guarded.
- **Audit.** One record per effective start, cancel and post, in the same transaction; none for no-ops or draft
  line work.
- **AI.** No AI code exists; the `ai-no-catalog-inventory` boundary covers the new stocktake modules transitively.

## Slice 7 obligations

Slice 7 (inventory clients, web and mobile) must consume only this API: the stock list (archived residual stock
labelled), movement history, receive, adjust, write off, reversals, opening stock, the stocktake count, review and
post flow, threshold set and clear for `inventory:threshold` holders, and the LOW STOCK indicator rendered from the
API flag only (no client derivation, never for archived items). Clients must not reconstruct expected quantities for
BLIND counters. **Slice 7 is not started.**
