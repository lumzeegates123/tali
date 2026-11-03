# Build 3 Slice 6 audit — Sales API and Ledger Read API

Date: 2026-11-02
Branch: `feature/build-3-slice-6-sales-api`
Baseline: `7edf573ddf8f33085aa823f8bea0ed00c32b43a3` (S0–S5 merged)
Status: **COMPLETE (2026-11-02)**. All final gates passed. Uncommitted for review.

## S5 handoff

S5 left the persisted sale, its SALE movements and its `SALE_POSTED` journals, `db:sales-consistency`, and an
inventory HTTP mapper that threw on a SALE movement. S6 exposes the S4/S5 use cases over HTTP, adds SALE to the
inventory movement contract, and adds read-only ledger routes. It adds no persistence, migration, permission or
dependency.

## Routes

All routes are under `/v1/businesses/:businessId`, declared with `BUSINESS_SCOPED_PATH` and the standard
`BUSINESS_SCOPED_GUARDS` chain (authentication, business context, device context), with no method-level guards.
Both controllers are registered in `AppModule` in every environment.

| Route | Use case | Permission (application) | Success |
| --- | --- | --- | --- |
| `POST /sales` | `RecordSale` | `sales:create`; a discount also needs `sales:discount` | 201; replay 201 + `Idempotent-Replayed: true` |
| `GET /sales` | `ListSales` | `sales:read`, or `sales:read-own` (own sales only) | 200 |
| `GET /sales/:saleId` | `GetSale` | as above; another cashier's sale is 404 | 200 |
| `POST /sales/:saleId/reversal` | `ReverseSale` | `sales:reverse` | 200; replay 200 + `Idempotent-Replayed: true` |
| `GET /ledger/accounts` | `ListLedgerAccounts` | `ledger:read` | 200 |
| `GET /ledger/balances` | `ListAccountBalances` | `ledger:read` | 200 |
| `GET /ledger/entries/:entryId` | `GetJournalEntry` | `ledger:read` | 200 |

`ledger:read` is held by OWNER and ACCOUNTANT only; MANAGER, CASHIER and STOCK_KEEPER get 403. No permission
mapping changed. There is no ledger write route and no sales PUT, PATCH or DELETE route; the route-guard
compatibility test asserts both, and that no journal, posting, COGS, refund or tax path exists.

## Controllers

The controllers parse the path, query, header and body with the shared schemas, bind the server-resolved default
location (`bindDefaultLocation`) for sales, call one application service and map the result. They compute no
price, total, tax, cost, stock, receipt number or permission. The `Idempotency-Key` header is parsed and passed
through; `RecordSale` itself enforces that the key equals `saleId`. `tenderUnwoundConfirmed` is transported as a
boolean; `ReverseSale` rejects `false` with 400. A request never names a location: a `locationId` (or any other
server-owned field) is rejected by the strict schema with 400.

## Shared contracts

`packages/shared/src/contracts/http/sales.ts` and `ledger.ts`. Every object is strict; money and quantities are
base-10 strings.

- Sales requests: `RecordSaleRequestSchema` (`saleId`, optional `deviceReportedAt`, 1–200 lines, 1–10 tenders),
  line (`variantId`, positive quantity, `expectedPriceVersion`, optional `FIXED` money or `BASIS_POINTS` 1–9999
  discount), tender (method, money, optional reference up to 256 and `cashReceived`), and
  `ReverseSaleRequestSchema` (non-blank reason up to 2000, boolean confirmation). The application keeps the
  domain bound of 500 characters for the reason.
- Sales responses: `SaleResponseSchema` and `SalesResponseSchema` (`items`, `nextCursor`; ascending sale-ID keyset).
  `costStatus`, `cogsTotal` and each line's `costStatus`/`cost` exist only with `inventory:cost-read`; they are
  absent, not null, for a CASHIER. Refinements require the cost fields to appear together, every amount to be in
  the sale currency, and `reversedAt` to be set exactly on a REVERSED sale. There is no margin field.
- Sales error details for the six conflicts, each with an envelope schema (see below).
- Ledger responses: accounts, balances (signed in the normal-balance direction) and one journal entry with its
  lines. A journal entry has at least two lines in its currency, and `reversesEntryId` is set exactly on a
  REVERSAL.
- Responses never carry the business ID, recording membership, device, correlation ID, source channel, journal
  or movement IDs, idempotency data or margin.

Enum values are duplicated in `@tali/shared` (which depends only on zod). API unit tests compare them with the
domain constants (tender methods, sale statuses, cost statuses, discount kinds, account types, system roles,
posting memo kinds, journal source kinds, movement types).

## Money currency at the application boundary

Sales money input is now `{ amountMinor, currency }` (`SaleMoneyInput`) for tender amounts, cash received and
fixed discounts, matching the wire shape. `RecordSale` parses each with the business currency and rejects any
other currency with `VALIDATION_FAILED` at the field path (`.../currency`, `CURRENCY_MISMATCH`) before any write.
The idempotency fingerprint now includes the business currency, and its command schema version is 2. Domain
arithmetic, totals, postings and S5 persistence are unchanged; database test helpers were updated to the new
input shape only.

## Error details

The error filter maps the six sales conflicts to 409 with strict, bounded details rebuilt field by field:

| Code | Details |
| --- | --- |
| `PRICE_NOT_SET` | `variantIds` (unique, ascending, 1–200) |
| `PRICE_CHANGED` | `changes[]` of `variantId`, `currentPriceMinor`, `currentPriceVersion` |
| `PRODUCT_ARCHIVED` | `variantIds` |
| `INSUFFICIENT_STOCK` | `shortages[]` of `variantId`, signed `availableQuantityMinor`; no details when empty |
| `DISCOUNT_EXCEEDS_LINE` | `lineNumber` |
| `TENDER_TOTAL_MISMATCH` | `serverTotalMinor` |

Details that fail their schema become a 500 `INTERNAL_ERROR` without details. `PriceChangedError` now
deduplicates changes by variant before bounding and sorting, so a sale repeating a stale variant cannot produce
an invalid envelope.

## Inventory contract

`SALE` is added to the inventory movement type and source-kind wire enums, and the mapper no longer throws on a
SALE movement. An original SALE movement is negative with no pack; its reversal is positive with
`reversesMovementId`. Unknown kinds and post-MVP types (for example `TRANSFER`) remain rejected.

Adding `SALE` to the shared enums broke the web build: the clients' exhaustive movement-type and source-kind
label maps, and their item history's document link, did not accept it. The only client change is the minimum
needed to compile. Web and mobile add a "Sale" label to both maps, and the item history shows no "View" link
for a SALE source, because there is no sale screen before S7. There is no sales UI, route or API client in
`apps/web` or `apps/mobile`.

## Composition

`ApiServices` gains `recordSale`, `listSales`, `getSale`, `reverseSale`, `listLedgerAccounts`,
`listAccountBalances` and `getJournalEntry`, listed in `SALES_SERVICE_KEYS` and `LEDGER_SERVICE_KEYS`. Sales use
the PostgreSQL sale, receipt-number and sales-inventory adapters from S5 and the NO_TAX snapshot resolver. The
inventory-state gate test now asserts the exact two `inventory:` bindings.

## Tests

- Shared: contract tests for sales and ledger requests, responses and error envelopes, and SALE in the inventory
  enums.
- Application: currency rejection for tenders, cash received and fixed discounts with no writes; a sale in a
  non-NGN business currency.
- API unit: response mappers (cost visibility, enum parity), error-filter details (exact, dedupe, empty shortages,
  extra properties, corrupt details to 500), composition keys, and route-guard compatibility (exact sales and
  ledger routes with guards, no write routes, rejected location and server-owned fields).
- API integration, `sales-api.integration.test.ts` (19 tests):
  - valued cash sale at the default location with server price, change, cost, `S-000001`/`S-000002` receipts and
    one `sale.recorded` audit record
  - every tender method with cash change (900 tendered from 1000 gives 100) and NOT_VERIFIED non-cash tenders; the
    tender reference is not logged
  - device time kept as evidence only; untracked, unvalued and partially valued sales
  - rejection of location, price, total, tax, cost, status, currency, channel, numeric money and other
    server-owned fields with no writes
  - wrong currency (KES, USD) in an NGN business rejected with no writes; NGN and KES sales succeed
  - `PRICE_NOT_SET`, `PRICE_CHANGED`, `PRODUCT_ARCHIVED`, `INSUFFICIENT_STOCK`, `DISCOUNT_EXCEEDS_LINE` and
    `TENDER_TOTAL_MISMATCH` with exact strict details; foreign and unknown variants 404
  - discount permission (CASHIER 403; OWNER and MANAGER allowed)
  - idempotency: missing key, key not equal to `saleId`, replay with header, reuse
  - cost visible to OWNER, MANAGER and ACCOUNTANT and absent for CASHIER; a cashier sees only their own sales;
    ACCOUNTANT cannot record; STOCK_KEEPER is denied every sales route with no writes
  - paging; cross-tenant and unknown sales 404; malformed ID 400; another location not found (application call)
  - reversal: restores stock, replay with header, reuse, second reversal `CONFLICT`, SALE movements in the item
    history, `sale.reversed` audit; key, permission, confirmation and reason validation with no writes; MANAGER
    may reverse; a product archived since can be reversed
  - 401 without a token and `DEVICE_NOT_TRUSTED` for every untrusted device case on every route, with no writes
- API integration, `ledger-api.integration.test.ts` (4 tests): permission matrix; the balanced `SALE_POSTED`
  ORIGINAL entry (cash, revenue, COGS, inventory) and its mirroring REVERSAL; balances after the sale and after the
  reversal; cross-tenant and unknown entry 404, malformed ID 400, unexpected query 400; read-only routes, 401 and
  device trust.
- Every sales and ledger integration test ends with clean sales, ledger and inventory consistency, and checks
  every body for forbidden keys and non-string amounts.

## Gates

Focused:

- `@tali/shared` test: 8 files, 94 tests.
- `@tali/application` test: 45 files, 706 tests.
- `@tali/api` test: 11 files, 138 tests.
- `@tali/api` test:integration: 14 files; 205 passed, 1 skipped. The new sales and ledger files: 23 tests.
- `@tali/database` test:integration: 50 files, 681 tests.

Database (test database; credentials not printed):

- `db:migrate:status`: 12 migrations, up to date. There is no 13th migration.
- `db:drift`: no drift against the Prisma schema or the target database.
- `db:verify-schema`: passed (36 table grant sets, 7 column grant sets, 261 CHECKs, 98 tenant FKs).
- `db:ledger-consistency`, `db:inventory-consistency` and `db:sales-consistency`: each exits 0.

Workspace:

- `pnpm test:integration`: exit 0; 12 of 12 tasks (database 681; API 205 passed, 1 skipped; worker 9 passed, 1
  skipped).
- `pnpm verify`: exit 0; 18 of 18 test tasks (domain 513, web 296, mobile 450).
- `pnpm boundaries`: no violations. `pnpm text-integrity`: 891 files, UTF-8 without BOM. `git diff --check`: clean.
- `git diff -- packages/database/prisma/schema packages/database/prisma/migrations`: empty.

Issues found by the gates and fixed in S6 code:

- The first workspace run failed `@tali/web#build`: SALE in the shared enums needed client labels (see Inventory
  contract).
- Prettier formatting and four lint findings in the new test files (a type-only import, an `any` matcher, an
  unnecessary assertion) were fixed without disabling any rule.

Runs that failed from host load (about 2 GB of 16 GB RAM free), rerun unchanged and green:

- One API unit test that scans the source tree timed out at 5 seconds once.
- In one workspace integration run, three inventory API tests failed with a 500 and 30-second hook timeouts,
  after one test ran for 671 seconds. The same suite passed alone and in the next workspace run.
- One `pnpm verify` run could not start seven web Vitest workers. The web suite then passed alone (19 files, 296
  tests), and the next `pnpm verify` exited 0.

No timeout, pool, file-parallelism or Turbo-concurrency setting was changed. No process was terminated, and no
database container or volume was touched.

## S7 handoff

- Clients call only the seven routes above. The cart is memory-only; prices, totals, tax, cost, change and
  receipt numbers come from the server response.
- Generate `saleId` as a UUIDv7 on the client and send it as `Idempotency-Key`; retry with the same body and key.
  A changed body needs a new sale ID.
- Send money as `{ amountMinor, currency }` in the business currency; quantities in the stock unit
  (`PIECE` and so on). No pack selling, price override, sale-level discount, credit or refund.
- Show the six conflict codes from their details: refresh prices on `PRICE_CHANGED`, show shortages on
  `INSUFFICIENT_STOCK`, and the server total on `TENDER_TOTAL_MISMATCH`.
- Label non-cash tenders "not verified". Show cost and COGS only when present; never compute margin from
  partial or unvalued cost.
- Offer reversal only to OWNER and MANAGER, with a required reason (at most 500 characters) and the explicit
  tender-unwound confirmation; generate a fresh reversal key per attempt.
- Show the ledger only to `ledger:read` (OWNER, ACCOUNTANT). Journal entry IDs are not exposed on sales
  responses, so a client ledger view starts from accounts and balances.
- `GET /sales` pages in ascending sale-ID order with `limit` and `after`.
- The item history already labels SALE movements "Sale" without a link; S7 may link them to the sale detail.

## Risks and limitations

- The sales money input shape changed from a bare minor-unit string to `{ amountMinor, currency }`. This is an
  application-boundary change, not a domain or persistence change; the fingerprint version moved to 2 so a
  version-1 fingerprint can never match a version-2 command.
- Sales list order is ascending by sale ID (the existing keyset); a newest-first view would need a new repository
  query and is not part of S6.
- Journal entry IDs are not linked from the sale response; the ledger entry route is reachable from a known ID
  only.
- No S8 tax, no AI, no offline sync, no credit or refunds. No migration, permission or dependency was added; no
  accepted ADR was edited.
