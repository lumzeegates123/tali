# Build 3 Slice 4 audit — sales domain and application

Date: 2026-10-30
Branch: `feature/build-3-slice-4-sales-domain`
Baseline: `25f1be364e6f712adae193015431c918dadfe2f3` (S0–S3 merged)
Status: **COMPLETE (2026-11-01)**. All final gates passed.

## S3 handoff

S3 left valuation and journals in place. The in-memory journal adapter already accepts
`source.kind = "sale"`. The PostgreSQL `JournalRepository` still rejects that source until S5 adds the
typed sale column. Chart provisioning, `allocateProportionalMinor` (total-value WAC, HALF_EVEN,
last-unit exactness) and `inventory:cost-read` are unchanged. S4 does not add `SALE` to the persisted
movement type list.

## Domain

`packages/domain/src/modules/sales`. Sale id is UUIDv7 (`parseSaleId` / `parseId`). Lifecycle is
`POSTED` → `REVERSED` only. A posted sale's lines, tenders, totals and snapshots do not change.
`reverseSale` records the reversal fields only.

Types: `Sale`, `SaleLine`, `SaleTender`, `SaleCostStatus` (`VALUED` | `PARTIAL` | `UNVALUED` |
`NOT_APPLICABLE`), `SaleLineCostStatus` (`VALUED` | `UNVALUED` | `NOT_APPLICABLE`), tender methods
`CASH` | `BANK_TRANSFER` | `POS_CARD` | `OTHER`, verification `NOT_APPLICABLE` | `NOT_VERIFIED`,
discount `NONE` | `FIXED` | `BASIS_POINTS`, and an ADR-010-shaped tax snapshot. Money stays `Money`.

## Calculations

Line gross is `unit_price * quantity_minor / 10^unit_scale`, rounded HALF_EVEN once via
`Money.multiplyByFraction`. Stock-unit quantity only. No pack quantity, pack price or client unit price.

## Discounts

`FIXED`: `0 < amount < gross`. `BASIS_POINTS`: integer 1..9999, HALF_EVEN(`gross * bps / 10000`), and
the rounded amount must stay below the gross (`DISCOUNT_EXCEEDS_LINE` otherwise, including a 1-minor
gross at 9999 bps). A rounded zero is allowed and leaves the net equal to the gross. No 100% line, no
10,000 bps, no sale-level discount. Any non-`NONE` discount requires `sales:discount` (OWNER and
MANAGER). The check is server-side, including a fresh membership read inside the transaction.

## Tenders

1..10 tenders, each amount `> 0`. The sum must equal `Sale.total` or the use case returns
`TENDER_TOTAL_MISMATCH`. No partial payment, credit or receivable. Posting aggregates by method;
tender records stay separate.

`CASH` may snapshot `cashReceived >= amount` and `changeGiven = cashReceived - amount`. Both are
display only. The ledger debits `tender.amount`. Non-cash tenders reject `cashReceived`. Cash
verification is `NOT_APPLICABLE`; other methods are `NOT_VERIFIED`. An optional reference is at most
64 characters. Roles: cash → `CASH_ON_HAND`, bank transfer → `BANK_TRANSFER_PENDING`, POS/card →
`POS_CARD_CLEARING`, other → `OTHER_TENDER_CLEARING`.

## Tax boundary

Production `SaleTaxSnapshotResolver` is `createNoTaxSnapshotResolver`. Every recorded line is
`NO_TAX`, tax 0, total = net. The resolver never reads a client tax value. The snapshot shape can
carry treatment id, name, kind, rate, pricing mode, rounding mode, taxable base and tax so S8 can
plug in later. Examples H and I are pure posting-plan tests with precomputed illustrative snapshots
(1,000 bps). That rate is not production configuration. No tax tables, assignment, `tax:manage` or
rate resolver.

## Stock and valuation planning

`planSaleStock` decides the effect. `SalesInventoryPort` only locks and applies that plan. It does
not compute WAC, cost status or the negative-stock rule.

Online policy is `BLOCK` for every business and product (`onlineNegativeStockPolicy`). A tracked line
that would make quantity negative returns `INSUFFICIENT_STOCK` and writes nothing. There is no
merchant override and no database CHECK.

One planned movement per tracked line, including a second line for the same variant. Lines run in
request order against the running on-hand quantity and value. Valued removal uses
`allocateProportionalMinor`. Unvalued removal changes quantity only (value delta 0, status stays
`UNVALUED`). Untracked lines have no stock plan, no cost and no COGS.

Aggregate cost: no tracked lines → `NOT_APPLICABLE`; all tracked valued → `VALUED`; tracked and none
valued → `UNVALUED`; mixture → `PARTIAL`. `cogsTotal` sums known line costs. No margin formula: ADR-011
does not define one. Margin display is an S7 concern, and only when cost status is `VALUED`.

The port's S5 lock order is documented on the port: variants `FOR SHARE`, then balances `FOR UPDATE`
in ascending variant order, then valuations `FOR UPDATE` in that same order, then the receipt counter
`FOR UPDATE`. The in-memory adapter sorts variant ids before reading. S4 does not implement the
PostgreSQL locks.

## Receipt numbers

`SaleReceiptNumberIssuer` issues business-scoped online numbers `S-000001`, `S-000002`, … (at least
six digits). The number is display only. It is not the sale id and not the idempotency key. Issuance
happens inside `apply()`, after price, stock and tender checks. The in-memory issuer is a unit-of-work
participant, so a rolled-back sale does not consume a committed number. Gaps are acceptable. Per
business, not global. S5 will add `sale_receipt_sequences`. Offline numbers must not match `^S-[0-9]+$`.

## Ports

`SaleRepository`: insert, findById, findByIdForUpdate, attachOriginalJournal, markReversed, list.
`SalesInventoryPort`: lockForSale, applySalePlan, applyReversalPlan. `SaleReceiptNumberIssuer.issue`.
S4 implementations are in-memory only.

## Idempotency

`RecordSale` requires `Idempotency-Key` and requires it to equal the UUIDv7 `saleId`
(`VALIDATION_FAILED` on mismatch). The stored result is `{ saleId }` only. After a fresh run or a
replay the use case reloads the sale. Same key and fingerprint replay; same key and a different body
is `IDEMPOTENCY_KEY_REUSED`. Replay does not issue a receipt, move stock, post or audit.

`ReverseSale` uses its own business-scoped key. A new key against an already reversed sale is
`CONFLICT`, not an inventory-style no-op. Same key replays. A different body is
`IDEMPOTENCY_KEY_REUSED`.

## RecordSale

User actor, `sales:create`, location-bound context, UUIDv7 sale id, key equals sale id, syntax,
fingerprint, then one unit of work. Inside apply: acting membership, share-lock variants, active /
unit / price / archive checks, line amounts and `NO_TAX`, lock stock and valuation, `BLOCK`, cost
plan, tender check, receipt number, insert, apply the stock plan, post `SALE_POSTED` v1 through
`LedgerPostingService`, attach the original journal id, audit `sale.recorded`. `occurredAt`,
`businessDate` and `recordedAt` come from the server clock. `deviceReportedAt` is evidence only.

## Reads and cost visibility

`GetSale` and `ListSales`. OWNER, MANAGER and ACCOUNTANT see the business's sales at the current
location. CASHIER sees only sales recorded by their membership; another cashier's sale is `NOT_FOUND`.
STOCK_KEEPER is denied. Another business is `NOT_FOUND`. Another location is `NOT_FOUND` on get and
absent from the list. Cost status, line cost, valuation version and COGS are present only when the
actor has `inventory:cost-read`. CASHIER and STOCK_KEEPER do not.

## SALE_POSTED v1

Pure `salePostedPlan`. Tender debits by method, discount debit `SALES_DISCOUNTS`, revenue credit
`SALES_REVENUE` (inclusive tax credits gross minus tax; otherwise gross), tax credit `TAX_PAYABLE`
when the snapshot tax is non-zero, and valued COGS as debit `COST_OF_GOODS_SOLD` / credit
`INVENTORY`. Zero lines are omitted. Tests cover A cash+valued, B bank, C POS, D split (and same-method
aggregation), E line discount, F exact mirror of A, G unvalued revenue only, H illustrative exclusive
tax, I illustrative inclusive tax, and OTHER.

## Reversal

`sales:reverse` (OWNER, MANAGER). Reason 1..500. `tenderUnwoundConfirmed` must be true
(`VALIDATION_FAILED` otherwise). It records that an authorized person asserts the tender was unwound
outside Tali. Tali does not verify cash, bank or card movement.

The journal is `reversePostingPlan` of the original `SALE_POSTED` v1 plan, posted as `REVERSAL`
against the original sale journal and the same sale source. Price, discount, tax, cost and tenders
are not recomputed. The reversal business date is the reversal server time.

Inventory reversal restores the sold quantity and adds back the snapshotted COGS, not the current
average. An original unvalued line adds value 0. A current `UNVALUED` projection stays `UNVALUED`
even if the added snapshot changes the recorded value. An archived product does not block reversal.

From a non-negative quantity and value, restoring a positive quantity and a non-negative snapshotted
cost cannot make value negative (Case B) or land on quantity 0 (Case C). `planSaleStockReversal`
fails closed if a residual case or a negative starting position appears. It does not invent a second
residual policy and does not post `REVERSAL_RESIDUAL`.

## Permissions

`sales:read`, `sales:read-own`, `sales:create`, `sales:discount`, `sales:reverse`.

| Role | Permissions |
| --- | --- |
| OWNER | all five |
| MANAGER | all five |
| CASHIER | `sales:read-own`, `sales:create` |
| STOCK_KEEPER | none |
| ACCOUNTANT | `sales:read`, `sales:read-own` |

`inventory:cost-read` is unchanged (OWNER, MANAGER, ACCOUNTANT).

## Audit

Entity `sale` on the application registry (no migration). `sale.recorded` payload: receipt number,
line count, tender count, total, discount total, tax total, cost status, journal entry id.
`sale.reversed` payload: receipt number, reversal journal entry id, `tenderUnwoundConfirmed: true`.
The reversal reason is the audit envelope reason, not a payload field. No line or tender detail.
Replay writes no second audit. A deterministic rejection writes none. Both ride the same unit of work.

## Errors

`PRICE_NOT_SET`, `PRICE_CHANGED` (variant id, current price, current version only), `PRODUCT_ARCHIVED`,
`INSUFFICIENT_STOCK`, `DISCOUNT_EXCEEDS_LINE`, `TENDER_TOTAL_MISMATCH`, plus the existing
`VALIDATION_FAILED`, `PERMISSION_DENIED`, `LEDGER_NOT_PROVISIONED`, `CONFLICT`,
`IDEMPOTENCY_KEY_REUSED` and `NOT_FOUND`. The HTTP status map sends the five new codes to 409 so the
code union stays exhaustive. No sales routes or request schemas. `PRICE_CHANGED` details are on the
error class; the HTTP details mapper is unchanged until S6.

## AI boundary

`ai-no-catalog-inventory` now also forbids the sales application module. Sales may still import the
ledger posting service. The boundary self-test covers a forbidden sales module import and a forbidden
sales port import from both AI trees.

## In-memory adapters

`InMemorySalesStore` (repository, receipt issuer, inventory port) and `createSalesHarness`. State is
replaced on write and restored by the unit-of-work snapshot. Tests inject failures at sale insert,
stock apply, journal insert and audit, and the matching reversal steps. A failure leaves no sale,
stock change, journal, audit or committed receipt number, and the idempotency key can be retried.

## What S4 does not contain

No Prisma models, migrations, `sale_lines`, `sale_tenders`, `sale_receipt_sequences`, `sale_id`
columns, persisted `SALE` movements, PostgreSQL sales repository, sales consistency script, sales
controller, shared sales HTTP contracts, or web/mobile UI. No S8 tax configuration. No new dependency.

## S5 handoff

S5 persists the sale aggregate, turns each planned effect into a `SALE` inventory movement and
valuation fact, and adds the typed journal sale source. It should keep the lock order above, issue
the receipt inside the same transaction, and apply the plan this slice already computed. Reversal
should restore the snapshotted quantity and cost rather than recomputing WAC. The PostgreSQL journal
repository must keep rejecting `source.kind = "sale"` until that typed source exists.

## Gates

First attempt (2026-10-30): `pnpm test:integration` was red. The fixture schema already existed, the
worker smoke test timed out, and a database-only retry hit `40P01` deadlocks and missing rows. Those
runs overlapped each other against a `postgres-test` container that had been up for days. `pnpm verify`
also hit an API unit `beforeAll` timeout under parallel load.

Recovery (2026-11-01), with no source, timeout, pool or concurrency change:

- No stale vitest, turbo or integration processes were running; none were terminated.
- `postgres-test` was recreated (stop, rm, `up -d --wait`) and reported healthy. The development
  `postgres` service and its volume were not touched.
- `TALI_ENV=test`; the test URLs default to the loopback `tali_test` database. Fixture safety checks
  are unchanged.
- Database integration alone: 44 files, 596 passed. Worker: 9 passed, 1 skipped (SIGTERM test is
  Linux-only). API: 182 passed, 1 skipped.
- `pnpm test:integration`: exit 0, 12/12 tasks.
- `pnpm verify`: the first run exited 1 because web Vitest workers failed to start under host memory
  pressure (`Timeout waiting for worker to respond`); web then passed 19/19 files on its own. The
  rerun of `pnpm verify` exited 0 (18/18 test tasks, web 19 files, mobile 450 tests).
- `pnpm boundaries`, `pnpm text-integrity` and `git diff --check` pass. No changes under
  `packages/database`.

Classification: stale/overlapping test contamination plus host resource pressure. Not an S4 defect.

Note: the turbo cache entry for `@tali/database#test` replays a stray `Prisma.sql is not a function`
fragment from an older run after its passing summary. The task succeeds, and a direct
`pnpm --filter @tali/database test` passes 19/19.

## Risks and limitations

- Margin is not calculated. S7 needs an accepted formula, and only for `costStatus = VALUED`.
- The in-memory port does not take real row locks. Concurrent lock-order proof is an S5 test.
- Receipt gaps are allowed. A failure before commit does not leave a committed sale; a PostgreSQL
  sequence can still gap, which ADR-011 accepts.
- `PRICE_CHANGED` HTTP response details are not mapped yet. The application error already carries the
  bounded change list.
- Sale reversal does not call the inventory residual policy. That is safe only while restored quantity
  is positive and restored value is non-negative. The planner throws if those invariants are absent.
