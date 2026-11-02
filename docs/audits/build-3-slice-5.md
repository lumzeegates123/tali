# Build 3 Slice 5 audit — sales persistence and SALE inventory/ledger integration

Date: 2026-11-01
Branch: `feature/build-3-slice-5-sales-persistence`
Baseline: `6a1907bbd09eb8316345a855775ae9d1dbd43bbf` (S0–S4 merged; S4 is PR #25)
Status: **COMPLETE (2026-11-01)**. All final gates passed. Uncommitted for review.

## S3/S4 handoff

S3 left valuation facts, journals and the ledger checker in place. S4 left the sale aggregate, the
pure stock and posting planners, `RecordSale`, `ReverseSale`, the reads and in-memory adapters. In
S4 the PostgreSQL journal repository rejected `source.kind = "sale"`, and `SALE` was not a persisted
movement type. S5 adds the typed sale source, persists the sale, and applies the S4 plans without
recomputing them.

## Migration

`20261101120000_build3_sales_persistence`. This is one forward-only file with its own
`BEGIN`/`COMMIT`, because Prisma 7.10 does not wrap a migration file in a transaction. The
migration is additive:

- It adds two typed source columns, `inventory_movements.sale_id` and `journal_entries.sale_id`.
- It adds four tables: `sales`, `sale_lines`, `sale_tenders` and `sale_receipt_sequences`.
- It replaces the movement CHECKs that enumerate types or sources (`type_valid`, `one_source`,
  `direction`, `reason_shape`) and the journal `one_source` CHECK, each re-added with the sale
  included.

It rewrites no existing row and needs no backfill: no sale existed before it, and receipt counters
are created lazily. It contains no trigger, function, RLS policy, `DELETE`, `TRUNCATE` or
`PUBLIC` grant.

## Sales schema

- `sales` holds the header. The receipt number is unique per business. Currency, location,
  recording membership and device are composite FKs with `business_id`. The totals and
  `cost_status`/`cogs_total_minor` are snapshots. `journal_entry_id` is NOT NULL. Five reversal
  columns are NULL while the sale is `POSTED` and all set when it is `REVERSED` (the
  `reversal_shape` CHECK).
- `sale_lines` holds immutable per-line snapshots: product name, SKU, tracked flag, quantity, unit
  and scale, unit price and price version, gross, discount kind/value/amount, net, tax snapshot
  (NONE under the NO_TAX resolver), taxable base, tax, total, cost status and cost, the valuation
  version read, and the SALE movement id for tracked lines.
- `sale_tenders` holds the method, amount, optional reference, verification status, and the cash
  received and change given for cash.
- CHECKs cover shapes and ranges only. Totals, line arithmetic, tender sums and cost status are the
  domain's job and are verified by `db:sales-consistency`, not by the database.

## Grants

The application role `tali_app` gets:

| Table | Privileges |
| --- | --- |
| `sales` | `SELECT`, `INSERT`, and `UPDATE` on `status` plus the five reversal columns only |
| `sale_lines`, `sale_tenders` | `SELECT`, `INSERT` |
| `sale_receipt_sequences` | `SELECT`, `INSERT`, `UPDATE (next_number, updated_at)` |

No table grants `DELETE`, `TRUNCATE` or anything to `PUBLIC`. The constraint tests check these
grants exactly through `information_schema`, plus live allowed and denied (`42501`) probes as
`tali_app`.

## Receipt sequence

`sale_receipt_sequences` has one row per business holding `next_number`. The issuer runs `INSERT
... ON CONFLICT DO NOTHING` (a concurrent first insert waits for the creating transaction, then
does nothing), then `SELECT ... FOR UPDATE`, then a guarded `UPDATE ... WHERE next_number = read`.
It formats the number as `S-000001`.

`RecordSale` calls the issuer after every stock lock, so the counter is always the last lock a sale
takes. A rolled-back sale rolls its counter update back with it, so a failed sale leaves no gap.
A replay does not issue a number.

## sale_id journal source

`journal_entries.sale_id` is the sixth typed source in `journal_entries_one_source`. Its tenant FK
is `(business_id, sale_id, location_id)` to `sales`. The CHECK `journal_entries_sale_location`
requires a location for a sale source. The partial unique index `journal_entries_original_sale_key`
allows one ORIGINAL per sale. The PostgreSQL `JournalRepository` writes and reads `sale_id`, finds
the original by source, and maps a duplicate original to a conflict. The posting rule stays
`SALE_POSTED` v1.

## SALE inventory source and type

`SALE` joins the persisted movement types with `inventory_movements.sale_id` as its typed source:

- An original is negative and a reversal is positive (`direction`).
- A SALE movement carries no pack snapshot (`sale_no_pack`).
- An original has no reason. A reversal carries the sale reversal reason as a note
  (`reason_shape`).
- The source FK is `(business_id, sale_id, location_id)` to `sales`.

In the domain, `planStockChange` refuses `SALE` (sales are planned by `planSaleStock`), and
`reverseDocumentMovements` refuses a SALE original (a sale is reversed by reversing the sale). The
inventory HTTP mapper throws on a SALE movement, because SALE is not yet part of the inventory HTTP
contract (see risks).

## SaleRepository

`createSaleRepository`:

- `insert` writes the header, lines and tenders once. A duplicate id or receipt number is a
  `ConflictError`.
- `findById` and `findByIdForUpdate` are keyed by `(business_id, id)`, and the lock is
  `FOR UPDATE`.
- `list` uses keyset paging by id inside one location, with an optional `recordedBy` filter.
- `markReversed` updates only the status and reversal columns, guarded by `status = 'POSTED'`; any
  other row count is a `ConflictError`.

The repository does not calculate anything.

Restoration rebuilds every sale through the domain constructors. It compares every stored total,
status and snapshot with the rebuilt aggregate, and rebuilds each tracked line's stock effect from
its SALE movement and valuation fact. Any mismatch fails closed with `stored sale <id> is
inconsistent: ...` and no sale is returned. The repository tests prove this for tampered header
totals, line amounts, costs, tender amounts, movement quantities, valuation facts and the COGS
total.

## Receipt issuer

`createSaleReceiptNumberIssuer`, described above. Tests cover lazy creation, per-business numbering,
rollback, no increment on replay, and a failed sale leaving the counter unchanged.

## SalesInventoryPort PostgreSQL adapter

`createSalesInventoryPort`:

- `lockForSale` reuses the balance and valuation repositories: balances `FOR UPDATE` in ascending
  variant id (created at version 0 when absent), then valuations `FOR UPDATE` in the same order
  (created UNVALUED when absent).
- `applySalePlan` and `applyReversalPlan` write the planned movements and facts, then move each
  balance and valuation from the version the plan read to the version it planned.
- Any other stored version is a `ConcurrentModificationError`.

The adapter keeps no lock state and computes no quantity, cost or status.

## S4 port and application adjustments required for persistence

- `SaleRepository.attachOriginalJournal` is removed, and `insert` takes a sale that already carries
  its journal id. An immutable snapshot is never updated.
- `SalesInventoryPort.applySalePlan` and `applyReversalPlan` now take one write object
  (`SaleStockWrite`, `SaleStockReversalWrite`). It carries the sale id, the journal id, the
  recording envelope, and, for a reversal, the reason and pre-generated movement ids. These are
  exported from `@tali/application`.
- `RecordSale` order: validate, lock, plan; issue the receipt last; insert the sale; post the
  original journal; then apply the stock plan with the journal id; then audit.
- `ReverseSale` order: idempotency; membership; the sale `FOR UPDATE`; variant share locks; balance
  and valuation locks; plan from the snapshotted effects; post the REVERSAL journal; apply the
  reversal movements and facts; `markReversed`; audit.
- `journalSourceOf("SALE")` maps to the sale source. `postingRuleFor("SALE")` throws, because sale
  value is posted by `SALE_POSTED`, not by an inventory valuation rule.
- The receipt-issuer port comment now states that a rollback rolls the counter back.

## Journal pre-generated-ID design

`RecordSale` generates the original journal id before inserting the sale. The sale header is
written with it, and the journal follows in the same transaction. `sales_original_journal_fkey`
`(business_id, journal_entry_id, id)` to `journal_entries (business_id, id, sale_id)` is
`DEFERRABLE INITIALLY DEFERRED`, so it is checked at commit. The reversal journal is posted before
`markReversed`, so `sales_reversal_journal_fkey` is immediate.

## Line/movement deferred relationship

A tracked line is inserted before its SALE movement. `sale_lines_movement_fkey`
`(business_id, movement_id, sale_id, variant_id)` to `inventory_movements` is the only other
deferred FK. It also proves that the movement belongs to the same sale and variant. Every FK that
points back at the sale is immediate. The migration-safety test asserts that exactly these two FKs
are deferrable.

## Original sale persistence

One transaction writes:

- the sale header, lines and tenders
- one ORIGINAL `SALE_POSTED` journal
- for each tracked line, one SALE movement, its valuation fact, and the balance and valuation
  updates
- the counter update and the `sale.recorded` audit record

A repeated variant gets one movement per line, chained by consecutive balance and valuation
versions.

## Reversal persistence

One transaction writes:

- the REVERSAL journal mirroring the original
- one positive SALE reversal movement per original movement (`reverses_movement_id`), each with a
  new id the application generated
- the reversal valuation facts and projection updates
- the header's `REVERSED` fields and the `sale.reversed` audit record

A second reversal with a new key is a `CONFLICT` and writes nothing.

## WAC fact mapping

| Line | Original fact | Reversal fact |
| --- | --- | --- |
| VALUED | `WEIGHTED_AVERAGE`, `-cost`, original journal | `REVERSAL_OF_ORIGINAL`, `+cost` (the snapshotted cost, not current WAC), REVERSAL journal |
| UNVALUED | `NOT_VALUED`, 0, no journal | `NOT_VALUED`, 0, no journal |

Untracked lines have no movement and no fact. There is no sale residual policy: the reversal
restores positive quantity and non-negative value, and the planner throws otherwise.

## Consistency scripts

`db:sales-consistency` (`scripts/check-sales-consistency.mjs`) runs as the application role in one
`READ ONLY` transaction that is always rolled back. It prints identifiers and kinds only, and exits
0 when clean and 1 otherwise. Its kinds:

- Status and totals: `SALE_STATUS_INVALID`, `SALE_TOTALS_MISMATCH`, `SALE_COST_STATUS_MISMATCH`,
  `SALE_COGS_TOTAL_MISMATCH`
- Numbering and tenders: `SALE_LINE_NUMBER_GAP`, `SALE_TENDER_NUMBER_GAP`,
  `SALE_TENDER_TOTAL_MISMATCH`
- Journals: `SALE_ORIGINAL_JOURNAL_MISSING`, `SALE_ORIGINAL_JOURNAL_MISMATCH`,
  `SALE_REVERSAL_JOURNAL_MISSING`, `SALE_REVERSAL_JOURNAL_MISMATCH`, `SALE_POSTING_MISMATCH`
- Original stock effects: `SALE_MOVEMENT_MISSING`, `SALE_MOVEMENT_MISMATCH`,
  `SALE_VALUATION_MISSING`, `SALE_VALUATION_MISMATCH`
- Reversal stock effects: `SALE_REVERSAL_MOVEMENT_UNEXPECTED`, `SALE_REVERSAL_MOVEMENT_MISSING`,
  `SALE_REVERSAL_MOVEMENT_MISMATCH`, `SALE_REVERSAL_VALUATION_MISMATCH`

`db:ledger-consistency` now counts `sale_id` as a source. It checks the sale's tenant, compares the
sale source between a reversal and its original, and adds `SALE_ORIGINAL_JOURNAL_MISSING`,
`SALE_ORIGINAL_JOURNAL_MISMATCH`, `SALE_REVERSAL_JOURNAL_MISSING` and
`SALE_REVERSAL_JOURNAL_MISMATCH`. `db:inventory-consistency` needed no change. It covers SALE
movements through the generic quantity and value chain rules.

## Migration safety

`zr-sales-migration-safety` starts from the S4 schema in the shadow database with two seeded
businesses. It runs the migration with an injected failure before section F. The deploy is not
recorded, and the schema fingerprint and data hash are unchanged. It then applies the real
migration: data is unchanged, the sales tables are empty, no row has a `sale_id`, and status is up
to date. A static scan rejects `TRUNCATE`, `DROP` of tables, columns or indexes, renames, copies,
data DML, cascades, triggers, functions, RLS, `DELETE`/`TRUNCATE`/`ALL` grants and `PUBLIC`.

## Concurrency

`zv-sales-concurrency` uses single-attempt units of work, with gates and `pg_locks` evidence:

- Same stock (10 on hand, two sales of 7): one sells and the other is `INSUFFICIENT_STOCK`. In the
  forced order, the waiter is blocked on `inventory_balances` while holding neither
  `inventory_valuations` nor `sale_receipt_sequences`. Neither does the paused holder. If the
  receipt lock were taken before the stock locks, this test would fail.
- Different stock: the second sale takes its own balance and valuation locks, then waits on
  `sale_receipt_sequences`. Numbers follow commit order. A free race of 8 sales gets 8 consecutive
  distinct receipts.
- Sale versus stocktake post, both orders: if the sale goes first, the post is `STOCKTAKE_STALE`. If
  the post goes first, the sale waits and then sells from the corrected balance.
- Reversal versus goods receipt, both orders: both apply. The waiting reversal holds only `sales`.
  Reversal versus reversal: one reverses.
- Overlapping multi-line sales in opposite line orders plus reversals, 15 rounds: no deadlock and
  no negative stock.
- The concurrent same-key sale race is in `zu`: one record and one replay.

## Soak

`zg-inventory-concurrency-soak` adds sales and reversals racing the same stock:

- sale versus sale, and sale versus write-off
- opposite-order multi-line sales with a sale reversal and a goods receipt
- reversal versus reversal

After every iteration the soak asserts movement and audit counts, duplicate-free movement
identities (now including `sale_id`), balance-equals-movements, no negative stock, and clean
inventory, ledger and sales checks.

## Tenancy

Every sale table is business-owned with a composite tenant FK. `TENANCY_TABLES` lists
`sale_tenders`, `sale_lines`, `sale_receipt_sequences` and `sales` for fixture truncation. Tests
cover:

- cross-tenant find, lock, list and reverse return not found
- another location returns not found
- foreign-business movement, journal, membership and journal-link FKs are rejected
- receipt numbers are per business

## Tests

| File | Coverage |
| --- | --- |
| `zr-sales-migration-safety` | Injected failure, then success |
| `zs-sales-constraints` | Every CHECK, FK and unique index by SQLSTATE and name; deferred FKs at commit; grants |
| `zt-sale-repositories` | Exact restoration, scoping and paging, conflicts, receipt issuer, fail-closed tampering |
| `zu-sales-use-cases` | See below |
| `zv-sales-concurrency` | Concurrency, above |
| `zw-sales-consistency-script` | Script output and failure modes; sales, ledger and inventory broken fixtures |

`zu-sales-use-cases` runs `RecordSale` and `ReverseSale` end to end through the tenancy harness,
with the NO_TAX resolver and no HTTP. It covers:

- valued, unvalued, untracked, discounted and duplicate-variant sales (3 valued at 100 sold as 2
  then 1 cost 67 then 33)
- insufficient stock
- receipts
- replay, `IDEMPOTENCY_KEY_REUSED`, and the same-key race
- read scope by role: OWNER, MANAGER and ACCOUNTANT read everything with cost; a CASHIER reads only
  their own sales without cost; another location or business is not found; STOCK_KEEPER is denied
- valued, unvalued and archived-product reversal, plus reversal idempotency and `CONFLICT`

Every `zu` test ends with all three consistency checks clean.

Existing-test updates:

- `w` and `za` use `RETURN` as the unknown movement type and add `sale_id` to the probe grid.
- `zm` now proves the sale source (it previously asserted rejection).
- `e` lists the new migration and tables.
- The inventory snapshot exposes `saleId`.

## No API

There are no sales controllers, routes, shared Zod contracts, REST mappers or UI. The only API
change is the inventory movement mapper refusing SALE movements.

## No S8

There are no tax tables, rates or configuration. Lines snapshot `NONE` from the NO_TAX resolver.
There is no credit, receivable, partial payment, refund, `CUSTOMER_RETURN`, pack selling or price
override. No dependency was added.

## Gates

Focused:

- `@tali/domain` test: 27 files, 513 tests.
- `@tali/application` test: 45 files, 704 tests.
- `@tali/database` test: 3 files, 19 tests.
- `@tali/database` test:integration: 50 files, 681 tests.

Database (test database; credentials not printed):

- `db:migrate:status`: 12 migrations, up to date.
- `db:drift`: no drift against the Prisma schema or the target database.
- `db:verify-schema`: passed (36 table grant sets, 7 column grant sets, 261 CHECKs, 98 tenant FKs).
- `db:ledger-consistency`, `db:inventory-consistency` and `db:sales-consistency`: each exits 0.

Workspace:

- `pnpm verify`: exit 0; 18 of 18 test tasks pass.
- `pnpm test:integration`: exit 0; 12 of 12 tasks. Database 50 files and 681 tests; API 182
  passed, 1 skipped; worker 9 passed, 1 skipped (the SIGTERM test is Linux-only).
- `pnpm boundaries`: no violations.
- `pnpm text-integrity`: 875 files, UTF-8 without BOM.
- `git diff --check`: clean.

Issues found by the gates and fixed in S5 code:

- `pnpm boundaries` rejected the inventory movement's import of `sales/ids.ts`. The index import
  would have formed a sales–inventory cycle, so the movement now names the sale id as the kernel's
  `Id<"Sale">`, the same type.
- Prettier formatting was applied to nine S5 files.
- One unnecessary optional chain in the soak was removed.

Two `pnpm verify` runs failed outside S5 code, with no S5 change under `apps/web` or `apps/mobile`:

- Web Vitest workers could not start (`Timeout waiting for worker to respond`) with about 2.7 GB of
  16 GB RAM free. The web suite then passed alone (19 files, 296 tests).
- One mobile Jest test hit its 30-second limit while web tests ran in parallel. Mobile passed in the
  next run (25 suites, 450 tests).

The final `pnpm verify` exited 0. No timeout, pool, file-parallelism or Turbo-concurrency setting
was changed. No process was terminated, and `postgres-test` did not need to be recreated.

## Risks and limitations

- The inventory HTTP movement mapper throws on a SALE movement. No API records sales yet, so SALE
  movements cannot appear through HTTP today. S6 must add SALE to the inventory movement contract
  before (or with) the sales API, or item movement history will fail once sales exist.
- Totals, tender sums and line arithmetic are not CHECKs. They are enforced by the domain on write,
  by restoration on read (fail closed), and by `db:sales-consistency`.
- A reversal holds the sale row lock while it waits for stock locks. This is the accepted ADR order
  (sale before stock), and no deadlock was observed in the forced, free or soak runs.
- `db:inventory-consistency` checks SALE movements generically and does not know about sales. The
  sale-specific links are in `db:sales-consistency`.
