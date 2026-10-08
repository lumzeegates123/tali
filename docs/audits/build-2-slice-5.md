# Build 2 Slice 5: inventory core

- Date: 2026-10-08
- Status: **COMPLETE** (all gates passed; pending human review; nothing committed or pushed).
- Branch: `feature/build-2-slice-5-inventory-core`, based on `main` at
  `38321cbb73cccc0ab568f8b790cddecd8307f737` (the PR #16 merge).
- Scope: Slice 5 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05), as the
  human-approved Slice 5 plan describes, delivered in six internal waves: W1 domain, W2 application, W3
  persistence, repositories and the production reader cutover, W4 catalog API guard cases, W5 the AI dependency
  boundary, W6 final gates and this audit. Quantity-only inventory: movements, balances, opening stock, goods
  receipts, adjustments, write-offs, reversals, low-stock thresholds and the derived low-stock state.
- Not in this slice (Slice 6 and later): stocktakes, `COUNT_CORRECTION`, any inventory or threshold HTTP route,
  balance and movement reads, inventory UI on web or mobile, and any `SALE`, return, cost, valuation, COGS, ledger
  or tax behaviour. **Slice 6 is not started.**
- Change set against `main`: 98 files (57 new, 39 modified, 2 deleted: the temporary reader and its test).
- Dependencies: **none added**. The lockfile is unchanged. ADR-008 is unchanged. The only `package.json` change is
  one script entry (`db:inventory-consistency` in `packages/database`).

## Summary

| Area                                                                                                     | Result   |
| -------------------------------------------------------------------------------------------------------- | -------- |
| Domain: four movement types, `Quantity` rules, balances, negative-stock rule, reversals, thresholds      | PASS     |
| Application: eight use cases, seven inventory permissions, eight audit actions, keyed plan/apply split   | PASS     |
| Database: six tables, typed sources, composite tenant FKs, CHECKs, partial uniques, column grants        | PASS     |
| Production `VariantInventoryStateReader`; temporary `PreInventoryStateReader` deleted                    | PASS     |
| UpdateProduct guard: stock-unit change blocked while a threshold is configured at any location           | PASS     |
| Catalog API end to end: real inventory blocks unit and tracking changes through the existing PATCH route | PASS     |
| Consistency query, operator script (read-only, app role, never repairs)                                  | PASS     |
| Concurrency: races, lock ordering, same-key replays, rolled-back claims, with explicit lock evidence     | PASS     |
| AI boundary rule `ai-no-catalog-inventory` with reachability, and its self-test                          | PASS     |
| Prisma format, validate, generate; migrate deploy and status; drift; verify-schema; consistency          | clean    |
| `pnpm verify`                                                                                            | exit 0   |
| `pnpm test:integration`                                                                                  | exit 0   |
| Post-integration migrate status, drift, verify-schema and consistency                                    | clean    |
| gitleaks (history, changed files, temporary committed tree)                                              | no leaks |

## Governing decisions

- **ADR-008** (ACCEPTED 2026-10-05), sections 3.2, 4.3, 6, 7 (7.1 movements, 7.3 balances, 7.4 thresholds), 8, 9,
  10, 11, 15, 18 and 22. Unchanged.
- **Plan 004**, S5 content and gates.
- **D1 (human-confirmed, Option A).** Slice 5 movements support only `OPENING`, `PURCHASE_RECEIPT`, `ADJUSTMENT`
  and `WRITE_OFF`. `COUNT_CORRECTION`, the `stocktake_id` source column, the typed stocktake-line FK and the
  extended movement CHECK and source constraints arrive with stocktakes in Slice 6. No stocktake table exists. This
  follows ADR-008 section 8 ("a future type adds its own typed source column, CHECK and FK in the migration that
  introduces it") and section 22 (forward-only migrations per slice). Between S5 and S6 the type CHECK lists four
  of the five types section 7.1 names for the end of Build 2; after S6 the schema matches ADR-008 exactly.
- **Material approved decisions** (the full table is in the approved Slice 5 plan):
  - D2: duplicate variant lines are `VALIDATION_FAILED`, not merged.
  - D3: adjustment lines carry an explicit `INCREASE` or `DECREASE` direction with a positive magnitude; the
    direction is fingerprinted.
  - D4 and D19: decimal input carries its unit and is normalized to exact minor units before the fingerprint;
    canonical lines are sorted by variant ID; the canonical command includes `locationId` and excludes the
    correlation ID, device ID, source channel, timestamps and the pack factor and name.
  - D5: the keyed result stores the state-independent header snapshot (under the 16 KiB cap); fresh and replayed
    results both add `listOriginals` (originals only, `ORDER BY variant_id`).
  - D6: all seven `inventory:*` permissions are added now.
  - D7: reversals allow archived variants, reject untracked ones, and require the document's location to equal the
    context location (otherwise `NOT_FOUND`).
  - D8: clearing a threshold is allowed on archived or untracked variants; setting needs an ACTIVE, tracked one.
  - D9: a unit other than the stock unit is `VALIDATION_FAILED`; there is no conversion.
  - D11: movement reason columns are enforced by the database (`inventory_movements_reason_shape`).
  - D12: reversal movements carry no pack snapshot.
  - D14: `INSUFFICIENT_STOCK` has a message only and maps to 409.
  - D15: no read use cases in S5; cross-tenant read isolation is proven at repository level.
  - D16: the consistency script uses the app role in a read-only transaction.
  - D18: the balance's last-movement FK is composite with location and variant.
  - D20: pack rows are read without a lock (immutable).
  - **D21 (corrected):** keyed `plan()` is state-independent; every lock, pack lookup, balance read, stock decision
    and write runs in `apply()` after the idempotency claim. `KeyedIdempotency` is unchanged.
  - D22: a reversal no-op takes only the header lock.
  - **D23 (approved):** the old `pre-inventory-state-reader.test.ts` tripwire failed by design from W1 (an
    inventory module existed). The W1 and W2 gates were package-scoped and did not claim repository-wide green;
    the tripwire was never edited, skipped or weakened, and nothing was committed before W3c deleted it together
    with the reader it guarded.

## Domain (`packages/domain/src/modules/inventory/`)

- **Movement types:** exactly `OPENING`, `PURCHASE_RECEIPT`, `ADJUSTMENT` and `WRITE_OFF`. A test asserts that
  `COUNT_CORRECTION`, `SALE`, `CUSTOMER_RETURN` and `SUPPLIER_RETURN` do not exist.
- **Quantity:** the kernel `Quantity` (`bigint` minor units of the variant's stock unit), bounded by 10^15. Excess
  decimal precision, a unit other than the stock unit and JSON-number-like input are rejected; no float anywhere.
- **Movement invariants** (`restoreMovement` re-checks all): the source document matches the type; the delta is
  non-zero; `balanceVersion` is at least 1; no self-reversal; direction per type (OPENING positive and never
  reversible; PURCHASE_RECEIPT positive, its reversal negative; WRITE_OFF negative, its reversal positive;
  ADJUSTMENT any non-zero amount); a pack snapshot only on originals, with `abs(delta) = count * factor` in exact
  `bigint`; reason shape per type.
- **Balance model:** `StockBalance { quantity, version, lastMovementId? }` per business, location and variant; a
  missing row is version 0 and quantity 0. `planStockChange` computes `balanceAfter = balance + delta` and
  `version + 1` per movement and returns movements in ascending variant order.
- **Negative-stock rule:** the balance itself has no non-negative invariant (a negative balance is representable);
  the Build 2 rule lives in the decision: any decrease whose result is below zero raises `INSUFFICIENT_STOCK`
  (negative adjustments, write-offs, receipt reversals, reversals of positive adjustments). Unit and opening checks
  run before the stock check, so the failing line does not depend on line order.
- **Opening:** one per stock item; the balance must be at version 0, otherwise `INVALID_TRANSITION` (409).
- **Reversals:** `reverseDocumentMovements` produces one exact negation per original line (same type, location,
  variant and document; `reversesMovementId` set; no pack; no reason code; the reversal reason as note), sorted by
  variant, under the same stock rule. Opening and reversal movements cannot be reversed. Headers move POSTED to
  REVERSED once.
- **Thresholds:** `decideSetThreshold` and `decideClearThreshold`: an absent row is version 0; the version is
  checked before no-op detection; set inserts version 1 only with `expectedVersion = 0`; a cleared row is kept with
  a NULL value and still has a version; the threshold is 0 or more in the stock unit, with no pack form.
- **Low-stock derivation:** `deriveLowStock` is true only for an ACTIVE, tracked variant with a configured
  threshold and on-hand at or below it (a missing balance counts as zero; threshold 0 flags zero on-hand). Archived
  and untracked variants are never low stock. Nothing is stored; read-time use belongs to Slice 6.
- **Catalog:** `VariantInventoryState` gained `hasConfiguredThreshold`. `updateProduct` rejects a stock-unit change
  while a threshold is configured (`INVALID_TRANSITION`, 409), after the version, no-op and movement checks.
- `INSUFFICIENT_STOCK` added to `DomainErrorCode`.

## Application (`packages/application/src/modules/inventory/`)

| Use case                 | Permission            | Kind                                    |
| ------------------------ | --------------------- | --------------------------------------- |
| `RecordOpeningStock`     | `inventory:opening`   | keyed, `inventory.opening_batch.record.v1` |
| `PostGoodsReceipt`       | `inventory:receive`   | keyed, `inventory.goods_receipt.post.v1` |
| `RecordAdjustment`       | `inventory:adjust`    | keyed, `inventory.adjustment.record.v1` |
| `RecordWriteOff`         | `inventory:adjust`    | keyed, `inventory.write_off.record.v1`  |
| `ReverseGoodsReceipt`    | `inventory:adjust`    | state-setting                           |
| `ReverseAdjustment`      | `inventory:adjust`    | state-setting (both kinds)              |
| `SetLowStockThreshold`   | `inventory:threshold` | state-setting, `expectedVersion` 0 or more |
| `ClearLowStockThreshold` | `inventory:threshold` | state-setting, `expectedVersion` 0 or more |

- **Permissions:** `inventory:read`, `inventory:threshold`, `inventory:opening`, `inventory:receive`,
  `inventory:adjust`, `inventory:count` and `inventory:count-post`, mapped exactly as ADR-008 section 15: OWNER and
  MANAGER hold all seven; STOCK_KEEPER holds read, threshold, receive and count; CASHIER and ACCOUNTANT hold read
  only. The tripwire "no inventory permission" test is replaced by an exact ten-permission matrix test. `count`
  and `count-post` grant nothing until Slice 6 adds their use cases.
- **Audit actions** (business stream, envelope plus `locationId`; no quantities or history in document audits; no
  record on a no-op): `inventory.opening_recorded`, `inventory.received`, `inventory.receipt_reversed`,
  `inventory.adjusted`, `inventory.written_off`, `inventory.adjustment_reversed`,
  `inventory.low_stock_threshold_set` and `inventory.low_stock_threshold_cleared` (from and to thresholds as
  bounded integer strings). Four entity types added; no stocktake action or entity type.
- **Keyed plan/apply (D21):** a shared pipeline (`stock-document.ts`) runs permission, location-bound context,
  key and syntax checks outside the transaction; inside it, the acting membership, unit normalization, the
  canonical command and fingerprint, then `KeyedIdempotency.runBusinessScoped`. Its `plan` hook is synchronous and
  receives no transaction scope or repository, so a state read there does not compile; it only generates the
  document ID and builds the header snapshot (`occurredAt`, `businessDate`, status POSTED, `lineCount`). `apply()`
  then locks variants FOR SHARE, resolves packs, locks balances FOR UPDATE, decides, and writes header, movements,
  balances and audit. A rejection in `apply()` rolls back the claimed idempotency record with everything else, so
  a later retry with the same key runs fresh.
- **Location fingerprint:** the resolved `context.locationId` is part of the canonical command. The same key and
  command at a different location is `IDEMPOTENCY_KEY_REUSED`; a different correlation ID, device ID or source
  channel still replays.
- **Reversal semantics:** state-setting, not keyed. Header FOR UPDATE first; an already-REVERSED document is a
  no-op returning the current document with no movement and no audit (D22); otherwise variants FOR SHARE, balances
  FOR UPDATE, the decision, the column-level header update, reversal movements, balances and one audit record.
- **Threshold semantics:** variant FOR SHARE, then the threshold row FOR UPDATE or `insertIfAbsent`
  (`INSERT ... ON CONFLICT DO NOTHING RETURNING`); a concurrent creator that committed first makes the loser
  re-read and return `VERSION_CONFLICT`. No movement and no balance change. Results are
  `{ variantId, locationId, threshold?, version, changed }`.
- **Errors:** `InsufficientStockError` (`INSUFFICIENT_STOCK`, not retryable, no quantities in the message), mapped
  to 409 in the API error envelope filter (one new row in its exhaustive table).
- **Fakes:** `InMemoryInventoryStore` mirrors the database constraints the use cases depend on (ownership, unique
  movement IDs, one opening, one reversal per original, gap-free versions, balance equals movements) and has
  `assertConsistent()`; `createInventoryHarness` extends the catalog harness and logs port calls.

## Database (migration `20261006120000_build2_inventory_core`)

Six tables, all tenant-owned with `(business_id, id)` unique keys and `onDelete: Restrict, onUpdate: Restrict`:

| Table                        | Purpose                                             | `tali_app` privileges                                           |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `inventory_opening_batches`  | opening stock document header                       | SELECT, INSERT                                                  |
| `goods_receipts`             | receipt header, POSTED or REVERSED                  | SELECT, INSERT; UPDATE on the four reversal columns only        |
| `inventory_adjustments`      | adjustment or write-off header, POSTED or REVERSED  | SELECT, INSERT; UPDATE on the four reversal columns only        |
| `inventory_movements`        | append-only movement ledger (the document lines)    | SELECT, INSERT                                                  |
| `inventory_balances`         | per stock item projection, version-guarded          | SELECT, INSERT, UPDATE                                          |
| `inventory_stock_thresholds` | low-stock configuration, version-guarded            | SELECT, INSERT, UPDATE                                          |

- **Typed sources:** each movement references exactly one document through `opening_batch_id`,
  `goods_receipt_id` or `adjustment_id` (`inventory_movements_one_source` plus one equality CHECK per type).
- **Tenant-composite FKs** (31 in this migration, all listed in verify-schema): location, variant, actor
  membership, reversed-by membership, device, each document; the adjustment FK includes `type -> kind`, so an
  `ADJUSTMENT` movement cannot point at a `WRITE_OFF` document.
- **Pack FK:** `(business_id, pack_id, variant_id) -> product_packs (business_id, id, variant_id)`, so a pack is
  pinned to the movement's variant.
- **Reversal self FK:** `(business_id, reverses_movement_id, location_id, variant_id, type) -> (business_id, id,
  location_id, variant_id, type)`, plus `UNIQUE (business_id, reverses_movement_id)` (at most one reversal per
  movement) and `not_self_reversal`.
- **Balance last-movement FK:** `(business_id, location_id, variant_id, last_movement_id) ->` the same stock item's
  movement (D18).
- **Major CHECKs:** `type_valid` (four types), `delta_nonzero` and `balance_after_range` (within 10^15),
  `direction`, `pack_shape` and `pack_arithmetic` (computed in `NUMERIC`, casting before `abs`, so neither the
  absolute value nor the product can overflow `BIGINT`), `pack_reversal`, `reason_note_valid` and `reason_shape`;
  document `status_valid`, `reversed_shape`, `reason_valid`, `other_requires_note` and trimmed-length text rules;
  balance `version_non_negative`, `last_movement_shape` and `empty_is_zero` (no non-negative quantity CHECK: the
  stock rule is domain policy); threshold `threshold_range` (NULL or 0 to 10^15).
- **Unique and partial unique indexes:** one `OPENING` per stock item ever (`inventory_movements_one_opening`);
  one original line per document and variant (`opening_line_unique`, `receipt_line_unique`,
  `adjustment_line_unique`, reversals excluded); `(business_id, location_id, variant_id, balance_version)`; one
  threshold row per business, location and variant.
- **Column-level reversal grants:** UPDATE (`status`, `reversed_at`, `reversed_by_membership_id`,
  `reversal_reason`) on the two reversible headers, which also backs their `SELECT ... FOR UPDATE`. verify-schema
  gained `EXPECTED_APP_COLUMN_PRIVILEGES`, read through `aclexplode(pg_attribute.attacl)`: exactly these columns
  and no column ACL anywhere else.
- **No DELETE or TRUNCATE** on any of the six tables (tested, SQLSTATE 42501). `PROTECTED_TABLES` gained
  `inventory_movements` and `inventory_opening_batches`; `NO_DELETE_TABLES` gained the other four; the ESLint
  `PROTECTED_MODEL_DELEGATES` and `NO_DELETE_MODEL_DELEGATES` lists match.
- **No RLS, no triggers, no functions, no `CASCADE`.** No business rule lives in the database.
- `business_date` is the first `DATE` column in the schema; a repository test round-trips 2026-09-30T23:30Z in
  `Africa/Lagos` to 2026-10-01.
- verify-schema now reports 7 migrations, 24 table grant sets, 2 column grant sets, 158 CHECKs, 9 partial unique
  indexes, 12 unique indexes and 41 tenant foreign keys.

## Reader cutover

- The temporary `PreInventoryStateReader` (`apps/api/src/composition/pre-inventory-state-reader.ts`) and its gate
  test are **deleted**. It was truthful only while no inventory table existed; the Slice 3 and Slice 4 audits
  recorded the obligation to delete or replace it in Slice 5.
- The production reader is `packages/database/src/repositories/variant-inventory-state-reader.ts`, exposed as
  `DatabaseRepositories.variantInventoryState` and composed into `createUpdateProduct` in
  `apps/api/src/composition/api-services.ts`.
- One business-scoped statement across **all locations** of the business, with three `EXISTS` checks:
  `hasMovements` (any movement for the variant), `hasNonZeroBalance` (any balance with `quantity_minor <> 0`) and
  `hasConfiguredThreshold` (any threshold with `low_stock_threshold_minor IS NOT NULL`; a cleared row is ignored).
- Freshness: UpdateProduct reads it while holding the product and variant FOR UPDATE; stock and threshold writers
  hold the variant FOR SHARE until commit, so at read-committed every committed movement and threshold is visible.
- New gate test `apps/api/src/composition/inventory-state-reader.test.ts` (4 tests): no file or identifier named
  `PreInventoryStateReader`, `pre-inventory-state-reader` or `NO_INVENTORY_YET` remains in any app or package
  source; UpdateProduct is composed with the database reader exactly once; no app implements its own reader; the
  implementation lives in the database package and reads the three inventory tables.

## Catalog integration (W4)

`apps/api/test/integration/catalog-api.integration.test.ts` gained one `describe` block, "inventory guard through
the production reader (Slice 5)", with **exactly four tests** (the suite went from 27 to 31). Inventory state is
created through the real Slice 5 use cases over the API runtime's own database, with the context resolved the way
the API guards resolve it; nothing is mocked. A second ACTIVE, non-default location comes from a new owner-SQL
test fixture, `tenancyFixtures.insertLocation`, because no use case creates locations. Every test's `afterEach`
asserts the consistency query is empty.

1. **A movement blocks a stock-unit change:** after a goods receipt of 12, `PATCH` to `KG` is 409 `CONFLICT`; the
   product, movement and balance are unchanged.
2. **A threshold at a non-default location blocks a stock-unit change, and a cleared threshold permits it:** a
   threshold set at the second location makes the `PATCH` (default-location context) 409; after clearing it (row
   kept, NULL, version 2) the same `PATCH` is 200 and the threshold row is not converted. Both halves are one test.
3. **Stock at another location blocks turning tracking off:** after receiving 5 at the second location,
   `trackInventory: false` is 409 and tracking stays on.
4. **Tenant safety, a separate positive control:** business B records its own stock and threshold; business A's
   product with no inventory then changes unit (200). B's inventory and B's product are unchanged.

The W4 checkpoint report described the fourth test as "one extra case" in addition to the three required ones; it
is the fourth of the four new tests, not a fifth.

## Consistency

- `packages/database/src/inventory/consistency-query.ts`, read-only, reports per business, location and variant one
  of six kinds: `BALANCE_QUANTITY_MISMATCH` (quantity differs from the sum of deltas), `BALANCE_VERSION_MISMATCH`
  (version differs from the movement count), `VERSION_GAP`, `LAST_MOVEMENT_MISMATCH`, `RUNNING_BALANCE_MISMATCH`
  (a `balance_after_minor` differs from the running sum) and `MISSING_BALANCE`. Identifiers and kinds only, never
  quantities. Version-0 balances with no movements are consistent.
- Test helper `readInventoryConsistency()` in `@tali/database/testing`, asserted empty after every inventory
  database test and every W4 API test.
- Operator script `pnpm --filter @tali/database run db:inventory-consistency`: the app role (`DATABASE_URL`, least
  privilege) in one `BEGIN READ ONLY` transaction that is always rolled back; prints identifiers and kinds; exits 1
  on any mismatch; **never repairs**. Its test injects a balance mismatch as owner, expects exit 1 with the exact
  report and an unchanged snapshot, then restores; a missing or unreachable `DATABASE_URL` prints no credentials.

## Concurrency (`z-inventory-concurrency`, real PostgreSQL and `PrismaUnitOfWork`)

Forced interleavings first confirm the blocked backend through `pg_stat_activity` (`wait_event_type = 'Lock'`) and
the locks it holds through `pg_locks`, so no scenario can pass by timing alone.

- **Oversell and decrement races:** balance 10, two concurrent write-offs of 6: one succeeds, the other is
  `INSUFFICIENT_STOCK`, final 4. The same for adjustment against write-off and receipt reversal against write-off.
- **Opposite-order lines:** at repository level, a second locker of `{v1, v2}` waits for the holder of `{v2, v1}`
  and never deadlocks on a single-attempt unit of work; at use-case level, 20 concurrent receipt pairs with
  reversed line orders all succeed on a single attempt (a deadlock would surface instead of being retried).
- **Archive versus receipt:** a receipt waits for an archive holding the variant FOR UPDATE, then gets `CONFLICT`;
  an archive cannot take a variant held FOR SHARE by stock entry until it is released.
- **Initial threshold race:** two `expectedVersion = 0` sets: one creates version 1, the other is
  `VERSION_CONFLICT`; forced variant: the second creator blocks on `ON CONFLICT`, then gets `VERSION_CONFLICT`.
- **Reversal against reversal:** one reverses, the other is a no-op; one set of reversal movements, one audit.
- **Same-key opening (case A):** both calls succeed, exactly one replays; one batch, one movement per line, one
  audit and one idempotency record; neither returns `CONFLICT`.
- **Same-key write-off (case B):** balance 10, both send the same keyed write-off of 6; both succeed, one replays,
  final 4, one movement, one audit; the replay is never `INSUFFICIENT_STOCK`.
- **Forced interleaving for A and B:** request 1 is held inside `apply()` after `lockForUpdate`; request 2 is shown
  waiting on the idempotency key with no balance or variant lock granted; after release it replays, and
  `lockForUpdate` ran exactly once.
- **Rolled-back claim:** a write-off of 11 on a balance of 10 fails in `apply()` and leaves no idempotency record,
  document, movement or audit; after a receipt of 5 the identical keyed write-off runs fresh (`replayed: false`).
- **Extras:** a unit change racing a threshold set, in both commit orders (the later one is rejected); a lock
  timeout writes nothing.

## AI boundary (W5)

- New dependency-cruiser rule **`ai-no-catalog-inventory`** (`.dependency-cruiser.cjs`, severity `error`): from
  `^packages/ai/` and `^packages/application/src/modules/ai/` (neither exists yet), to `^packages/database/` and
  `^packages/application/src/modules/(catalog|inventory)/`, with **`reachable: true`**.
- Because `packages/application/src/index.ts` re-exports the catalog and inventory modules (use cases and repository
  ports), a direct-edge rule would have let `import { createPostGoodsReceipt } from "@tali/application"` through.
  Reachability catches any transitive path, so the root `@tali/application` (and `@tali/application/testing`) is
  unavailable to AI source. A future AI ADR would define a dedicated surface that does not reach these modules.
- Domain value objects (`@tali/domain`), `@tali/shared` (for `packages/ai`, as `ai-direction` already allows) and
  application modules that do not reach catalog or inventory stay allowed. No proposal contract was added.
- Test files are excluded (`pathNot: TEST_FILE`), the production-boundary convention of the other rules; a positive
  self-test case documents it.
- Self-test (`tooling/dependency-cruiser/application-boundary-self-test.mjs`): a fixture application whose root
  index re-exports fixture catalog and inventory modules like the real one; 13 negative cases (`@tali/database`,
  direct database source, the application root by alias and by relative path, catalog and inventory modules and
  use cases, and type imports of `ProductRepository`, `ProductPackRepository`, `InventoryMovementRepository` and
  `StockBalanceRepository`) and 5 positive cases; every case must resolve its import. With `reachable: true`
  removed, exactly the two root-import cases went unreported; restored, they fail as required.
- No existing rule was disabled, narrowed or given new exclusions; the real scan found no AI source to flag.

## Tests

| Suite                                   | Result                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| domain unit                             | 22 files, 382 passed (Slice 4: 16 files, 223)                                   |
| application unit                        | 33 files, 514 passed (Slice 4: 26 files, 416)                                   |
| shared unit                             | 5 files, 43 passed (unchanged)                                                  |
| API unit and compat                     | 6 files, 60 passed (Slice 4: 59; the new reader gate's 4 replace the old reader's 4; the error filter gains the `INSUFFICIENT_STOCK` row) |
| database unit                           | 3 files, 19 passed                                                              |
| web (Vitest)                            | 15 files, 198 passed (unchanged)                                                |
| mobile (jest-expo)                      | 22 suites, 370 passed (unchanged)                                               |
| worker unit, integrations, config, text-integrity, client-bundle-check | 11, 109, 37, 12 and 8 passed                     |
| database inventory integration (focused) | 7 files, 114 passed: constraints 27, repositories 12, use cases 14, concurrency 16, consistency script 2, migration chain 13, catalog repositories 30 |
| API focused                             | catalog API 31 passed (4 new); inventory-state-reader 4; error filter 29; route guards 13 |
| database integration (full)             | 27 files, 364 passed (Slice 4: 22 files, 289)                                   |
| API integration (full)                  | 9 files, 128 passed, 1 skipped (Slice 4: 124 passed, 1 skipped)                 |
| worker integration                      | 9 passed, 1 skipped (unchanged)                                                 |
| boundary self-test                      | 26 cases (8 application, 18 AI) plus the manifest policy                        |

The skipped tests are the existing SIGTERM tests that skip on Windows.

## Verification

| Check                                                                                                          | Result |
| -------------------------------------------------------------------------------------------------------------- | ------ |
| `prisma format`, `prisma validate`, `prisma generate` (sequential)                                             | exit 0 (schemas valid; client generated) |
| Recreated test container; `db:migrate:deploy`, `db:migrate:status`, `db:drift`, `db:verify-schema`, `db:inventory-consistency` | 7 migrations applied; up to date; drift ok both ways; verification passed; consistency passed |
| Focused domain, application, database inventory, API and boundary set                                          | all passed (counts above) |
| `pnpm verify` (text integrity, format, build, lint, typecheck, boundaries, all unit tests)                     | exit 0 (18 of 18 tasks; one failed run below) |
| `pnpm test:integration` (alone, after verify, port 57433 overrides)                                            | exit 0 on the first run (12 of 12 tasks; database 364, API 128 + 1 skipped, worker 9 + 1 skipped) |
| Post-integration `db:migrate:status`, `db:drift`, `db:verify-schema`, `db:inventory-consistency`               | up to date; drift ok both ways; verification passed; consistency passed |
| `pnpm boundaries`                                                                                              | self-test pass; no violations (626 modules, 3034 dependencies) |
| gitleaks v8.30.1 (Docker): history; directory scan of the complete Slice 5 change set; temporary clone with it committed | no leaks (98 changed files: 57 new, 39 modified, 2 deleted; audit and Plan 004 included; rescanned after the final audit edit) |

After the integration suites' teardown the inventory tables are empty, so the post-integration consistency pass
proves no drift or inconsistent residue was left behind; the data-level evidence is the consistency assertion after
every inventory database test and every W4 API test.

The local test container is published on `127.0.0.1:57433` through the existing `TALI_POSTGRES_TEST_PORT`
override, with the existing `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`, `MIGRATION_DATABASE_URL`,
`SHADOW_DATABASE_URL` and `DATABASE_URL` overrides (local-only credentials from `.env.example` and CI). No
repository file was changed for the port.

### Failed and retried runs

Every failed run that materially occurred during W1 to W6:

- **W1, domain lint, first run: 21 errors** (non-null assertions in the new tests, one rule hit each in
  `low-stock.ts` and `movement.ts`). Fixed in code; nothing suppressed. During test writing a property-style
  low-stock test was found to draw only 31-bit values, so it always produced a negative on-hand; it was fixed to
  combine two draws before the gate.
- **W1 and W2, red by design (D23):** `pre-inventory-state-reader.test.ts` failed once an inventory module existed;
  it was reported by name at each checkpoint, not run as a gate, never edited, and deleted in W3c with the reader.
  At W2, the database typecheck failed only on the two catalog adapter methods W3b adds (`lockVariantsForShare`,
  `findForEntry`); it passed from W3b on.
- **W2, application lint: one error** (an `expect.objectContaining` value typed `any`), fixed. Prettier reformatted
  12 new W2 files.
- **W3, repository test design:** a NOWAIT probe against a freshly inserted, uncommitted balance row did not block,
  because an uncommitted row is invisible to another transaction (correct PostgreSQL behaviour). The test was split
  into "a concurrent first lock waits" and "an existing row is held FOR UPDATE"; no production code changed.
- **W3, use-case test authoring:** wrong reason codes in the test (`FOUND` and `LOST` instead of `FOUND_STOCK` and
  `THEFT_OR_LOSS`) and a wrong audit-writer method name; and unhandled rejections from promise arrays started
  before being awaited, changed to thunks run in order. Test code only.
- **W3, typecheck and lint:** `noPropertyAccessFromIndexSignature` errors in the constraints test (bracket access),
  an `undefined` union in permuted test lines, `no-useless-assignment` in the consistency script, an unused
  destructured binding and a void-returning arrow. All fixed in code. Prettier reformatted 4 W3 files.
- **W4:** no failed run.
- **W5, format check: one failure** on the self-test file, formatted. The deliberate mutation run with
  `reachable: true` removed failed exactly the two root-import cases, as intended, before the rule was restored.
- **W6, `pnpm verify`, first run: web Vitest workers did not start (no assertion failed).** Only `@tali/web#test`
  failed: 7 of its 15 files reported `[vitest-pool]: Failed to start forks worker ... Caused by: Error:
  [vitest-pool-runner]: Timeout waiting for worker to respond`; the 8 files that started passed (79 of 79). The
  web run took 133 s with 73% spent in environment setup while turbo ran the web, mobile, application and
  integrations suites in parallel on 8 logical CPUs and 16 GB; mobile Jest was still passing suites when turbo
  stopped it after the web failure (16 of 18 tasks successful). No web source, test or configuration file is in the
  Slice 5 change set. This is the host-saturation worker-startup failure recorded in the Slice 3 and Slice 4 audits.
  The **unchanged retry exited 0** (18 of 18; web 15 files, 198 passed, environment setup 34% of 53 s; mobile 22
  suites, 370 passed). No configuration or timeout was changed.

## Deviations and interpretations

- **Database-generated timestamps** for balances (`updated_at`) and thresholds (`created_at`, `updated_at`), using
  `statement_timestamp()`; threshold updates use `GREATEST(created_at, statement_timestamp())` so
  `updated_after_created` always holds. The domain models do not carry these timestamps.
- **Extra recording CHECKs** beyond the plan on `inventory_movements`: `source_channel_valid`,
  `correlation_id_format` and `recorded_after_occurred`, the same rules the plan gave the three document headers.
- **`setInventoryState` test helper** on `InMemoryCatalogStore` accepts a partial state (unspecified facts stay
  false).
- **Node 24 type stripping:** the operator script imports the TypeScript consistency query directly, so the script
  and the test helper share one SQL definition; no warning is printed and no build step is needed.
- **D23 scoped checkpoints:** W1 and W2 gates were package-scoped and never claimed repository-wide green (see
  failed runs).
- **COUNT_CORRECTION deferred to Slice 6** (D1 Option A), with the obligations listed below.
- **Domain enforces 1 to 200 lines per document** in addition to the application syntax check; `common.ts` holds
  the shared note, reason, recording and reversal-state helpers (one file beyond the plan's list).
- **Classification choices:** a malformed ID is `NOT_FOUND` like a foreign one; a retired pack is `CONFLICT`;
  another product's or business's pack is `NOT_FOUND`; a unit mismatch is `VALIDATION_FAILED` at `lines[i].unit`.
- **W4 test fixture** `tenancyFixtures.insertLocation` (owner SQL, beside the existing `archiveLocation`), because
  no use case creates a second location and the API package cannot import `pg`.

## Risk

- **Tenancy.** Every repository method takes `businessId`; every FK is tenant-composite, so a cross-tenant
  location, variant, pack, document, membership, device or reversal target is rejected by the database. Use cases
  resolve the business and location server-side and answer other businesses' records with `NOT_FOUND`. The
  database cross-tenant matrix, repository-level threshold read isolation and the W4 business B control all pass.
- **Inventory integrity.** Movements are append-only (no UPDATE or DELETE grant), every change is a canonical
  movement with a `location_id`, balances are a version-guarded projection updated only under the locks the
  repository API makes unavoidable, corrections are reversals referencing the original, and the consistency query
  stays empty after every test. Quantities are `bigint` minor units; `NUMERIC` only in the pack CHECK; no float.
- **Permissions.** Checked before the idempotency lookup and the acting membership re-read inside the transaction;
  CASHIER and ACCOUNTANT are denied every mutation, STOCK_KEEPER is denied opening and adjust.
- **Idempotency.** Keyed documents claim the key before any stock lock; concurrent duplicates replay instead of
  deciding against post-commit state; a rejected `apply()` leaves no record; the location is fingerprinted.
- **Audit.** One record per effective mutation in the same transaction, none for no-ops; payloads are bounded
  summaries, so audit review needs the movements for per-line evidence (Plan 004 risk).
- **Concurrency.** Global lock order: document header, variants FOR SHARE, balances FOR UPDATE, threshold row; tested
  without retries for deadlocks. Catalog edits take the variant FOR UPDATE and so serialize with stock changes.
- **AI boundary.** Enforced transitively; there is no AI code yet. A future AI surface needs its own ADR.
- **Residual and future work.** No route exposes inventory yet, so nothing is reachable over HTTP except through the
  catalog guard. `INSUFFICIENT_STOCK` has no details payload. The negative-stock rule is fixed (no per-business
  policy yet). Thresholds are per location with no copying. Opening stock is not reversible; corrections use
  adjustments.

## Slice 6 obligations

Slice 6 must add, in a new forward-only migration and its own PR:

- `stocktakes` and `stocktake_lines` (with the one-DRAFT-per-location partial unique);
- the `COUNT_CORRECTION` movement type;
- the `stocktake_id` movement source column and the typed stocktake-line FK
  `(business_id, stocktake_id, variant_id) -> stocktake_lines`;
- the extended movement constraints: `inventory_movements_type_valid`, `_one_source` and `_direction` (and any
  other movement CHECK whose type list must admit the new type, such as `_reason_shape`) dropped and re-added by
  name without `CASCADE`, plus a count-correction source CHECK and its not-reversible rule, all mirrored in
  `verify-schema.mjs`;
- the inventory HTTP API (balances with the derived `lowStock` flag and filter, movement history, documents,
  opening, receipts, adjustments, write-offs, reversals and stocktakes);
- the threshold HTTP API (set and clear under `inventory:threshold`);
- balance and movement read use cases;
- the stocktake actions and the `stocktake` audit entity type.

None of these is started.
