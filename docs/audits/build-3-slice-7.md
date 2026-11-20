# Build 3 Slice 7 audit — Web and Mobile Sales, Valuation and Ledger Clients

Date: 2026-11-03
Branch: `feature/build-3-slice-7-clients`
Baseline: `61307c857ffbf99d3b4872112a0988826714c3b8` (S0–S6 merged)
Status: **S7 COMPLETE (2026-11-19).** Every automated gate passed, and the manual walkthrough on the reference
Android device passed on 2026-11-19. Uncommitted for review.

## Scope

S7 adds the web and mobile clients for the S6 sales and ledger routes: Sell, Sales history, sale detail, full
reversal, Needs valuation with a valuation form, and a read-only Ledger. Both clients reuse the existing
in-memory store, provider and screen pattern, the existing `TaliApiClient`, the existing session
(`SessionStore.businessRequest` on mobile, which adds the business's device headers) and the existing section
navigation. There is no new navigation, auth, API-client or state-management architecture, no Next.js page route
and no new dependency.

## Server-side extension

The only server-side S7 extension is read-only inventory valuation status and the `needsValuation` inventory filter
required to fulfill ADR-009's client disclosure/valuation workflow. No Sales server business logic changed.

- `GET /inventory/balances?needsValuation=true` lists only UNVALUED items (an item with no valuation row is
  UNVALUED), with the usual search and paging. It requires `inventory:cost-read`.
- Inventory item responses carry `valuationStatus` only for `inventory:cost-read` (absent, not null, otherwise).
  It is a status only; no value, average cost or unit cost is exposed for any item.
- Files: the inventory read port, `inventory-reads.ts`, the in-memory test store, the PostgreSQL item reader, the
  shared inventory contract, the inventory response mapper and controller, with application, database and API
  integration tests.
- `RecordSale`, `ReverseSale`, the sales repository, port and persistence, `SALE_POSTED` posting and the
  consistency SQL are unchanged. No migration and no permission change.

## Clients

### API clients

Web and mobile `TaliApiClient` gain `recordSale` (the `Idempotency-Key` is the `saleId`), `listSales`, `getSale`,
`reverseSale` (keyed), `listLedgerAccounts`, `listAccountBalances`, `getJournalEntry` and `recordStockValuation`
(keyed), and the `needsValuation` list parameter. Every response is validated with the shared schema; anything
else is `invalid-response`. The six sales conflict details are parsed with their strict envelope schemas and
exposed as `ApiFailure.sales`; details that do not match fail closed as `invalid-response`, and arbitrary details
are never stored. Mobile methods take the trailing device headers.

### Affordances

`salesAffordances(role)` and the inventory `inventory:value` / `inventory:cost-read` additions are UX only; the API
authorizes every request. Comments and tests say so.

| Role | Sales | Sell | Discount | Reverse | Ledger | Needs valuation | Value stock |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OWNER | yes (all) | yes | yes | yes | yes | yes | yes |
| MANAGER | yes (all) | yes | yes | yes | no | yes | yes |
| CASHIER | yes (own) | yes | no | no | no | no | no |
| ACCOUNTANT | yes (all) | no | no | no | yes | yes | no |
| STOCK_KEEPER | no | no | no | no | no | no | no |

Unknown roles (including `__proto__` and `constructor`) get nothing.

### Sell

- Product search calls `GET /products?status=ACTIVE&q=`. The cart has one row per variant in its stock unit (no
  packs), at most 200 lines; a product without a price shows "Price not set" and cannot be added.
- Line discounts (FIXED in the business currency, or a percent converted by string to BASIS_POINTS 1–9999) are
  offered only with `sales:discount`.
- One to ten tenders: CASH, BANK_TRANSFER, POS_CARD, OTHER. Non-cash tenders show "Not verified" with a hint and an
  optional reference of at most 64 characters; cash received is offered for cash only. Switching method clears the
  field that no longer applies.
- The UI states "Final total is calculated by Tali when the sale is recorded." and "Change is calculated by Tali
  when the sale is recorded." Money is parsed with the kernel in the business currency and quantities with the
  kernel at the unit scale, without rounding. The request is validated with `RecordSaleRequestSchema` and carries
  only `saleId`, `lines` and `tenders`.
- Keyed retry: the comparison payload excludes `saleId`. An unknown outcome (network, invalid response, 5xx,
  `IDEMPOTENCY_IN_PROGRESS`, or a receipt whose `saleId` is not the key) locks editing and shows "Tali could not
  confirm whether this sale was recorded." with "Submit again with same details" (same key and body) and "Discard
  and check Sales history" (keeps the cart, new key next time). A definite rejection ends the key and keeps the
  cart. Success clears the cart only after a validated response, shows the receipt and refreshes history; the
  inventory views remount and reload when opened.
- Conflict guidance: PRICE_CHANGED updates the line's displayed price and version and requires a new submission;
  PRICE_NOT_SET "Price not set"; PRODUCT_ARCHIVED "This product is no longer available for sale."; INSUFFICIENT_STOCK
  "Available: <qty> <unit>"; DISCOUNT_EXCEEDS_LINE at its line number; TENDER_TOTAL_MISMATCH "Server total:
  <formatted>" with the cart kept and an offer to use the server total as the single tender amount;
  LEDGER_NOT_PROVISIONED "This business is not ready to record sales yet."

### Receipt, history and detail

- The receipt and detail show the API's receipt number, status, lines, subtotal, discounts, tax, total, tenders,
  cash received and change. Cost of goods sold and line costs appear only when the API returns them; "Cost unknown"
  and "Cost not applicable" are shown as given. PARTIAL shows "Margin incomplete" and "Some item costs are
  unknown."; UNVALUED shows "Margin incomplete" and "Cost unknown for this sale." No margin is computed or shown.
- History uses the server's ascending order and paging, deduplicated by sale ID.

### Reversal

Offered to OWNER and MANAGER on a POSTED sale as an error correction (never described as a refund or return). It
needs a reason of 1–500 characters and the unchecked-by-default confirmation "I confirm that the original tender
has been returned or unwound as applicable." It is keyed with a fresh UUIDv7 per attempt and follows the same
unknown-outcome pattern; success shows "Sale reversed."

### Needs valuation

A Needs valuation tab for `inventory:cost-read` with its own paging lists name, SKU, unit, on hand and "Cost
unknown". OWNER and MANAGER get "Value stock": a total value of zero or more in the business currency and a required
reason of at most 500 characters, sent as `{ variantId, expectedBalanceVersion, newTotalValue, reason }` under the
keyed operation `stockValuation`. Success shows "Opening valuation recorded." or "Operational valuation recorded."
from the API's kind. VALUATION_STALE shows its message and reloads the item; CONFLICT reloads neutrally.

### Ledger

Read-only for OWNER and ACCOUNTANT: accounts (code, name, type, normal balance, system role, status) and balances
(account, debit, credit, balance). A completeness probe `needsValuation=true&limit=1` shows "Inventory value is
incomplete because some stock needs valuation. Ledger balances show the values currently recorded by Tali." when
an item needs valuation, and "Inventory valuation completeness could not be checked." when the probe fails. There
is no posting, editing or journal browsing.

### Store lifetime and storage

One `SalesStore` (and one `LedgerStore`) per mounted business section; it is disposed on unmount, business switch
and sign-out, which drops the cart, tenders, sale ID and every idempotency key. Nothing is written to
localStorage, sessionStorage, IndexedDB, cookies, AsyncStorage, SecureStore, the filesystem or SQLite. Mobile
device headers are added per request by the session and never kept in a store. No token, device credential,
tender reference, cash received or request body is logged.

## Tests

- Web unit: `sales-api-client.test.ts` (routes, keys, contract rejection, conflict parsing, failure texts),
  `sales-affordances.test.ts` (matrix, unknown roles, frozen), `sales-store.test.ts` (draft parsing, search query,
  keyed submit and resubmit, unknown outcomes, discard, rejection, every conflict, server total, history dedupe,
  reversal key reuse, dispose and sign-out), `sales-safety.test.ts` (source guards: no float money, no client
  totals, change, tax, COGS, average cost or margin, no fetch or backend imports, no ledger write, no storage or
  logging, no token names in components; snapshot holds no token or key).
- Web component: `sales.test.tsx` (navigation per role, sell to receipt with storage check, unknown-outcome lock and
  resend, discard, tender mismatch, ledger-not-provisioned, cart dropped on leaving and sign-out, reversal with
  confirmation and key reuse, CASHIER/ACCOUNTANT without reversal, cost disclosures, Not verified, ledger tables and
  notices, valuation form, VALUATION_STALE, accountant read-only, no tab for CASHIER/STOCK_KEEPER).
- Mobile: `sales-api-client.test.ts` (every route with device headers, contract rejection, conflict parsing,
  affordances), `sales.test.tsx` (component flows on a session with an in-memory device registration, asserting
  device ID, credential and bearer headers on sales, reversal, ledger, probe and valuation requests),
  `sales-safety.test.ts` (source guards and store credential boundary).
- Existing tests updated only for the new sections and tab: the web catalog navigation list and the mobile
  inventory tab list.
- Playwright `apps/web/e2e/sales.spec.ts`, all through the UI: owner, business, tracked product, price, opening
  stock, valuation leaving Needs valuation, a cash sale with cash received; the receipt shows the receipt number,
  Posted, total 1,000.00 NGN, cost of goods sold 200.00 NGN, cash received and change 500.00 NGN; on hand drops to
  18 with a negative Sale movement; sales history detail; reversal shows Reversed, restores 20 on hand and a
  "Sale (reversal)" movement; ledger tables with no incomplete notice; no cookies, localStorage, sessionStorage or
  IndexedDB.

## Gates

Focused:

- `@tali/application` inventory reads: 18 tests; database `zc` and `zd` repository integration: 35 tests; API
  inventory integration: 30 tests.
- `@tali/web` test: 24 files, 401 tests; typecheck and build pass.
- `@tali/mobile` test: 28 suites, 499 tests; typecheck passes; `export` (Android bundle) succeeds.
- Playwright `e2e/sales.spec.ts`: 1 passed. Full `pnpm --filter @tali/web e2e`: 14 passed, then 5 Cognito passed.

Database (test database; credentials not printed): `db:migrate:status` 12 migrations, up to date;
`db:drift` no drift; `db:verify-schema` passed; `db:ledger-consistency`, `db:inventory-consistency` and
`db:sales-consistency` each exit 0.

Workspace:

- `pnpm verify`: exit 0 (18 tasks; application 708, domain 513, API 138, web 401, mobile 499 tests).
- `pnpm test:integration`: exit 0 (database 50 files, 682 tests; API 14 files, 206 passed, 1 skipped; worker 9
  passed, 1 skipped).
- `pnpm boundaries`: no dependency violations (832 modules). `pnpm text-integrity`: 926 files, all UTF-8 without
  BOM. `git diff --check`: clean. Prisma schema and migration diff: empty.

Issues found by the gates and fixed in S7 code:

- Lint: an unnecessary condition, a dynamic `delete` and useless initial assignments in the new stores; unused
  imports, unnecessary assertions and optional chains in the new tests. Fixed without disabling any rule.
- The first Playwright run failed in the spec, not the app: `heading "Opening stock"` matched the form heading
  "Record opening stock" (case-insensitive substring), so the test moved on before the save returned. The spec now
  waits for the response and matches the heading exactly.

Runs that failed from host load, rerun unchanged and green: one mobile Cognito onboarding test timed out waiting
for the restore-unavailable state in a full mobile run; the suite then passed alone (8 of 8). The first
combined `pnpm verify` and `pnpm test:integration` run failed only on load: web Vitest workers timed out starting,
and the Build 3 S6 concurrency soak (`zg-inventory-concurrency-soak`, not changed by S7) hit a PostgreSQL lock
timeout (55P03). Each command, rerun alone and unchanged, exited 0.

No timeout, pool, Playwright retry, file-parallelism or Turbo-concurrency setting was changed. No process was
terminated, and no database container or volume was touched.

## Manual Android walkthrough

**S7 MANUAL ANDROID ACCEPTANCE PASSED (2026-11-19).**

Reference device, without its ADB serial or any credential: a physical Samsung Android device, model `SM-F971U1`,
Android 17, API 37, ABI `arm64-v8a`. The walkthrough used the Owner role. It did not enter a zero total on the
valuation form. The form stated that zero is allowed. Zero-value parsing remains covered by the existing automated
client tests, not by this walkthrough.

### Environment and startup

- The native Expo development build compiled and installed on the physical Samsung device.
- The local environment used `http://127.0.0.1:3000` through ADB reverse.
- The local development identity provider was active.
- API readiness reported ready, with the database up.
- The device was registered for the selected business.
- Navigation exposed Overview, Catalog, Inventory, Sales and Ledger.

### Needs valuation

- The Needs valuation list started empty.
- A tracked product was created: name `S7 Valuation Test`, SKU `S7-VAL-001`, stock unit `PIECE`, selling price
  NGN 1,000.
- Five PIECE were received without a cost.
- The item appeared under Needs valuation with on hand 5 PIECE and "Cost unknown".
- The valuation form asked for the total value of the stock on hand. It did not ask the person to compute a unit cost.
- The recorded total was NGN 2,500, reason `S7 manual acceptance valuation`.
- The UI reported "Opening valuation recorded."
- The item left Needs valuation, and the list returned to "No stock needs valuation."

### Sales UI safety

- Product search found `S7 Valuation Test`, shown at NGN 1,000 per PIECE, in the stock unit.
- No pack-selling control was present.
- Owner discount controls offered no discount, a fixed amount and a percent.
- The client showed no authoritative total before submit. The UI stated that the final total is calculated by Tali
  when the sale is recorded.
- Cash received stated that change is calculated by Tali when the sale is recorded.
- Bank transfer showed "Not verified" and explained that Tali had not checked the payment with a bank or payment
  provider.
- The selling form did not expose a weighted average cost or any other internal valuation calculation.

### Unknown-outcome safety, then a transport interruption

Two early attempts to record the controlled cash sale entered the client's unknown-outcome state. The form locked
and offered "Submit again with same details" and "Discard and check Sales history". Submitting the same details
again did not create a duplicate. After discard, Sales history showed no sale and inventory remained 5 PIECE, so
those attempts did not persist a sale.

Later the Android ADB device transitioned to `offline`, which removed the ADB reverse transport. Live
business-scoped requests then reported that Tali could not be reached, while the Windows API process stayed healthy.
This is an environment and test-transport observation. The logs do not prove that the earlier unknown outcomes were
caused by that ADB transition. The transport was restored, and the sale and reversal below then completed normally.
The disconnects left no duplicate sale and no inconsistent inventory or ledger balances.

### Successful sale

A fresh controlled sale succeeded. Receipt `S-000001`: `S7 Valuation Test`, quantity 1 PIECE, selling price
NGN 1,000, discount NGN 0, tax NGN 0, total NGN 1,000, cost NGN 500, cost of goods sold NGN 500, tender Cash
NGN 1,000, cash received NGN 1,200, server-calculated change NGN 200, status Posted, business date 2026-11-19.
On hand moved from 5 PIECE to 4 PIECE. The same sale was readable again from Sales history and detail, with the
same server-produced receipt values.

### Ledger after the sale

The read-only Ledger was visible for Owner. Balances visibly confirmed for this sale and valuation:

- Cash on hand: debit NGN 1,000, balance NGN 1,000.
- Opening balance equity: credit NGN 2,500, balance NGN 2,500.
- Sales revenue: credit NGN 1,000, balance NGN 1,000.
- Cost of goods sold: debit NGN 500.
- Inventory reflected the opening valuation plus the NGN 500 sale cost movement.

No other post-sale balance is recorded here.

### Reversal

Sale detail offered full-sale reversal and explained that it reverses the whole sale, restores tracked stock, records
a reversing ledger entry, is not a refund or a return, and does not itself move money.

- An empty reason was rejected with "Enter the reason for this correction."
- The successful reversal used a correction reason and the explicit tender-unwound confirmation.
- The UI reported "Sale reversed."
- The original sale and its receipt stayed visible, with a reversal timestamp.
- On hand returned from 4 PIECE to 5 PIECE.

Post-reversal balances visibly confirmed:

- Cash on hand: debit NGN 1,000, credit NGN 1,000, balance NGN 0.
- Inventory: debit NGN 3,000, credit NGN 500, balance NGN 2,500.
- Opening balance equity: credit NGN 2,500, balance NGN 2,500.
- Sales revenue: debit NGN 1,000, credit NGN 1,000, balance NGN 0.
- Cost of goods sold: debit NGN 500, credit NGN 500, balance NGN 0.
- Tax payable, inventory gains and inventory shrinkage: balance NGN 0 each.

### Memory-only cart

An unsaved cart was discarded when the business context changed. Returning to Sales showed "The cart is empty." A
second unsaved cart was discarded by signing out. After signing in again and selecting the business, Sales again
showed "The cart is empty."

### Android hardware Back

All three checks passed: Sales detail back to the Sales list; an inventory item back to the stock list; the receive
form back to the previous Inventory view without saving.

### Log and credential check

After old Android logs were cleared, a clean navigation walkthrough was scanned. No match for `FATAL EXCEPTION`, an
AndroidRuntime fatal, a ReactNativeJS Error or Unhandled error, or "Unable to load". Counts were zero for
`Authorization: Bearer`, `Bearer ey`, `x-tali-device-credential`, `device credential` and `refreshToken`. The names
`accessToken` and `idToken` appeared as identifier text, so a second scan looked for value-shaped secrets. JWT-like
values, accessToken-like values, idToken-like values and refreshToken-like values were all zero. No token or device
credential value was observed in the inspected logs.

## Risks and limitations

- Money and inventory: the clients compute no authoritative figure; totals, tax, change, cost and receipt numbers
  come from the API. Line and tender inputs are parsed with the kernel and validated with the shared schema before
  sending; the API re-validates everything.
- Tenancy and auth: every request goes through the session for the selected business; mobile adds that business's
  device headers. Affordances are UX only.
- The sales list is oldest first (the S6 keyset order).
- No S8 tax, credit, receivables, refunds or returns, packs, barcode, price override, sale-level discount, held
  sales, offline sync, NEEDS_ATTENTION, provider verification, printing, journal posting or AI. No migration,
  permission or dependency was added; no accepted ADR was edited.
