# Build 2 Slice 7: inventory clients (web and mobile)

- Date: 2026-10-09
- Status: **COMPLETE** (all gates passed; pending human review; nothing committed or pushed).
- Branch: `feature/build-2-slice-7-inventory-clients`, based on `8db6f3d` (Slice 6 on `main`).
- Scope: Slice 7 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05): the web and
  Android-first mobile inventory clients over the 22 Slice 6 inventory routes. Stock list with search, the
  `lowStock=true` filter and the LOW STOCK indicator; item detail with movement history; opening stock, goods
  receipts, adjustments and write-offs; reversals; threshold set, change and clear; stocktakes (start, count, recount,
  remove, post, cancel), BLIND and FULL.
- Not in this slice: Slice 8 (hardening and acceptance, the Android device walkthrough). **Slice 8 is not started.**
- Change set against the base: 49 files (10 modified, 39 new, 0 deleted), including this audit and Plan 004.
  - Modified (10): the web and mobile API clients and failure messages (4), the business section switch on each
    surface (2), the mobile `Field`/style helpers, `apps/web/src/app/globals.css`, one nav expectation in
    `apps/web/test/catalog.test.tsx` (the business sections now include Inventory), and Plan 004.
  - New (39): `apps/web/src/inventory/` (14), `apps/mobile/src/inventory/` (14), four web test files and one web
    fixture, one Playwright spec, three mobile test files and one mobile fixture, and this audit.
- **No server, domain, schema or migration change.** No file under `apps/api`, `apps/worker`, `packages` or
  `tooling` is changed. **No dependency added**: no `package.json` or lockfile change; no navigation, camera,
  storage or persistence library.

## Summary

| Area                                                                                         | Result   |
| -------------------------------------------------------------------------------------------- | -------- |
| Web and mobile API clients: 22 inventory routes, strict shared-schema response validation    | PASS     |
| LOW STOCK from the API boolean only; never for archived items                                | PASS     |
| Threshold set/change/clear with `thresholdVersion`; VERSION_CONFLICT shows and reloads       | PASS     |
| Opening, receipt, adjustment (explicit direction), write-off; reversals with reason and confirmation | PASS |
| Stocktakes: create (CONFLICT guidance), count/recount/remove with line version, post/cancel with confirmation | PASS |
| BLIND never renders `expectedAtCount` or `variance`; FULL renders them from the API          | PASS     |
| `STOCKTAKE_STALE`: message, stale lines marked, reload, no automatic resubmission            | PASS     |
| Keyed commands keep one idempotency key across uncertain retries                             | PASS     |
| No `locationId`, no client stock arithmetic, no persistence, no secrets in state or bundles  | PASS     |
| `pnpm verify`                                                                                | exit 0 (third run; see failed runs) |
| `pnpm test:integration`                                                                      | exit 0   |
| Web Playwright (both configs), including the new `inventory.spec.ts`                         | 12 + 5 passed |
| Client bundle check; Expo Android export; `pnpm boundaries`                                  | clean; exit 0; clean |
| gitleaks (history, changed tree, temporary committed clone)                                  | no leaks |

## A. Governing decisions

- **ADR-008** (ACCEPTED), unchanged. Plan 004 S7 content and gate. The Slice 6 audit's "Slice 7 obligations".
- `00-architecture.mdc` (clients hold no authoritative rules), `20-financial-integrity.mdc` (inventory changes only
  through the API's canonical movements), `30-multitenancy.mdc` (no client `businessId`/`locationId` trusted; the
  business comes from the session's selected membership and the location is resolved by the API), `70-security.mdc`
  (no local storage of tenant data or credentials).

## B. API clients (`apps/web/src/lib/api-client`, `apps/mobile/src/api`)

- One method per Slice 6 route (9 reads, 13 writes); every response is parsed with the strict `@tali/shared` schema
  before it reaches a store; a body that fails the schema is an `invalid-response` failure, never partially used.
- Keyed creations (opening, receipt, adjustment, write-off, stocktake create) send `Idempotency-Key`; versioned
  writes send `expectedVersion` from the last API response (threshold version, line version, stocktake version).
- Mobile requests also carry the device headers of the selected business (the existing Build 1 device pattern);
  `device` is the last optional argument of every mobile method.
- `STOCKTAKE_STALE` details are read with the shared `StocktakeStaleErrorEnvelopeSchema`
  (`staleVariantIds`, `staleLineCount`); any other envelope keeps the generic API failure.
- Tests: `inventory-api-client.test.ts` on each surface (22 routes: method, path, headers, body, and an unknown
  response field is an `invalid-response`, never a value; mobile also asserts the device headers).

## C. Stores and screens

- `InventoryStore` (one per surface, per mounted business): a `useSyncExternalStore` store with frozen snapshots and
  generation counters, so a late response for a previous query or business is dropped. It holds API responses,
  reduced item labels (name, SKU, unit, status) for display, and per-operation keyed-command state; it holds no token,
  device credential or idempotency key in its snapshot (store tests and the mobile boundary test check the JSON).
- Keyed commands (`keyed-command.ts`): a network failure, a 5xx or an unparseable body leaves the outcome unknown and
  keeps the key; "Submit again" resends the same body with the same key; a different body while unknown is refused;
  "Discard this submission" drops the key; a 4xx is final and drops it. A replayed stocktake post (`changed: false`,
  status POSTED) is a success.
- Permissions: `affordances.ts` mirrors the server matrix (OWNER and MANAGER all; STOCK_KEEPER read, threshold,
  receive, count; CASHIER and ACCOUNTANT read) **to hide controls only**; the API remains the authority, and a 403
  is shown as a denial.
- Web: an Inventory tab in the business section switch, with Stock and Stocktakes sections. Mobile: the same, inside
  the existing business screen, with the Android hardware back button returning to the previous inventory view. No
  router or navigation library was added on either surface.

## D. Inventory rules in the clients

- **LOW STOCK** is `item.lowStock && productStatus !== "ARCHIVED"`, rendered only by `LowStockBadge`; no on-hand or
  threshold comparison exists in client source (safety tests). Archived items are labelled "Archived".
- **Quantities** are typed as text and converted with the kernel `Quantity`/unit definitions into the wire shape
  (`quantityMinor` string plus unit, or pack count plus optional loose quantity for counts). Fractional input for a
  whole unit and excess precision are rejected before sending. No `parseFloat`, `parseInt`, `Number(`, `toFixed`,
  `Math.` or arithmetic on `quantityMinor` exists in inventory source; balances, variances and the low-stock state are
  only displayed as the API returned them.
- **Adjustments** require an explicit Increase or Decrease per line and a reason (`FOUND_STOCK`,
  `DATA_ENTRY_CORRECTION`, `OTHER`); write-offs a reason (`DAMAGED`, `EXPIRED`, `SPOILED`, `THEFT_OR_LOSS`, `OTHER`).
  `INSUFFICIENT_STOCK` keeps the form values.
- **Reversals**: receipts, adjustments and write-offs, with a required reason and a second confirmation step;
  opening stock offers no reversal. The document is reloaded afterwards; a replay says "already reversed".
- **Thresholds**: set from version 0, change and clear with the current `thresholdVersion`; a `VERSION_CONFLICT`
  shows a message and reloads the item; nothing is retried with a guessed version. Hidden without
  `inventory:threshold`.
- **Stocktakes**: a create `CONFLICT` explains that one is in progress and offers to open it (found via the DRAFT
  list). Counts send no version on the first count and the line version on a recount; removal sends the line
  version. Post and cancel need `inventory:count-post` and a confirmation. On `STOCKTAKE_STALE` the clients show
  "Some stock changed while you were counting. Recount the affected items before posting.", mark the listed lines,
  reload, and do not resubmit; a recount clears the mark.
- **BLIND**: the line type is a discriminated union on `visibility`; `expectedAtCount` and `variance` are read only
  inside the FULL-only component (`FullCells` on web, `FullLineFacts` on mobile), and the Expected and Difference
  columns exist only when every line is FULL. Counters see a hint that expected quantities are not shown.
- **Location**: no client code contains `locationId`; every request relies on the server-resolved default location.

## E. Tests

| Suite                                  | Result                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| web (Vitest)                           | 19 files, 295 passed (Slice 6: 15 files, 198)                  |
| mobile (jest-expo)                     | 25 suites, 448 passed (Slice 6: 22 suites, 370)                |
| web Playwright (`playwright.config.ts`) | 12 passed (Slice 6: 11), including `inventory.spec.ts`        |
| web Playwright (`playwright.cognito.config.ts`) | 5 passed (unchanged)                                  |
| domain, application, shared, API, database, worker, integrations, config, text-integrity, bundle-check unit | 435, 604, 69, 92, 19, 11, 109, 37, 12, 8 passed (unchanged) |
| database integration                   | 32 files, 462 passed (unchanged)                               |
| API integration                        | 11 files, 169 passed, 1 skipped (unchanged)                    |
| worker integration                     | 9 passed, 1 skipped (unchanged)                                |

New client tests:

- Web: `inventory-api-client.test.ts`, `inventory-store.test.ts` (11), `inventory.test.tsx` (22 component tests),
  `inventory-safety.test.ts` (9).
- Mobile: `inventory-api-client.test.ts`, `inventory.test.tsx`, `inventory-safety.test.ts` (source guards plus a
  store test proving the device headers are sent and no token, device ID, credential or key appears in the state);
  78 tests across the three.
- The component tests cover: LOW STOCK from the boolean only and never for archived items; search and the
  `lowStock` query; the role matrix (controls hidden per role, threshold panel hidden for CASHIER); history and the
  source-document link; threshold version 0 then the returned version, VERSION_CONFLICT reload, clear with version;
  adjustment direction; INSUFFICIENT_STOCK keeping the form; fractional rejection; receipt key reuse after an
  uncertain failure; reversal confirmation; opening stock not reversible; BLIND without Expected/Difference and
  without the expected value anywhere in the rendered output; FULL recount with the line version; remove; stale
  message and marks; post replay; cancel; create CONFLICT guidance; mobile hardware back.

### Safety tests (the 11 required)

| Required check                                 | Where                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| 1. No float quantity arithmetic                | web and mobile `inventory-safety.test.ts`                                |
| 2. LOW STOCK from the API boolean only         | both safety tests (badge only in its component, fed `item.lowStock`) and component tests |
| 3. No `onHand <= threshold`                    | both safety tests (comparison regex over all inventory source)          |
| 4. No direct inventory writes                  | both safety tests (no `fetch(`, XMLHttpRequest or backend imports; writes only through the API client) |
| 5. No `expectedAtCount` in BLIND rendering     | both safety tests (only inside the FULL-only component) and BLIND component tests |
| 6. No `variance` in BLIND rendering            | as 5                                                                     |
| 7. No persistence library                      | both safety tests (no storage APIs or libraries); no dependency change   |
| 8. No secrets or bearer tokens in bundles      | client bundle check (web, mobile JS, Hermes, app config); no token names in components; store state scans |
| 9. No server-only modules in bundles           | client bundle check; `pnpm boundaries`                                   |
| 10. No domain/application inventory imports    | both safety tests (only `@tali/domain/kernel`); `pnpm boundaries`        |
| 11. No `locationId` from UI state              | both safety tests (no `locationId` in inventory source); Playwright asserts no `locationId` in request bodies |

### Playwright (`apps/web/e2e/inventory.spec.ts`, real API and PostgreSQL)

One owner and one invited stock keeper on a fresh business: product creation; opening stock (keyed, no
`locationId`, not reversible); threshold set from version 0 and LOW STOCK shown from the API; goods receipt and its
reversal (the empty reason is refused first); a Decrease adjustment; a write-off and its reversal; the movement
history; the server-side low-stock filter; threshold change (version 1) and clear (version 2); a FULL stocktake
counted, then a receipt that makes the post a real `STOCKTAKE_STALE` with the stale line marked; the recount with the
line version and a successful post (one correction, on hand 15); a second stocktake meeting the in-progress
`CONFLICT` and opening it; the stock keeper sees receive but not opening, adjust or write-off, counts BLIND (the
response contains neither key, the page shows neither column nor the expected value), and cannot post or cancel; the
owner cancels and stock is unchanged. Both browser contexts end with no cookies, web storage or IndexedDB, and the
page never contains the access token.

## F. Known design boundaries

- The permission matrix in `affordances.ts` is a client copy used to hide controls; the server stays authoritative.
  A control shown from a stale role is still refused by the API.
- Item labels in stocktake and document views come from `GET item`, reduced to name, SKU, unit and status; a label
  that is NOT_FOUND shows "Item not available".
- Stocktake lines are read in at most 10 pages of 100 (the Slice 6 bound is 1,000 rows); if more remain the view says
  only the first lines are shown, and a first count of an already-counted line is refused by the API, which asks for a
  recount.
- Uncertain keyed submissions live in memory only; reloading the page (web) or closing the app (mobile) loses the
  pending key, by the no-persistence rule. The user is told to check the stock history.
- No offline queue: inventory operations require connectivity in this slice.

## G. Final verification

| Check                                                                                  | Result |
| -------------------------------------------------------------------------------------- | ------ |
| `pnpm verify` (alone)                                                                  | third run exit 0, 18 of 18 tasks (failed runs below) |
| `pnpm test:integration` (alone, after verify)                                          | exit 0 on the first run, 12 of 12 tasks |
| Web Playwright (alone, after `pnpm run build`), `playwright.config.ts`                 | 12 passed |
| Web Playwright, `playwright.cognito.config.ts`                                         | 5 passed |
| `node tooling/client-bundle-check/src/cli.mjs`                                         | web 40 files, mobile JS 37, Hermes 37, app config 1: clean |
| `pnpm --filter @tali/mobile run export` (Android)                                      | exit 0 |
| `pnpm boundaries`                                                                      | self-test pass; no violations (698 modules, 3621 dependencies) |
| gitleaks v8.30.1 (Docker): full history; changed tree; disposable clone with the change set committed | no leaks |
| Mobile `tsc --noEmit` and ESLint on `src` and `test`                                   | exit 0; 0 problems |

The local test container is published on `127.0.0.1:57433` through the existing `TALI_POSTGRES_TEST_PORT`
override, with the existing `TEST_DATABASE_URL`, `TEST_MIGRATION_DATABASE_URL`, `MIGRATION_DATABASE_URL`,
`SHADOW_DATABASE_URL` and `DATABASE_URL` overrides (local-only credentials from `.env.example`). No repository file
was changed for the port. The gitleaks clone was a temporary local clone with the change set copied in and committed
there only; it was deleted after the scan. No commit was made on the feature branch.

### Failed and retried runs

- **Development fixes** (before the gates): component-test mock bodies that did not match the shared schemas
  (missing `changed`, a null `countedQuantity` on a REMOVED line), fixed to the schemas; a BLIND assertion and a
  safety regex that matched hint text, narrowed to column headers and the badge markup; `eslint --fix` removed
  `HTMLInputElement` casts that tsc needed, replaced by typed queries; an invalid adjustment reason in a test; a
  mobile `switch` made exhaustive. One real defect was found and fixed: on web, an inline `onUnavailable` callback
  for the stocktake view changed identity on every render and re-triggered its load; it is now a stable callback.
- **`pnpm verify`, first run: format check failed** on `apps/mobile/src/api/tali-api-client.ts` (a Slice 7 file);
  Prettier rewrapped lines only.
- **`pnpm verify`, second run: one unchanged mobile test timed out.** `test/amplify-cognito.test.ts` "restoration
  while Cognito is unreachable keeps the stored session, and can be abandoned" exceeded its 5 s timeout while the
  suite took 109 s under turbo's parallel load (447 of 448 passed). The file is not in the change set and passed in
  the standalone mobile run minutes earlier (25 suites, 448 passed). The **unchanged third run exited 0**. No timeout
  or configuration was changed. This is the host-saturation pattern recorded in earlier audits.
- **Playwright, inventory spec:** three test-locator fixes (the Stock section button also matched Stocktakes; the
  item-picker group and its input share a label; the low-stock filter correctly stayed on after the item stopped
  being low, so the spec now turns it off and checks the full list returns). No application change.
- The Playwright fixes and these documents came after the passing `pnpm verify`; `pnpm verify` was therefore run
  again, alone, on the final tree (section G).

## H. Windows skips

- The two skipped tests are the existing SIGTERM graceful-shutdown tests (`skipIf(process.platform === "win32")`) in
  `apps/api/test/integration/startup.integration.test.ts` and `apps/worker/test/integration/worker-process.integration.test.ts`;
  unchanged. Slice 7 adds no skip. **No Linux run is claimed.**

## Risk

- **Inventory integrity.** Clients never set or compute stock: every change is an API command that writes canonical
  movements server-side; balances, variances and LOW STOCK are displayed as returned. Retries cannot double-move
  stock: keyed commands keep their key, versioned commands send the last-read version, and post/cancel are naturally
  idempotent on the server.
- **Tenancy and location.** The business ID comes from the session's selected membership; no client code sends a
  `locationId`. Cross-tenant and cross-location enforcement is the Slice 6 server behaviour, unchanged.
- **Permissions.** The client hides controls by role; the API rejects anything else (403 shown as a denial).
- **BLIND counts.** The client cannot show what the API does not send; the FULL-only fields are reachable only through
  the FULL branch of the union.
- **Secrets.** No token, device credential or idempotency key is stored, logged or kept in store state; bundle scans
  are clean.
- **AI.** No AI code exists; nothing in this slice is reachable by AI.

## Slice 8 obligations

Slice 8 (hardening and acceptance) remains: the audit coverage review, the concurrency soak, the tenancy and
permission security review, the low-stock end-to-end acceptance on web **and Android**, the reference Android device
walkthrough on the debug APK, and the final Build 2 audit. **Slice 8 is not started.**
