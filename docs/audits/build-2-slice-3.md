# Build 2 Slice 3: catalog API and shared contracts

- Date: 2026-10-05
- Status: **COMPLETE** (all gates passed; pending human review; nothing committed).
- Scope: Slice 3 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05). Shared Zod
  contracts (`quantity.ts`, `catalog.ts`); catalog read use cases and additive repository read methods; the HTTP
  controllers for products, categories, packs, prices and units; composition of the Slice 1 mutations and the new
  reads; the temporary `PreInventoryStateReader`; API end-to-end tests.
- Not in this slice: catalog clients (S4), any inventory table, movement, balance, stocktake or threshold (S5 and S6),
  and any cost, valuation, COGS, tax, ledger or `SALE` behaviour.
- Money: prices travel as `{ "amountMinor": "<integer string>", "currency": "<ISO 4217>" }`; a JSON number is a 400.
  **No ledger, cost, tax or valuation field or code was added.** Inventory: **no inventory table, use case or route
  exists** (proved by the gate tests below).
- Dependencies: **none added**. The lockfile is unchanged. ADR-008 is unchanged. No schema or migration change (the
  Slice 2 schema is used as is).

## Summary

| Area                                                                                                  | Result   |
| ----------------------------------------------------------------------------------------------------- | -------- |
| Shared `quantity.ts` and `catalog.ts`: strict objects, string minor units, no normalized keys          | PASS     |
| Seven read use cases, all `product:read`, no audit and no idempotency                                 | PASS     |
| Additive repository read methods; every tenant method takes `businessId`                              | PASS     |
| Search: case-insensitive literal name containment, normalized SKU, GTIN-equivalent barcode             | PASS     |
| 17 catalog routes, all behind the three business-scoped guards                                        | PASS     |
| Explicit response mappers, parsed with the shared schemas before sending                              | PASS     |
| Ten Slice 1 mutations composed in `api-services.ts`; controllers never touch adapters                 | PASS     |
| `PreInventoryStateReader`: temporary, no I/O, UpdateProduct only, gated against inventory persistence | PASS     |
| 401, 403 (wrong role, nothing written), cross-tenant 404 (nothing changed)                            | PASS     |
| 400 for unknown fields, invalid statuses, malformed pages, JSON-number money and factors              | PASS     |
| Keyed create 201, replay 201 with `Idempotent-Replayed: true`, key reuse 409                          | PASS     |
| Route guard compat list updated (29 business routes) and a no-inventory-route test added              | PASS     |
| `pnpm verify`                                                                                         | exit 0   |
| `pnpm test:integration`                                                                               | exit 0   |
| gitleaks (history and changed files)                                                                  | no leaks |

## Shared contracts (`packages/shared/src/contracts/http/`)

- `quantity.ts`: `UnitCodeWireSchema` (`^[A-Z]{1,16}$`); `QuantityMinorStringSchema` (`^-?(0|[1-9][0-9]{0,15})$`,
  `-0` rejected, absolute value at most 10^15); `QuantityWireSchema` `{ quantityMinor, unit }`, for example
  `{"quantityMinor":"1500","unit":"KG"}`. Defined for S5; no Slice 3 route sends or returns a quantity.
- `catalog.ts`:
  - enums `CatalogStatus` (ACTIVE, ARCHIVED), `PackStatus` (ACTIVE, RETIRED) and `UnitKind` (COUNT, MASS, VOLUME);
    no `ALL` value;
  - path schemas for business, product, category and pack IDs;
  - list queries: `ProductListQuerySchema` (page, `status`, `q` of 1 to 480 characters), category and pack list
    queries; each is the strict `PageQuerySchema` extended, so unknown query keys are rejected;
  - requests: CreateProduct, UpdateProduct (at least one editable field; nullable optional fields clear), Archive and
    Reactivate product, SetSellingPrice, CreateCategory, UpdateCategory, ArchiveCategory and AddPack;
    `expectedVersion` is an integer of at least 1; `factorMinor` is a string `^[1-9][0-9]{0,18}$`;
  - responses: Product (flattened default variant, explicit `null` for absent optional fields), Products, Category,
    Categories, Pack, Packs, PriceHistoryEntry, PriceHistory, Unit and Units.
- Every object schema is strict. No response carries `businessId`, a normalized key, `isDefault`, a variant object,
  a cost or an on-hand quantity.

## Routes

All under `v1/businesses/:businessId`, behind `AuthenticationGuard`, `BusinessContextGuard` and
`DeviceContextGuard` (`BUSINESS_SCOPED_GUARDS`).

| Method and path                              | Use case                    | Permission       | Success                         |
| -------------------------------------------- | --------------------------- | ---------------- | ------------------------------- |
| `GET products`                               | ListProducts                | `product:read`   | 200 `{ items, nextCursor }`     |
| `POST products`                              | CreateProduct (keyed)       | `product:manage` (+ `product:price` for an initial price) | 201; replay 201 + header |
| `GET products/:productId`                    | GetProduct                  | `product:read`   | 200                             |
| `PATCH products/:productId`                  | UpdateProduct               | `product:manage` | 200 (no-op 200)                 |
| `POST products/:productId/archive`           | ArchiveProduct              | `product:manage` | 200 (no-op 200)                 |
| `POST products/:productId/reactivate`        | ReactivateProduct           | `product:manage` | 200 (no-op 200)                 |
| `PUT products/:productId/price`              | SetSellingPrice             | `product:price`  | 200 (no-op 200)                 |
| `GET products/:productId/prices`             | ListProductPriceHistory     | `product:read`   | 200 `{ items, nextCursor }`     |
| `GET products/:productId/packs`              | ListProductPacks            | `product:read`   | 200 `{ items, nextCursor }`     |
| `POST products/:productId/packs`             | AddPack (keyed)             | `product:manage` | 201; replay 201 + header        |
| `POST packs/:packId/retire`                  | RetirePack                  | `product:manage` | 200 (no-op 200)                 |
| `GET categories`                             | ListCategories              | `product:read`   | 200 `{ items, nextCursor }`     |
| `POST categories`                            | CreateCategory (keyed)      | `product:manage` | 201; replay 201 + header        |
| `GET categories/:categoryId`                 | GetCategory                 | `product:read`   | 200                             |
| `PATCH categories/:categoryId`               | UpdateCategory              | `product:manage` | 200 (no-op 200)                 |
| `POST categories/:categoryId/archive`        | ArchiveCategory             | `product:manage` | 200 (no-op 200)                 |
| `GET catalog/units`                          | ListUnitsOfMeasure          | `product:read`   | 200 `{ items }`                 |

These are 17 routes; with the 12 Build 1 business-scoped routes, the compat test's exact list now has 29. Errors: 400 `VALIDATION_FAILED` or
`IDEMPOTENCY_KEY_REQUIRED`; 401; 403 `PERMISSION_DENIED`; 404 `NOT_FOUND` (cross-tenant, unknown or malformed ID);
409 `VERSION_CONFLICT`, `CONFLICT` or `IDEMPOTENCY_KEY_REUSED`.

Roles: every role reads. OWNER and MANAGER hold `product:manage` and `product:price`; STOCK_KEEPER holds
`product:manage` only; CASHIER and ACCOUNTANT are read-only. These are the Slice 1 mappings, unchanged.

## Read use cases (`packages/application/src/modules/catalog/queries.ts`)

GetProduct, ListProducts, GetCategory, ListCategories, ListProductPacks, ListProductPriceHistory and
ListUnitsOfMeasure. Each checks `product:read` on the server-resolved `BusinessContext`, validates the page and
filters, and reads inside `unitOfWork.run` with the context `businessId`. Reads write no audit record and take no
idempotency key.

- A malformed product or category ID is `NotFoundError`, the same answer as an unknown or foreign ID.
- Packs and price history first resolve the product in the context business, then read by its default variant ID; a
  foreign product is 404.
- Status: products and categories default to ACTIVE, packs to ACTIVE; ARCHIVED and RETIRED are explicit; any other
  value is a `ValidationError`.

## Repository read methods (additive; Slice 2 methods unchanged)

| Port and adapter                    | New methods                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| ProductRepository                   | `findById(scope, businessId, productId)`; `list(scope, businessId, { status, search }, page)` |
| ProductCategoryRepository           | `findById(scope, businessId, categoryId)`; `list(scope, businessId, status, page)`         |
| ProductPackRepository               | `listForVariant(scope, businessId, variantId, status, page)`                               |
| ProductPriceHistoryRepository       | `listForVariant(scope, businessId, variantId, page)` (still no update or delete)           |
| UnitReferenceRepository             | `listAll(scope)` ordered by code, re-validated through `defineUnit`                        |

Lists use the existing keyset pagination (`keysetArgs`, `toPage`): ordered by ID (UUIDv7, so creation order), with
an opaque `nextCursor`. Every row is restored through the Slice 1 domain (`restoreCatalogProduct`, `Money.ofMinor`).

## Search

`q` is trimmed, NFC-normalized, rejected if it contains a lone surrogate, and must be 1 to 120 code points (the wire
limit of 480 characters bounds the raw input). It matches, within the context business and the requested status:

- **name containment**, case-insensitive, with `\`, `%` and `_` escaped (`escapeLikePattern`): Prisma's
  `contains` does not escape LIKE wildcards, which a test proved before the escaping was added;
- **SKU**: the normalized SKU key (`parseSku`), exact;
- **barcode**: the normalized barcode key (`parseBarcode`), exact, so GTIN-8/12/13/14 forms of one GTIN match each
  other. A non-GTIN merchant barcode keeps its case (Slice 1 domain rule), so its search is case-sensitive.

A `q` that is not a valid SKU or barcode still searches by name and never fails.

## Response mapping (`apps/api/src/http/catalog-response-mappers.ts`)

Explicit field-by-field mappers. Money uses `toMinorUnitsString()`, pack factors `factorMinor.toString(10)`, SKU and
barcode their display `value`; absent optional fields are `null`; timestamps are ISO strings. Each response is
parsed with its shared schema before sending, so an unexpected field is a server error, never a leak. The
integration suite checks every response body recursively for forbidden keys and non-string money, factors or
quantities.

## Composition (`apps/api/src/composition/api-services.ts`)

`ApiServices` exposes use cases only: the ten Slice 1 mutations (CreateProduct, UpdateProduct, ArchiveProduct,
ReactivateProduct, SetSellingPrice, CreateCategory, UpdateCategory, ArchiveCategory, AddPack, RetirePack) and the
seven reads. They are composed from `DatabaseRepositories`, business-scoped keyed idempotency, the request hasher,
the audit recorder, the ID generator and the clock. The four catalog controllers are registered in `AppModule`; they
parse input with the shared schemas, take the guard-resolved `BusinessContext`, call one use case and map the
result. No controller imports `@tali/database`, Prisma, `pg` or a repository (boundaries check and compat test).

## PreInventoryStateReader

`apps/api/src/composition/pre-inventory-state-reader.ts` implements `VariantInventoryStateReader` with
`stateOf()` returning a frozen `{ hasMovements: false, hasNonZeroBalance: false }`. It does no I/O (its test passes a
scope that throws on any access) and is not in `packages/database`. It is composed exactly once, into UpdateProduct
(which uses it to allow a stock unit change only before inventory exists). It is truthful only because no inventory
table or use case exists.

**SLICE 5 MUST DELETE OR REPLACE PreInventoryStateReader with the real movement/balance-backed implementation.**

Gate tests (`pre-inventory-state-reader.test.ts`) fail if:

- any Prisma model, `@@map` or migration `CREATE TABLE` matches
  `inventor|movement|balance|stock.?take|stock.?count|goods.?receipt|purchase.?receipt`;
- an inventory module directory exists in the domain or application packages, or a file with such a name exists in
  `apps/api/src` or `apps/worker/src` (other than the reader's own files);
- the reader is used anywhere but that one UpdateProduct composition.

The compat test also asserts that no route matching `inventor|stock|movement|balance|count` is mounted. If any
inventory persistence or use case appears before the reader is replaced, these tests fail the gate.

## Validation and idempotency

- Unknown body and query fields, `status=ALL`, a lower-case status, a pack status on categories, `limit` 0 or 101, a
  malformed cursor, an empty or whitespace `q` and a repeated `q` are 400. A client `businessId` in the body is 400.
- A JSON-number `amountMinor` or `factorMinor` is 400, and so is a string `expectedVersion`; there is no coercion.
- Unit codes with bad syntax are 400 at the boundary; a well-formed unknown unit (CARTON) is 400 from the application.
- Keyed creates require `Idempotency-Key` (400 `IDEMPOTENCY_KEY_REQUIRED`). A replay returns the stored result with
  201 and `Idempotent-Replayed: true`; the same key with a different command is 409 `IDEMPOTENCY_KEY_REUSED`.
- State-setting operations take `expectedVersion`: a stale version is 409 `VERSION_CONFLICT`, even for a no-op.

## Tests

| Suite                                                      | Result                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| application unit                                           | 26 files, 413 passed (new: `queries.test.ts` 9)                                                                                                |
| shared unit                                                | 5 files, 42 passed (new: `quantity.test.ts` 4, `catalog.test.ts` 10)                                                                           |
| API unit and compat                                        | 6 files, 59 passed (new: `pre-inventory-state-reader.test.ts` 4; compat gains the no-inventory-route test and the 29-route list)              |
| `v-catalog-reads.integration.test.ts` (database, new)      | 11 passed: tenancy, status filters, pagination, literal name search, SKU, GTIN and barcode case, status-scoped search, categories, packs, price history (2^63 - 1 and reason), units |
| `u-catalog-repositories.integration.test.ts` (updated)     | price history adapter keys now `append` and `listForVariant` (still no update or delete)                                                      |
| `catalog-api.integration.test.ts` (API, new)               | 23 passed: 401 on every route, all roles read, 403 writes nothing, cross-tenant 404 changes nothing, validation, malformed IDs, units, JSON numbers, idempotency, products, prices, categories, packs, search, units, pagination, wire safety |
| database integration (all)                                 | 22 files, 289 passed                                                                                                                           |
| API integration (all); worker integration                  | 9 files, 120 passed, 1 skipped; 9 passed, 1 skipped                                                                                            |
| domain 223, integrations 109, config 37, worker 11, database unit 19, text-integrity 12, client-bundle-check 8 | passed (unchanged)                                                                         |
| web (Vitest); mobile (jest-expo)                           | 9 files, 117 passed; 19 suites, 338 passed                                                                                                     |

In the tenancy tests, business B's owner is denied every read and write of A's
products, categories, packs and prices with 404, and the catalog snapshot is unchanged afterwards.

## Containment and boundaries

- `pnpm run boundaries`: no violations (536 modules, 2361 dependencies). No rule was changed.
- Prisma stays inside `packages/database`; the API reaches catalog data only through `ApiServices` use cases.
- Search terms reach PostgreSQL only as Prisma parameters; no SQL is built from input.

## Verification

| Check                                                                                                     | Result                                                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm verify` (text integrity, format, build, lint, typecheck, boundaries, all unit tests)                | exit 0 (18 of 18 tasks; failed runs below)               |
| `pnpm test:integration` (alone, after verify, port 57433 overrides)                                       | exit 0 (database 289, worker 9 + 1 skipped, API 120 + 1 skipped) |
| gitleaks v8.30.1 (Docker): `git` over history; `git` over a temporary clone with the changed and new files committed; `dir` over a copy of those files with `.gitleaks.toml` | no leaks |

The local test container is published on `127.0.0.1:57433` through the existing `TALI_POSTGRES_TEST_PORT` override,
with the existing `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` overrides (local-only credentials from
`.env.example`). No repository file was changed for the port.

### Failed runs

- **`pnpm verify`, first run: three ESLint errors, fixed.** `catalog.test.ts` returned void expressions from arrow
  shorthands and had an unused destructured variable. Fixed in the test; no rule was changed.
- **`pnpm verify`, second run: web Vitest workers did not start (no assertion failed).** Only `@tali/web#test`
  failed: all 9 files failed before running with `[vitest-pool]: Failed to start forks worker ... Timeout waiting
  for worker to respond`. About 3.0 GB of 16 GB were free while turbo ran the API, integrations and database suites
  in parallel; no web file changed in this slice. This is the host-saturation failure recorded in earlier audits.
  The web suite then passed alone (117), and the unchanged full retry exited 0. The Vitest configuration was not
  changed.
- **`pnpm test:integration`, first run: four failures, three fixed as real test bugs.**
  - Three catalog API tests failed with `ECONNREFUSED`, and reproduced when the API suite ran alone. Cause: those
    tests built an array of Supertest requests up front and awaited them one by one. Supertest calls `listen(0)` on
    the shared Nest HTTP server when each request is constructed and closes it when a request ends, so the earlier
    requests pointed at a dead port. Fixed by building each request lazily. Not load.
  - The startup test "refuses a deployed environment whose Cognito configuration is incomplete or invalid" timed out
    at 20 s spawning a child process. It passed in the alone run and in the final run with no change.
- **Catalog API suite run alone after the fix: 23 of 23 failed, not caused by this code.** The PostgreSQL log shows
  deadlocks in that 16-second window between this suite's `TRUNCATE` and two other long-lived sessions inserting
  `external_identities` then `platform_audit_records` (the registration path). This suite registers users only after
  its own reset completes, so a second, external test process was using `tali_test` at the same time; free memory
  fell to 0.24 GB in the same window. No such session remained afterwards. The unchanged suite then passed (23), and
  the full `pnpm test:integration` exited 0.
- **Final sequence, `pnpm test:integration` after the final `pnpm verify`: one worker startup timeout (not an
  assertion on behaviour).** `worker-process` "fails fast with exit code 1 on invalid configuration" timed out at
  20 s waiting for its first spawned `node dist/main.js` to exit; it started straight after `pnpm verify` had
  finished building and testing every package. No worker file changed in this slice. Measured afterwards, the same
  invalid-configuration start exits with code 1 in about 1.4 s. The unchanged retry of `pnpm test:integration`
  exited 0 (that file took 4.9 s).
- Final tree: `pnpm verify` exit 0, then `pnpm test:integration` exit 0 (the retry above). Only this audit's
  failed-runs text changed afterwards; formatting and text integrity were re-checked.

## Deviations and interpretations

- **Units are not paginated**: `GET catalog/units` returns `{ items }` without `nextCursor`, because the approved set
  is fixed and small (nine units). `limit` and other query keys are rejected.
- **GetCategory** is an additional read use case, backing `GET categories/:categoryId`.
- **Mutation responses** return the resource body directly (for example a `ProductResponse`), not wrapped.
- **Price history order** is ascending by ID (UUIDv7, so the order prices were set).
- **Shared query type names** are `ProductListParams`, `CategoryListParams` and `PackListParams`, to avoid clashing
  with the application's `ProductListQuery`.
- **`page()` exported** from the in-memory tenancy store (test support only), so the in-memory catalog store pages
  the same way.
- **`readCatalogSnapshot()`** added to `@tali/database/testing` (test helper only), used to prove that denied and
  cross-tenant requests change nothing.
- **Price history append-only assertion** in `u-catalog-repositories` now lists exactly `append` and
  `listForVariant`; it still proves there is no update or delete method.
- **Slice 1 allows clearing the SKU** with `sku: null`; the API passes it through (tested).

## Risk

- **Tenancy.** Every read and write uses the guard-resolved `BusinessContext`; a client `businessId` in the body is
  rejected, and a path `businessId` is honoured only after membership is verified. Every repository read filters by
  the context business, and nested product reads (packs, prices) resolve the product in that business first. Tested
  for every route with another business's owner.
- **Money.** Prices are string minor units on the wire, parsed into `Money` at the boundary, and 2^63 - 1 round-trips
  exactly. JSON numbers are rejected. No float arithmetic, no cost, tax or valuation.
- **Search performance.** ADR-008 mentions an index supporting name search; containment (`ILIKE '%term%'`) cannot use
  the existing `(business_id, name)` B-tree index, so name search scans the business's products. Acceptable at pilot
  catalog sizes; a trigram or normalized-prefix index would need a schema change in a later slice. No schema change
  was made here.
- **Merchant barcode case.** Non-GTIN barcodes are case-preserved by the domain, so a search with different case
  does not find them. This follows the Slice 1 rule; GTINs are digits and unaffected.
- **Inventory guard source.** `PreInventoryStateReader` always reports no movements and a zero balance. That is true
  today and enforced by the gate tests above.
  **SLICE 5 MUST DELETE OR REPLACE PreInventoryStateReader with the real movement/balance-backed implementation.**
