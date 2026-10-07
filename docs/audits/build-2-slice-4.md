# Build 2 Slice 4: catalog clients (web and mobile)

- Date: 2026-10-06
- Status: **COMPLETE** (all gates passed; pending human review; nothing committed).
- Scope: Slice 4 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05), as the
  human-approved Slice 4 plan describes. One additive read route (business currency); web and mobile API client
  methods for the Slice 3 catalog routes; `SessionStore.businessRequest`; a per-business `CatalogStore` on each
  client; the web Catalog section; the mobile Catalog tab; component tests and a Playwright flow.
- Not in this slice: any inventory UI, movement, balance or stocktake (S5 to S7); camera scanning; client
  persistence of catalog data; any cost, tax, ledger or valuation behaviour.
- Dependencies: **none added**. The lockfile is unchanged. ADR-008 is unchanged. **No schema or migration change.**
  `PreInventoryStateReader` is untouched.

## Summary

| Area                                                                                                  | Result   |
| ----------------------------------------------------------------------------------------------------- | -------- |
| `GET /v1/businesses/:businessId/currency` (`business:read`), the only API contract addition          | PASS     |
| Web and mobile API client methods for every catalog route the client uses                             | PASS     |
| `SessionStore.businessRequest` with business and resource `NOT_FOUND` scopes, web and mobile          | PASS     |
| `CatalogStore` per selected business; never an authorization source; no new state library             | PASS     |
| Credentials ephemeral: never in store, snapshot, props, context, logs or storage (tested)             | PASS     |
| `KeyedSubmission`: unknown-outcome retry reuses the key; changed command, success or reuse resets it  | PASS     |
| Money through the kernel `Money` and `MoneyWireSchema`; pack quantities through the kernel `Quantity` | PASS     |
| Role affordances (UX only); the server stays the authority                                            | PASS     |
| `VERSION_CONFLICT`: no automatic retry, draft kept, Reload latest                                     | PASS     |
| Web: Overview and Catalog navigation; products, prices and history, categories, packs                 | PASS     |
| Mobile: Overview and Catalog tabs; products, search incl. barcode, create, edit, archive, price       | PASS     |
| Mobile hardware back only in detail, create and edit views, removed on unmount                        | PASS     |
| No client persistence of catalog data                                                                 | PASS     |
| Playwright (11 tests, including the new catalog flow)                                                 | PASS     |
| Client bundle secret scan                                                                             | clean    |
| `pnpm verify`                                                                                         | exit 0   |
| `pnpm test:integration`                                                                               | exit 0   |
| gitleaks (history, changed files, temporary committed tree)                                           | no leaks |

## Currency route

`GET /v1/businesses/:businessId/currency` returns `{ "code": "NGN", "minorUnitDigits": 2 }` for the context
business. The clients need the minor-unit digits to convert typed decimal prices and to format amounts exactly;
no existing route returned them.

- Use case `GetBusinessCurrency` (`packages/application/src/modules/business/queries.ts`): checks `business:read`
  on the server-resolved `BusinessContext`, reads the business and its currency reference row inside one
  `unitOfWork.run`. A missing business is `NotFoundError`; a missing reference row is an internal error (it breaks
  a database invariant). No audit record, no idempotency key (a read).
- Contract `BusinessCurrencyResponseSchema` (`packages/shared/src/contracts/http/tenancy.ts`): strict object,
  `code` an ISO 4217 code, `minorUnitDigits` an integer 0 to 4.
- Route on `BusinessScopedController` behind the three business-scoped guards; any query key is 400
  (`EmptyQuerySchema`); the response is parsed by its schema before sending.
- The route guard compat test now lists 30 business-scoped routes. Integration tests: all five roles read the
  currency; each business reports its own exponent from reference data; another business's currency is 404; a
  query is rejected.

No other API contract changed.

## Architecture

```text
UI component -> CatalogStore (per business) -> SessionStore.businessRequest -> TaliApiClient -> Tali API
```

- **API clients** (`apps/web/src/lib/api-client/tali-api-client.ts`, `apps/mobile/src/api/tali-api-client.ts`):
  typed methods for the catalog routes plus the currency route. Each parses the response with the shared schema
  and returns `ApiResult` (`unavailable`, `api-error` or `invalid-response` on failure). The mobile methods take
  a trailing optional `DeviceHeaders` argument, so device-signed headers keep working.
- **`SessionStore.businessRequest(businessId, { notFoundScope }, send)`** (both clients): gives `send` the API
  client and the credentials for that one request. It returns `ignored` if the session or the selected business
  changed before or during the request, or if the session handled the failure itself (401, unregistered,
  disabled). See the `NOT_FOUND` semantics below.
- **`CatalogStore`** (`apps/web/src/catalog/catalog-store.ts`, `apps/mobile/src/catalog/catalog-store.ts`): one
  per selected business, created in a `useEffect` and disposed on unmount or business change (so React StrictMode
  never reuses a disposed store). It exposes a snapshot via `useSyncExternalStore`. It holds catalog view state
  only: reference data (units, currency, category options), the product list, search, status, pagination and
  submitting flags. It is never an authorization source: affordances come from the role, and the server decides.
- **UI**: thin components that read the snapshot and call the store; no business rule lives in a component beyond
  formatting and form-to-command mapping.

## `NOT_FOUND` semantics

- **Business scope** (`notFoundScope: "business"`): lists, category options, units and currency. A `NOT_FOUND`
  means the selected business is no longer accessible; the result is `businessUnavailable` and the UI shows the
  generic "This business is not available." notice. **The selection is never changed automatically**; the user
  picks another business.
- **Resource scope** (`notFoundScope: "resource"`): a single product, category, pack or price history. A
  `NOT_FOUND` is the neutral "This item is not available. It may have been removed, or you may no longer have
  access to it.", with no hint whether it never existed or belongs to another business.
- The existing `#businessRead` path (business overview) is unchanged.
- Tested on both clients for both scopes; a resource `NOT_FOUND` never alters the selection.

## Credential boundary

- Credentials (access token, and on mobile the device headers derived from the stored device credential) are
  passed to `send` for one request and never kept. They never enter the `CatalogStore`, its snapshot, React props,
  context, logs, `localStorage`, `sessionStorage`, AsyncStorage or any other persistence.
- Mobile keeps the device header behaviour and `DEVICE_NOT_TRUSTED` handling from Build 1; every catalog request
  passes `device` from the credentials.
- Tests (`apps/web/test/credential-boundary.test.ts`, mobile `catalog.test.tsx`): the store snapshot is searched
  for the token value and for credential-named keys by exact identifier match (with a detector self-test); the
  catalog sources, with comments stripped (stripper self-tested), never name `token`, `accessToken`, `idToken`,
  `refreshToken`, `Authorization` or `credentials`; the stores have no credential field; no storage or `console`
  use. Mobile uses an in-memory `DeviceCredentialStore` fake and checks no device secret reaches the snapshot.

## Money and quantity

- Prices typed in major units go through `Money.fromDecimalString(text, currency)`, then `toMinorUnitsString()`,
  then `MoneyWireSchema`. Inexact input (more decimals than the currency allows), zero, negative and oversized
  values are rejected with fixed wording. Display uses `Money.fromMinorUnitsString(...).toDecimalString(...)` and
  a pure string digit grouping; without a matching currency definition the exact minor-unit string is shown.
- Pack quantity per pack is parsed with the kernel `Quantity` and the unit from the API (for example KG "1.5"
  becomes `factorMinor` "1500"); display formats the authoritative wire string.
- No `parseFloat`, `Number(`, `toFixed` or `Math.` in the catalog sources (guard test). Clients import only
  `@tali/domain/kernel` and `@tali/shared`; the boundaries check passed.

## Idempotency

`KeyedSubmission<C>` (`apps/*/src/catalog/keyed-submission.ts`) holds one `Idempotency-Key` per logical
submission, in memory only.

- An unchanged command resubmitted after an unknown outcome (network failure, timeout, server error) reuses its
  key, so the server replays instead of creating twice.
- A changed command gets a new key; success and `IDEMPOTENCY_KEY_REUSED` forget the key. Business change and
  disposal reset it.
- `sameCommand` per operation: CreateProduct compares every field, including whether optional fields are present
  and `initialPrice`; CreateCategory compares `name`; AddPack compares `productId`, `name` and `factorMinor`.
- Web uses all three; mobile has CreateProduct only (no category or pack management on mobile).

## Role affordances (UX only)

| Role         | Read | Manage (create, edit, archive, categories, packs) | Price |
| ------------ | ---- | ------------------------------------------------- | ----- |
| OWNER        | yes  | yes                                               | yes   |
| MANAGER      | yes  | yes                                               | yes   |
| STOCK_KEEPER | yes  | yes                                               | no    |
| CASHIER      | yes  | no                                                | no    |
| ACCOUNTANT   | yes  | no                                                | no    |

These match the Slice 1 server mappings. Hidden controls are a convenience only; a `PERMISSION_DENIED` from the
server is shown with the existing wording "This is not available with your access." Tested as a five-role matrix
on both clients and in Playwright (CASHIER read-only).

## Screens

- **Web** (`apps/web/src/catalog/`): the business overview gains a "Business sections" navigation (Overview and
  Catalog; no Team tab). Catalog shows Products and Categories. Products: list with search, status filter and
  Show more; detail; create and edit forms; archive and reactivate; price panel and price history ("Price changes
  (by version)"); packs panel (Active and Retired, add, retire). Categories: list by status, create, rename,
  archive.
- **Mobile** (`apps/mobile/src/catalog/`): the business overview becomes a tablist (Overview and Catalog).
  Products: list with search (name, SKU or typed barcode), status and Show more; detail; create and edit (category
  options read-only, unit choice, track-inventory switch); archive and reactivate; price form. No category or pack
  management and no camera.
- **Hardware back** (mobile): `useHardwareBack` registers a `BackHandler` listener only in the detail, create and
  edit views and removes it on unmount; the list registers none. Tested by listener counts.

## Pagination and search

- Product lists use the API keyset cursor with Show more; a failed page keeps the loaded items.
- Category options load pages of 100, at most 10 pages, stopping on a null cursor, a repeated cursor, an empty
  non-final page or the cap; if the cap or an anomaly stopped loading, the loaded options stay usable and the form
  shows "Some categories could not be listed."
- Search is server-side `q`. Each search or filter change starts a new generation; a response from an older
  generation is ignored.

## Version conflicts

Edits, archive, reactivate, price and category changes send `expectedVersion`. On `VERSION_CONFLICT` there is no
automatic retry: the draft is kept, Reload latest fetches the current resource, and the next submit uses the new
version. Edit diffs are taken against the values the form opened with, so a field the user did not touch never
overwrites someone else's newer value after a reload (see deviations).

## No persistence

The catalog keeps nothing beyond memory: no `localStorage`, `sessionStorage`, IndexedDB, AsyncStorage or secure
store use (guard tests, and Playwright `expectNothingStored` after the flow). Idempotency keys are memory only.

## Playwright

`apps/web/e2e/catalog.spec.ts` (real API and PostgreSQL): an OWNER creates a business, a category and a product
(201 with an `Idempotency-Key` header), searches by SKU (`q=` sent), edits it, sets the price "350.00" (PUT body
`amountMinor` "35000"), sees the history, adds and retires a pack ("24 PIECE"), archives and reactivates, and
nothing is stored in the browser. The OWNER then invites a CASHIER, who accepts in a second browser context and
sees a read-only catalog (no create, edit, archive, price, pack or category controls).

## Tests

| Suite                                  | Result                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| application unit                       | 26 files, 416 passed (currency query tests added)                         |
| shared unit                            | 5 files, 43 passed (currency response schema)                             |
| API unit and compat                    | 6 files, 59 passed (compat route list now 30)                             |
| web (Vitest)                           | 15 files, 192 passed (Slice 3: 9 files, 117)                              |
| mobile (jest-expo)                     | 22 suites, 366 passed (Slice 3: 19 suites, 338)                           |
| database integration                   | 22 files, 289 passed (unchanged)                                          |
| API integration                        | 9 files, 124 passed, 1 skipped (adds "business currency (Slice 4)")       |
| worker integration                     | 9 passed, 1 skipped                                                       |
| Playwright (Chromium)                  | 11 passed                                                                 |

The two skipped tests are the existing SIGTERM tests that skip on Windows.

New web test files: `catalog-api-client`, `business-request`, `catalog-helpers`, `catalog-store`, `catalog`
(component flows) and `credential-boundary`. New mobile suites: `catalog-api-client`, `business-request` and
`catalog` (component flows, BackHandler lifecycle, device headers, source guards).

## Verification

| Check                                                                                                     | Result                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Playwright `pnpm exec playwright test` (`apps/web`, after `pnpm run build`, migrated `tali_test`)         | 11 passed                                    |
| `node tooling/client-bundle-check/src/cli.mjs`                                                            | web, mobile JS, Hermes and app config clean  |
| `pnpm verify` (text integrity, format, build, lint, typecheck, boundaries, all unit tests)                | exit 0 (18 of 18 tasks; failed runs below)   |
| `pnpm test:integration` (alone, after verify, port 57433 overrides)                                       | exit 0 (database 289, worker 9 + 1 skipped, API 124 + 1 skipped) |
| gitleaks v8.30.1 (Docker): repository history; directory scan of the complete current Slice 4 change set; temporary clone with the same change set committed | no leaks (64 changed files; audit and Plan 004 included in the final rescan) |

The local test container is published on `127.0.0.1:57433` through the existing `TALI_POSTGRES_TEST_PORT`
override, with the existing `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` overrides (local-only
credentials from `.env.example`). No repository file was changed for the port.

### Failed runs

- **Playwright run 1: three failures at "Set up your profile", not caused by this code.** The `tali_test`
  database had no tables (Docker Desktop had just been started and the database was unmigrated). Fixed by
  `db:migrate:deploy` (6 migrations; status up to date). No assertion about the catalog was involved.
- **Playwright run 2: catalog spec hit the 30 s whole-test timeout; health spec saw readiness 503.** The trace
  showed every API call taking 0.5 to 1.6 s; the last pending call (add pack) had been pending under 4 s, so no
  per-assertion wait expired. The flow has two users and about forty API round trips, so the spec now sets
  `test.setTimeout(120_000)`; each assertion keeps the default 5 s. Health readiness has a 2 s database ping
  budget; the health spec alone passed four of four and a direct ping took about 200 ms.
- **Playwright run 3: health readiness 503 again, right after the catalog spec.** Free memory was about 1.6 GB of
  16 GB with unrelated local Docker stacks running. With the maintainer's approval, those unrelated containers
  were stopped (`docker stop` only, nothing removed); free memory rose to about 2.1 GB.
- **Playwright run 4: 10 passed; `invitation.spec.ts` hit its 30 s test timeout.** That spec is unchanged in this
  slice and passed in runs 2 and 3. Its trace shows the first readiness call taking 4.9 s and every API call 1 to
  2 s while the catalog spec ran in a parallel worker; the test ran out of budget during the invitee's
  registration, before the accept step, so no invitation assertion failed. Root cause: all specs share one API
  process and one database, and Playwright ran spec files in parallel workers. The configuration now sets
  `workers: 1` (see deviations). Run 5: 11 of 11 passed (invitation 15.2 s, catalog 1.3 min).
- **`pnpm verify`, first run: Prettier, fixed.** `packages/application/src/modules/business/queries.test.ts` (the
  currency tests) was not formatted. Formatted; no rule changed.
- **`pnpm verify`, second run: web Vitest workers did not start (no assertion failed).** Only `@tali/web#test`
  failed: 7 files reported `[vitest-pool]: Failed to start forks worker ... Timeout waiting for worker to respond`;
  the other 8 files ran and passed (76 of 76). About 2.7 GB of 16 GB were free on 8 logical CPUs while turbo ran
  every package's tests in parallel. This is the host-saturation failure recorded in the Slice 3 audit. The
  unchanged retry exited 0 (web 15 files, 192 passed). The Vitest configuration was not changed.
- **Final sequence:** Playwright 11 passed, bundle scan clean, `pnpm verify`
  exit 0, then `pnpm test:integration` exit 0. After the final audit and
  Plan 004 wording changes, the current Slice 4 working tree contained
  64 changed files. Gitleaks v8.30.1 was rerun over repository history,
  a directory copy of all 64 current changed files, and a temporary clone
  with the same 64-file change set committed. All scans found no leaks.
  Formatting and text-integrity checks for the final documentation changes
  also passed.

## Deviations and interpretations

- **Extra files beyond the plan's file list**: web `catalog-context.tsx` (store provider and hook),
  `products-view.tsx` (list, detail and form routing) and `category-label.tsx`; mobile `catalog-context.tsx`
  (provider, `useHardwareBack` and the `Choice` radio). Structure only; no new behaviour.
- **Mobile `money-format.ts` is a copy of the web file.** The clients share no source package for UI helpers;
  both import the same kernel `Money`.
- **`PERMISSION_DENIED` keeps the existing wording** "This is not available with your access."
- **Edit diff semantics**: `updateCommand(product, draft, expectedVersion)` diffs the draft against the values the
  form opened with and takes `expectedVersion` from the reloaded resource. A first implementation diffed against
  the reloaded product, which resent a stale SKU after Reload latest; the VERSION_CONFLICT test caught it, and it
  was fixed on both clients before any gate.
- **Playwright `workers: 1`** in `apps/web/playwright.config.ts`: every spec shares one API process and one
  database; the configuration already had `fullyParallel: false`. This changes scheduling only; no assertion or
  timeout was relaxed. The whole suite takes about 3.4 minutes locally.
- **`catalog.spec.ts` uses a 120 s test timeout**, as above; per-assertion timeouts are the default.
- **Focused web Vitest runs used `--maxWorkers=1`** on this host to avoid the worker startup timeout; the gate
  ran the unchanged configuration.

## Risk

- **Tenancy.** Clients never send a `businessId` other than the selected one in the path; the server resolves and
  verifies membership on every request (Slice 3). `businessRequest` drops any response that arrives after the
  session or selection changed, so data from one business never appears under another. A business `NOT_FOUND` only
  shows a notice; it never switches business automatically.
- **Money.** No float arithmetic: the kernel `Money` converts decimal input to minor units and back; the wire
  carries strings. Formatting is display only; the API stays the authority for amounts.
- **Credentials.** Kept to one request callback; guard tests fail if a credential name or value reaches the store,
  snapshot or catalog components, or if storage or logging is used.
- **Role affordances are UX only.** A client bug could show a control the role lacks; the server answers 403 and
  writes nothing (Slice 3 tests).
- **Readiness under load.** The health readiness ping budget (2 s) is sensitive to host memory pressure; on this
  machine it needed the unrelated Docker stacks stopped. Not changed in this slice.
- **Inventory guard.** `PreInventoryStateReader` is unchanged and its gate tests still pass.
  **SLICE 5 MUST DELETE OR REPLACE PreInventoryStateReader with the real movement/balance-backed implementation.**
