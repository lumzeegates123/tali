# Build 3 Slice 3 audit — valuation, cost foundation and journal persistence

Date: 2026-10-18 (amended 2026-10-30)
Branch: `feature/build-3-slice-3-valuation-journal`
Baseline: `da6bb6f3e2793953ab9064f430c65fa5dde28c66` (S2)
Status: **COMPLETE**

## Questionnaire (applied)

- Cutover A: lazy `inventory_valuations` row; immutable `started_from_balance_version` is the locked
  balance version at first post-S3 mutation. Later movements with `balance_version > started_from` require a
  fact row. Untouched items need no row (logical UNVALUED, value 0).
- Reversal: **strict exact journal mirror** (ADR-009 §§12, 26). Residual INVENTORY / GAIN / SHRINKAGE lines are
  never added to the `REVERSAL` journal. `LedgerPostingService` rejects extra lines.
- Residual policy (accountant choice C, 2026-10-29; ADR-009 §§20.4, 26.1, 38): after the exact reversal, a
  **separate** `REVERSAL_RESIDUAL` stock valuation and `ORIGINAL` journal restore a valid projection when the
  raw result would be negative (Case B: Dr `INVENTORY` / Cr `INVENTORY_GAIN` to zero) or a `VALUED` item would
  remain at quantity zero with leftover value (Case C: Dr `INVENTORY_SHRINKAGE` / Cr `INVENTORY` to zero).
  Residual documents are domain-generated only (`trigger_movement_id` required). No residual is written when
  the raw result is already valid, including zero quantity with zero value and legacy `NOT_VALUED` reversals.
- Intermediate movement fact: `value_after_minor` may be negative only for `REVERSAL_OF_ORIGINAL` when a matching
  residual is created in the same transaction. The current `inventory_valuations.value_minor` projection is
  always `>= 0` after commit.
- Legacy reversal: Build 2 movements with no valuation fact, `NOT_VALUED`, or zero delta reverse as
  `NOT_VALUED` (delta 0, no journal). If the projection is currently `VALUED`, it becomes `UNVALUED` and
  recorded value is unchanged (non-authoritative until an operational valuation). Becoming `UNVALUED` does
  not create a residual.

## Scope delivered

- `journal_entries` / `journal_lines` with valuation-slice typed source columns only (no `sale_id`; PostgreSQL
  repository rejects `sale` until S5).
- Cyclic `valuation_id` ↔ `journal_entry_id` FKs are `DEFERRABLE INITIALLY DEFERRED`; both UUIDs are generated
  before insert. Append-only: no UPDATE of those columns. Behavioral integration test proves commit without
  id UPDATE, and that an unresolved pair fails at commit.
- `inventory_valuations`, `inventory_movement_valuations`, `stock_valuations` with `trigger_movement_id` (S3
  amendment migration `20261030120000_build3_reversal_residual`; the first S3 migration was not rewritten).
- Perpetual WAC in total-value form (`allocateProportionalMinor`, HALF_EVEN, last-unit exactness).
- Optional line `totalCost` on opening stock and goods receipts only; `inventory:value` required
  (STOCK_KEEPER denied). Write-offs keep costless line wire.
- Valued adjustments, write-offs, stocktakes and exact reversals, including Case B/C residual ORIGINAL journals
  in the same source reversal transaction.
- `RecordStockValuation` (`POST .../inventory/valuations`): server-side INITIAL_OPENING vs OPERATIONAL;
  operational postings never use `OPENING_BALANCE_EQUITY`; zero difference writes the document and audit, no
  journal. Idempotency stores `{valuationId}` only; kind is re-read from `stock_valuations`.
  `REVERSAL_RESIDUAL` is never accepted from that input.
- Permission `inventory:value` (OWNER/MANAGER), `inventory:cost-read` (OWNER/MANAGER/ACCOUNTANT), audit
  `inventory.valuation_recorded` (payload schema v2; residual audit is a separate record from the document
  reversal audit).
- `journal_entry_id` is set on a movement valuation only when that fact's `value_delta_minor` is non-zero.
- Ledger consistency: S2 chart kinds plus ADR-009 §30 journal kinds (empty/unbalanced, currency, source
  shape/tenant, duplicate ORIGINAL, reversal target/uniqueness/mirror, orphan line) and residual ORIGINAL
  journal kind/source/posting-rule checks (`RESIDUAL_JOURNAL_INVALID`).
- Inventory consistency: quantity ledger plus projection shape, currency, INVENTORY = SUM(value_minor),
  post-cutover fact coverage, value chain, NOT_VALUED delta 0, journal linkage, VALUED zero-qty value 0,
  residual pairing (trigger, duplicate, unneeded, missing, amount, journal, unpaired negative `value_after`).
- Database constraints: residual trigger shape, one residual per trigger, composite tenant FK to the
  inventory movement, previous-value shape for Case B negatives, movement `value_after` shape.
- Migration safety for the residual amendment (injected failure leaves first S3 state intact; successful
  apply is additive with no residual backfill).
- Concurrency: valuation races A–E plus concurrent reverse of the same receipt (one reversal effect, at most
  one residual).

## Cutover A detection limitation

Writers that lock/create the projection are covered: `balance_version > started_from_balance_version`
requires a fact. A movement writer that **skips creating `inventory_valuations` entirely** cannot be
distinguished from an untouched Build 2 item without a new marker. No timestamp, migration date, or
backfill marker was added. Current inventory mutation writers that call `movements.insertMany` are the
valuation-aware paths (`stock-document`, `reversals`, `stocktakes`). Carry this remaining limitation to S9
hardening if a bypassing writer appears.

## Out of scope (unchanged)

Sales, `sale_id`, SALE movements, tax, purchasing, S4/S5. No silent backfill of Build 2 history.

## Risk

Touches money, inventory valuation, tenant-scoped journals and append-only financial records. Cross-tenant
lookups remain business-id scoped. Application role: journals and facts SELECT+INSERT; `inventory_valuations`
INSERT+SELECT plus column UPDATE of projection fields only (not keys / `started_from_balance_version`).
`trigger_movement_id` is immutable; no UPDATE grant on stock valuation documents.
