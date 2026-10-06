# Build 2 Slice 2: catalog schema, migration and repositories

- Date: 2026-10-05
- Status: **COMPLETE** (all gates passed after the review correction; interpretations approved by the human review;
  nothing committed).
- Scope: Slice 2 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05). The Prisma
  schema and one additive migration for the six catalog tables; CHECKs, partial uniques, composite tenant FKs and
  grants; `verify-schema.mjs` expectations; the ESLint protected and no-delete lists; the PostgreSQL adapters for the
  five catalog ports from Slice 1; unique-violation translation to `ConflictError`; integration tests.
- Not in this slice: HTTP contracts and controllers (S3), screens (S4), any inventory table, movement, balance,
  stocktake or threshold (S5 and S6), and any cost, valuation, COGS, tax, ledger or `SALE` behaviour.
- Money: the selling price is stored as `BIGINT` minor units with its currency, and the currency is tied to the
  business currency by a foreign key. **No ledger, cost, tax or valuation column or code was added.** Inventory:
  **no inventory table exists** (proved by the migration-chain test, which pins the exact table set).
- Dependencies: **none added**. The lockfile is unchanged. ADR-008 is unchanged.

## Summary

| Area                                                                                                       | Result   |
| ---------------------------------------------------------------------------------------------------------- | -------- |
| Six catalog tables in one additive migration; the nine approved units seeded                                | PASS     |
| `UNIQUE (businesses.id, currency_code)`; both price-currency FKs reference it                               | PASS     |
| Composite `(business_id, x)` FKs, all `ON DELETE RESTRICT`; cross-tenant references rejected               | PASS     |
| CHECKs on every text, status, version, SKU, barcode, price, factor and timestamp rule                       | PASS     |
| Partial uniques: one default variant, ACTIVE barcode, ACTIVE category name, ACTIVE pack name; SKU unique    | PASS     |
| Build 2 single default variant: `product_variants_default_only` CHECK plus the partial default index        | PASS     |
| Grants: no DELETE anywhere; units SELECT only; price history SELECT and INSERT only                         | PASS     |
| `verify-schema.mjs` expectations and drift (migrations vs schema, migrations vs database)                   | PASS     |
| ESLint protected and no-delete lists                                                                        | PASS     |
| Five repositories; every tenant method takes `businessId`; versioned updates; row locks                     | PASS     |
| Unique violations translated to `ConflictError` for listed constraints only                                 | PASS     |
| Concurrent SKU and barcode races (exactly one winner); optimistic collisions                                | PASS     |
| Barcode reuse after archive and the reactivation conflict, through the Slice 1 use cases                    | PASS     |
| No production `VariantInventoryStateReader` (deliberate; see Risk)                                          | PASS     |
| `pnpm verify`                                                                                              | exit 0   |
| `pnpm test:integration`                                                                                    | exit 0   |
| gitleaks (history and changed files)                                                                       | no leaks |

## Schema (`packages/database/prisma/schema/catalog.prisma`)

| Table                    | Key columns and relations                                                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `units_of_measure`       | `code` primary key, `kind`, `scale`. Global reference data with no business.                                                                                                                                                                                    |
| `product_categories`     | `name`, `normalized_name`, `status`, `version`, timestamps. `UNIQUE (business_id, id)`.                                                                                                                                                                         |
| `products`               | `name`, optional `description`, optional `category_id` (FK `(business_id, category_id)`), `status`, `version`, `created_by_membership_id` (FK to the membership in the same business), timestamps.                                                               |
| `product_variants`       | Shares the product ID; FK `(business_id, product_id)`. `is_default`, optional SKU pair, optional barcode pair, `stock_unit_code` (FK to units), `track_inventory`, optional current price pair (FK `(business_id, current_price_currency)` to `businesses (id, currency_code)`), `price_version`, `status`, `version`. |
| `product_packs`          | FK `(business_id, variant_id)`; `name`, `factor_minor`, `status` (ACTIVE or RETIRED). `UNIQUE (business_id, id, variant_id)`.                                                                                                                                    |
| `product_variant_prices` | Append-only history. FK `(business_id, variant_id)`; `amount_minor`, `currency_code` (FK to `businesses (id, currency_code)`), `price_version`, `set_by_membership_id` (same-business FK), optional reason. `UNIQUE (business_id, variant_id, price_version)`. |

- `business.prisma`: `Business` gains the back-relations and `@@unique([id, currencyCode])`; `BusinessMembership`
  gains the creator and price-setter back-relations. No Build 1 column changed.
- Indexes: `(business_id, status)` and `(business_id, name)` on products, `(business_id, status)` on categories,
  `(business_id, product_id)` on variants, `(business_id, variant_id)` on packs.

## Migration (`20261005120000_build2_catalog/migration.sql`)

One additive migration: Prisma-generated DDL, then a reviewed "Custom SQL" section. Nothing is dropped or altered
destructively; the only change to an existing table is the new unique index on `businesses (id, currency_code)`.

- **CHECKs** (all verified by name and canonical definition):
  - units: code `^[A-Z]{1,16}$`, kind COUNT, MASS or VOLUME, scale 0 to 3;
  - categories: name 1 to 60 and trimmed, normalized name 1 to 120, status ACTIVE or ARCHIVED, version positive,
    `updated_at >= created_at`;
  - products: name 1 to 120 and trimmed, description NULL or 1 to 500 with a non-space character, status, version,
    timestamps;
  - variants: `is_default = true` (`product_variants_default_only`; see below), status, version,
    `price_version >= 0`; SKU display and key both present or both absent, display 1 to
    64 and trimmed, key `^[A-Z0-9 ._/-]{1,64}$`; barcode pair, display and key `^[0-9A-Za-z-]{1,64}$`; price shape
    (no price and `price_version = 0`, or amount > 0 with currency and `price_version >= 1`); timestamps;
  - packs: name 1 to 40 and trimmed, factor 2 to 10^9, status ACTIVE or RETIRED, timestamps;
  - prices: amount positive, price version positive, reason NULL or 1 to 500.
- **Partial uniques**: `product_variants_one_default_per_product (business_id, product_id) WHERE is_default`;
  `product_variants_active_barcode_unique (business_id, barcode_normalized) WHERE status = 'ACTIVE' AND
  barcode_normalized IS NOT NULL`; `product_categories_active_name_unique (business_id, normalized_name) WHERE
  status = 'ACTIVE'`; `product_packs_active_name_unique (business_id, variant_id, name) WHERE status = 'ACTIVE'`.
  SKU uniqueness is the full unique `(business_id, sku_normalized)` across every status.
- **Single default variant (review correction)**: ADR-008 section 3.2 gives every Build 2 product exactly one hidden
  default variant. The partial index alone allowed extra `is_default = false` rows, so the migration adds
  `product_variants_default_only CHECK (is_default = true)`. Together: every stored variant is the default, and at
  most one variant row exists per product; the CreateProduct transaction supplies the "at least one". The partial
  index is kept (not replaced by a full unique), so future multi-variant support can drop only the CHECK and still
  keep one default per product. `isDefault` stays in the Prisma model, with a comment saying so.
- **Grants** to `tali_app`: SELECT on `units_of_measure`; SELECT, INSERT, UPDATE on categories, products, variants and
  packs; SELECT, INSERT on `product_variant_prices`. No DELETE on any catalog table.
- **Seed**: PIECE, BOTTLE, SACHET, TIN, PACK (COUNT, 0), KG (MASS, 3), G (MASS, 0), L (VOLUME, 3), ML (VOLUME, 0),
  matching `INITIAL_UNITS_OF_MEASURE` from Slice 1. No container units (CARTON, CRATE, BAG, DOZEN, BUNDLE).

## Schema verification and lint guards

- `verify-schema.mjs`: `PROTECTED_TABLES` gains `units_of_measure` and `product_variant_prices`; `NO_DELETE_TABLES`
  gains the four mutable catalog tables; the six table grant sets; every catalog CHECK; the four partial uniques (now
  also checked by column list); the eight new tenant FKs; four new unique indexes; and a new exact-match check of the
  seeded units. Result: 6 migrations, 18 table grant sets, 110 CHECKs, 5 partial unique indexes, 5 unique indexes,
  16 tenant FKs, 1 reference currency, 9 units of measure.
- `tooling/eslint/index.mjs`: `PROTECTED_MODEL_DELEGATES` gains `unitOfMeasure` and `productVariantPrice`;
  `NO_DELETE_MODEL_DELEGATES` gains `productCategory`, `product`, `productVariant` and `productPack`. No rule was
  weakened.

## Repositories (`packages/database/src/repositories/`)

| Adapter                             | Behaviour                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product-repository.ts`             | `insert` writes product and default variant together. `findByIdForUpdate` locks the product, then its variants (`FOR UPDATE`, parameterized), and restores through the Slice 1 domain (`restoreCatalogProduct`, `Money.ofMinor`). `update` runs `assertCatalogProductTransition`, then a version-predicated `updateMany` on the product and, only when the variant version advanced, on the variant; a count other than 1 is `ConcurrentModificationError`. `findVariantIdBySku`, `findActiveVariantIdByBarcode`. |
| `product-category-repository.ts`    | Locked find; versioned update; `findActiveIdByName` by normalized key. A stored key that does not match the domain-recomputed key fails loudly.                                                                                                                                              |
| `product-pack-repository.ts`        | Locked find; `update` allows only ACTIVE to RETIRED (`assertPackTransition`, then `updateMany WHERE status = 'ACTIVE'`); `hasActivePacks`; exact-name `findActiveIdByName`.                                                                                                                  |
| `product-price-history-repository.ts` | `append` only.                                                                                                                                                                                                                                                                             |
| `unit-reference-repository.ts`      | `findByCode` re-validates the row through `defineUnit`.                                                                                                                                                                                                                                      |

- Every tenant method filters by `businessId`; another business's record is not found.
- A stored product that breaks the one-default-variant invariant throws rather than being silently repaired. With
  the CHECK and the partial index, the only such state the database still admits is a product with no variant row.
- `DatabaseRepositories` gains `products`, `productCategories`, `productPacks`, `productPriceHistory` and `units`.
  It deliberately has **no `VariantInventoryStateReader`**.
- `tenancy-fixtures.ts`: the catalog tables are truncated between tests, children first; `units_of_measure` is
  reference data and is never truncated.

## Unique-violation translation (`src/errors/unique-violations.ts`)

- `uniqueViolationConstraint(error)` returns the constraint name only for SQLSTATE 23505. It reads both shapes seen
  in practice: the adapter-pg cause (`constraint.index`) and a `pg` `DatabaseError` (`constraint` as a string).
- `translatingUniqueViolations(conflicts, write)` throws `ConflictError(message)` only for constraint names listed
  by the adapter (`Object.hasOwn`, so inherited keys never match). Every other error, including other unique
  violations such as a primary key, is rethrown unchanged. The `ConflictError` carries no cause, so no SQL detail or
  value reaches the caller.
- Listed constraints: the SKU key, the ACTIVE barcode index, the ACTIVE category name index, the ACTIVE pack name
  index and the price-version key. Messages name the field, never the value.

## Tests

| Suite                                                         | Result                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| database unit                                                 | 3 files, 19 passed (new: `unique-violations` 6)                                                                                                              |
| `t-catalog-constraints.integration.test.ts` (new)             | 30 passed: seeded units exact and read-only, privileges as `tali_app` (SQL and Prisma), every CHECK, unique and cross-tenant FK, currency FK mismatch, single default variant |
| `u-catalog-repositories.integration.test.ts` (new)            | 27 passed: round trips, lookups and tenant scoping, versions, locks, conflicts, races, barcode lifecycle, one hidden default variant |
| `e-custom-migration.integration.test.ts` (updated)            | 12 passed: the committed-migration list and the exact table set now include the catalog                                                                       |
| database integration (all)                                    | 21 files, 278 passed                                                                                                                                         |
| worker integration; API integration                           | 9 passed, 1 skipped; 97 passed, 1 skipped                                                                                                                    |
| domain 223, application 404, API 53, integrations 109, shared 28, config 37, worker 11, text-integrity 12, client-bundle-check 8 | passed (unchanged)                                                                                                     |
| web (Vitest); mobile (jest-expo)                              | 9 files, 117 passed; 19 suites, 338 passed                                                                                                                   |

Constraint tests use business A in NGN and business B in KES, and assert the SQLSTATE of each rejected write.

### Single default variant

- A product with its default variant is stored, with exactly one `is_default = true` row.
- A variant with `is_default = false` is rejected with 23514 (`product_variants_default_only`): as the application
  role for a product with or without a default, as the owner, and on `UPDATE ... SET is_default = false`.
- A second `is_default = true` variant for the same product is rejected with 23505 by
  `product_variants_one_default_per_product`, and the product still has one variant row.
- The repository round trip restores exactly the one hidden default variant (`isDefault: true`, linked to the product),
  further variant inserts are refused by the CHECK and the index, and the reload is unchanged. A product stored
  with no variant row fails loudly on load.

### Concurrency

A `race()` helper runs two writers in independent transactions that both pass their application-level checks, then
holds the first open while the second reaches the database:

- two creates with one SKU: exactly one commits, the other is `ConflictError`;
- two creates with one ACTIVE barcode: exactly one commits, the other is `ConflictError`;
- two updates from the same product version, and from the same category version: one commits, the other is
  `ConcurrentModificationError`.

Lock tests prove `findByIdForUpdate` holds the product, variant and category rows until the transaction ends (a
second writer times out as `ConcurrentModificationError`; an owner `NOWAIT` attempt is 55P03).

### Barcode lifecycle

Through the real Slice 1 use cases (CreateProduct, ArchiveProduct, ReactivateProduct, with the audit recorder and
keyed idempotency over PostgreSQL): product A is created with barcode `4006381333931`; A is archived; product B is
created with the same barcode; reactivating A is `CONFLICT`, and A's status, version and the audit count are
unchanged while the barcode resolves to B. A repository-level reactivation that bypasses the use-case pre-check is
rejected by the database index as `ConflictError`, and A is unchanged.

## Containment and boundaries

- Prisma stays inside `packages/database`: the existing containment test passes, and no app constructs
  `DatabaseRepositories` itself.
- `pnpm run boundaries`: no violations (521 modules, 2248 dependencies). No rule was changed.
- Raw SQL is parameterized tagged templates only (`$queryRaw`); no string-built SQL.

## Verification

| Check                                                                                                                       | Result                                  |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `prisma format`, `prisma validate`, `prisma generate`                                                                       | ok                                      |
| `migrate deploy` and `migrate status` on the test database (port 57433)                                                     | 6 migrations, up to date                |
| `verify-schema.mjs`; `check-drift.mjs` (shadow database on the development container)                                       | passed; both comparisons ok             |
| `pnpm verify` (text integrity, format, build, lint, typecheck, boundaries, all unit tests)                                  | exit 0 (18 of 18 tasks; see below)      |
| `pnpm test:integration` (run after verify, alone, with the port 57433 overrides)                                            | exit 0 (database 275, worker 9 + 1 skipped, API 97 + 1 skipped) |
| After integration teardown: `migrate status`, `verify-schema.mjs`, `check-drift.mjs`                                        | up to date; passed; both ok             |
| gitleaks v8.30.1 (Docker): `git` over history (20 commits); `git` over a temporary clone with the 19 changed and untracked files committed (21 commits); `dir` over a copy of those files with `.gitleaks.toml` | no leaks |
| After the review correction: test container recreated from empty (tmpfs), `migrate deploy` of all 6 migrations, `migrate status`, `verify-schema.mjs` (110 CHECKs), `check-drift.mjs` | up to date; passed; both ok |
| After the review correction: focused catalog integration tests                                                              | 57 passed (constraints 30, repositories 27) |
| After the review correction: `pnpm verify`                                                                                   | exit 0 on the first run (18 of 18 tasks) |
| After the review correction: `pnpm test:integration` (alone, after verify)                                                   | exit 0 on the first run (database 278, worker 9 + 1 skipped, API 97 + 1 skipped) |
| After the review correction: gitleaks `git` history, temporary clone with the changed files, `dir` over those files          | no leaks |

The local test container is published on `127.0.0.1:57433` through the existing `TALI_POSTGRES_TEST_PORT` override,
and the existing `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` overrides point there (local-only credentials
from `.env.example`). No repository file was changed for the port.

### Failed runs

- **`pnpm verify`, first run: web Vitest workers did not start (no assertion failed).** Only `@tali/web#test`
  failed: 7 of its 9 files failed before running with `[vitest-pool]: Failed to start forks worker ... Timeout
  waiting for worker to respond`; the 2 that started passed (9 tests); every other package passed, including the new
  database unit tests. 2.6 GB of 15.7 GB were free. This is the host-saturation failure recorded in
  `docs/audits/build-1-slice-3.md` and `docs/audits/build-2-slice-1.md`. The unchanged retry exited 0 with 18 of 18
  tasks (web 117, mobile 338). The Vitest configuration was not changed.
- **`pnpm test:integration`, first run: two assertion failures, fixed.** The existing migration-chain test pinned
  the committed migrations and the exact table set to Build 1, so it failed on the new migration and the six new
  tables. This was a real failure, not load: the test was updated to list `20261005120000_build2_catalog` and the six
  catalog tables. The exact table set also proves that no inventory table exists. Prettier then required a format
  fix to that file (the next `pnpm verify` stopped at `format:check`). After formatting, `pnpm verify` and then
  `pnpm test:integration` both exited 0.

## Deviations and interpretations

The human review (2026-10-05) **approved** these interpretations:

- **Normalized category key bound of 1 to 120 characters**, to accommodate lower-case normalization expansion (for
  example the Turkish dotted capital I), while the merchant-facing category name remains capped at 60.
- **`verify-schema.mjs` checking partial unique indexes by column list** as well as by name and predicate. The
  existing location index expectation gained `columns: "business_id"`. This tightens the check; nothing was relaxed.
- **The generalized ESLint no-delete message**: "Build 1 records..." became "These records are never hard-deleted.
  Change their status through an audited use case.", because the list now covers catalog records. The rule is
  unchanged.
- **ProductRepository refusing a variant change unless the variant version advances** when variant state changes,
  so a domain bug can never write a variant change without a version.
- **The migration-chain test update** (`e-custom-migration.integration.test.ts`) to include the Slice 2 migration
  and the six catalog tables.
- **Narrow unique-violation translation**: only SQLSTATE 23505 on a known, listed constraint becomes
  `ConflictError`; unrelated database errors are rethrown.

Also recorded:

- **`UNIQUE (business_id, id, variant_id)` on packs**, as the slice instructions require, is the target for ADR-008's
  future inventory-movement pack FK (a movement may only use a pack of its own variant). Nothing references it yet.
- **Review correction: `product_variants_default_only`.** The review required the database to make extra
  non-default variant rows unpersistable in Build 2. The CHECK was added to this still-uncommitted Slice 2
  migration (never merged or deployed), not as a second corrective migration; no historical migration was changed.
  Two tests that had inserted a non-default variant were rewritten to prove it is now rejected.

## Risk

- **Tenancy.** Every tenant table has `UNIQUE (business_id, id)`, and every reference to a business-owned row is a
  composite FK including `business_id`, so a cross-tenant reference is rejected by PostgreSQL (tested for every FK,
  including the price currency against another business's currency). Every repository method filters by the
  context business.
- **Money.** Prices are `BIGINT` minor units with an explicit currency, tied by FK to the business currency, and
  restored as `Money`; the 2^63 - 1 ceiling round-trips exactly. No float arithmetic.
- **Deletion.** No DELETE grant on any catalog table, and ESLint forbids `delete` on the catalog delegates. Every FK
  is `ON DELETE RESTRICT`. Price history is insert-only at both the grant and the adapter level.
- **Inventory guard source (approved S3 wiring decision; S5 replacement obligation).** `DatabaseRepositories`
  deliberately has no production `VariantInventoryStateReader`, and none is implemented in Slice 2. The human review
  approved this wiring for Slice 3: while the inventory schema does not exist, the API composition may use a clearly
  named temporary adapter such as `PreInventoryStateReader` returning `hasMovements = false` and
  `hasNonZeroBalance = false`. That is truthful only because no inventory tables or use cases exist before S5. It
  must not live in `packages/database` as though it were persisted state, and it must be visibly temporary and
  pre-inventory. **Slice 5 MUST delete or replace it** with the real inventory-backed reader, which reads movements
  and balances in the same transaction.
- **Unique translation scope.** Only listed constraint names become `ConflictError`. A constraint renamed in a later
  migration would surface as an unexpected error rather than a conflict; the integration tests pin the names.
