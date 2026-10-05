# Build 2 Slice 1: catalog domain and application

- Date: 2026-10-05
- Status: **COMPLETE** (all gates passed; awaiting human review, nothing committed).
- Scope: Slice 1 of `docs/plans/004-build-2-catalog-inventory.md`, under ADR-008 (ACCEPTED 2026-10-05) and ADR-006.
  The `Quantity` kernel value object and unit reference model; the catalog domain (Product with a hidden default
  variant, Category, Pack, price history); SKU and barcode/GTIN normalization; ports and in-memory fakes; ten use
  cases; three permissions; the `integerString` audit field kind; ten audit actions.
- Not in this slice: Prisma schema, migrations and repositories (S2), HTTP contracts and controllers (S3), web and
  mobile screens (S4), inventory movements, balances, stocktakes and stock thresholds (S5 and S6), and any cost,
  valuation, COGS, tax, ledger or `SALE` behaviour.
- Money: the selling price is `Money` in the business currency, stored as integer minor units. **No ledger, cost,
  tax or valuation code was added.** Inventory: **no stock changes**; only the inventory facts that guard catalog
  edits are read, through a port.
- Dependencies: **none added**. The lockfile is unchanged. ADR-008 and ADR-006 are unchanged.

## Summary

| Area                                                                                                   | Result |
| ------------------------------------------------------------------------------------------------------ | ------ |
| `Quantity` (bigint minor quantity plus unit; no rounding; bound 10^15; JSON serialization rejected)     | PASS   |
| Units: `UnitCode`, kinds COUNT/MASS/VOLUME, scale 0 to 3, the nine reviewed initial units               | PASS   |
| Product with exactly one hidden default variant; Category; Pack; append-only price history             | PASS   |
| SKU and barcode/GTIN normalization, including seeded generated cases                                   | PASS   |
| Optimistic versioning; no-ops change nothing and write no audit record                                 | PASS   |
| SetSellingPrice in the business currency only (NGN, KES, JPY with 0 digits, KWD with 3 digits)         | PASS   |
| Ten use cases: three keyed creates, seven state-setting with `expectedVersion` (RetirePack: see below) | PASS   |
| Permissions `product:read`, `product:manage`, `product:price`; Build 1 mapping unchanged               | PASS   |
| `auditField.integerString`; ten catalog audit actions; registry redaction test                          | PASS   |
| Tenant isolation (another business's IDs are `NOT_FOUND`) for every mutation                           | PASS   |
| `pnpm verify`                                                                                          | exit 0 |
| `pnpm test:integration`                                                                                | exit 0 |
| gitleaks (history and changed files)                                                                   | no leaks |

## Quantity and units (`packages/domain/src/kernel/`)

- `unit.ts`: `UnitCode` (`^[A-Z]{1,16}$`), `UNIT_KINDS` (COUNT, MASS, VOLUME), `MAX_UNIT_SCALE = 3`, and
  `defineUnit(code, kind, scale)` returning a frozen `UnitDefinition`. A unit is reference data; there is no
  conversion between units (ADR-008 section 4).
- `quantity.ts`: `Quantity` holds a `bigint` minor quantity and a `UnitCode`.
  - Construction: `ofMinor`, `zero`, `fromMinorUnitsString` (base-10 integer string, no `-0`, no leading zeros) and
    `fromDecimalString(text, unit)`, which accepts at most `unit.scale` fraction digits. **Excess precision is
    rejected, never rounded.** `|minor| <= 10^15` (`MAX_QUANTITY_MINOR`), else `QUANTITY_OUT_OF_RANGE`.
  - Arithmetic: `add`, `subtract`, `negate`, `abs`, `multiply(bigint)`. Mixing units (including KG with G) throws
    `QUANTITY_UNIT_MISMATCH`; results outside the bound throw.
  - Comparison and formatting: `isZero`, `isPositive`, `isNegative`, `sign`, `compare`, `equals`,
    `toMinorUnitsString`, `toDecimalString(unit)`.
  - `toJSON` throws `QUANTITY_NOT_SERIALIZABLE`, so a quantity can never silently become a JSON number.
  - Error messages do not echo the rejected input.
- `surface.test.ts` pins the new kernel exports and checks the `Quantity` prototype against the forbidden-concept
  list (no cost, valuation, conversion or rounding methods).
- Tests (`quantity.test.ts`): construction and bounds, arithmetic, unit mismatch, parsing, formatting, JSON rejection,
  and seeded generated cases (round trips of minor and decimal strings for scales 0 to 3, excess precision rejected,
  addition and subtraction inverse and commutative, every generated out-of-bounds value rejected). A seeded
  generator is used because `fast-check` is not a declared dependency.

## Catalog domain (`packages/domain/src/modules/catalog/`)

- `ids.ts`: branded `ProductId`, `ProductVariantId`, `ProductCategoryId`, `ProductPackId`, `ProductPriceId`.
- `units.ts`: `INITIAL_UNITS_OF_MEASURE` = PIECE, BOTTLE, SACHET, TIN, PACK (COUNT, 0), KG (MASS, 3), G (MASS, 0),
  L (VOLUME, 3), ML (VOLUME, 0). CARTON, CRATE, BAG, DOZEN and BUNDLE are pack names, not units.
- `product.ts`:
  - `CatalogProduct = { product, variant }`. The variant is the hidden default (`isDefault: true`), shares the
    product's business, ID and status, and holds SKU, barcode, stock unit, `trackInventory`, the current selling
    price and `priceVersion`. Restoring a stored pair that breaks any of these throws.
  - Text: name 1 to 120 characters, description up to 500 (stored as given, not blank), change reason up to 500.
  - `updateProduct` applies a partial update. The product version must equal `expectedVersion` first
    (`VERSION_CONFLICT`); only then is a request that changes nothing a no-op (no version bump). A real change
    advances the product version by one; the variant version advances only when a variant field changed.
  - Stock unit: changing it is rejected (`INVALID_TRANSITION`) once the variant has movements, and while it has
    ACTIVE packs. `trackInventory` cannot be turned off while the balance is non-zero.
  - `archiveProduct` and `reactivateProduct`: ACTIVE and ARCHIVED, with the same state a no-op.
  - `setSellingPrice`: the price must be positive, at most 2^63 - 1 minor units (the PostgreSQL `BIGINT` ceiling),
    and in the business currency (`INVALID_VALUE`; there is no conversion). The same amount is a no-op. Otherwise
    `priceVersion` increments (0 means never priced), the product version advances, and a new
    `ProductVariantPrice` history entry is returned for appending. ADR-008 does not restrict pricing an archived
    product, so it is allowed.
- `category.ts`: flat categories. Name 1 to 60 characters with a case-insensitive key. `renameCategory`
  (versioned; the same name is a no-op) and `archiveCategory` (ARCHIVED is final; archiving again is a no-op).
- `pack.ts`: a named integer conversion to the variant's stock unit. Name 1 to 40 characters; factor 2 to 10^9 minor
  units; no barcode; immutable apart from ACTIVE to RETIRED. `packEntryQuantity` turns a pack count into an exact
  `Quantity` in the stock unit.
- `common.ts`: shared status, instant and version validation, and `requireExpectedVersion`.
- `errors.ts` (domain): `DomainErrorCode` gains `VERSION_CONFLICT`.

## Normalization (`identifiers.ts`)

- **SKU** (ADR-008 section 5.1): NFC, trim, collapse inner whitespace, then `^[A-Z0-9 ._/-]{1,64}$` on the
  upper-cased form. The display value keeps the merchant's case; the key is upper-case, so case-only variants
  collide. Unique per business across all statuses.
- **Barcode** (ADR-008 section 5.2): trim, then `[0-9A-Za-z-]{1,64}`. A digit string of length 8, 12, 13 or 14 with
  a valid GS1 check digit is normalized to GTIN-14 (left zero-padded). Anything else that passes the syntax,
  including a GTIN-length code with a bad check digit, is an ordinary merchant barcode kept unchanged and
  case-sensitive. Unique among ACTIVE variants per business.
- Tests: GTIN-8 `96385074`, UPC-A `036000291452`, EAN-13 `4006381333931`, GTIN-14 `10036000291459`, the bad check
  digit `036000291453`, boundaries and syntax. Seeded generated cases (500 each): SKU keys ignore case and
  surrounding or repeated whitespace and are idempotent; every generated valid GTIN-8/12/13/14 (check digit from an
  independent reference implementation in the test) becomes its GTIN-14 form and zero-padded forms collide; every
  GTIN-length code with a wrong check digit stays unchanged.

## Ports and fakes (`packages/application/src/modules/catalog/ports.ts`)

| Port                            | Methods                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `ProductRepository`             | `insert`, `findByIdForUpdate`, `update(previous, next)`, `findVariantIdBySku`, `findActiveVariantIdByBarcode` |
| `ProductPriceHistoryRepository` | `append` only                                                                           |
| `ProductCategoryRepository`     | `insert`, `findByIdForUpdate`, `update`, `findActiveIdByName`                           |
| `ProductPackRepository`         | `insert`, `findByIdForUpdate`, `update`, `hasActivePacks`, `findActiveIdByName`         |
| `UnitReferenceRepository`       | `findByCode` (global reference data, no business)                                       |
| `VariantInventoryStateReader`   | `stateOf` returning `{ hasMovements, hasNonZeroBalance }`                               |

- Every tenant-owned method takes the `businessId`; another business's record is not found.
- `assertCatalogProductTransition`, `assertCategoryTransition` and `assertPackTransition` are shared update
  preconditions for every adapter.
- `testing/in-memory-catalog-store.ts` implements all six ports. It enforces SKU, active-barcode, active-category-name
  and active-pack-name uniqueness and versions, rolls back with the unit of work, supports failure injection, and
  lets tests set a variant's inventory state. `testing/catalog-harness.ts` composes it over the Build 1 tenancy
  harness and returns a context for every role in a business of a chosen currency.

## Use cases

| Use case          | Permission                                   | Idempotency                       | Audit                                                   |
| ----------------- | -------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| CreateProduct     | `product:manage` (+ `product:price` with an initial price) | keyed, `product.create.v1` | `product.created` (+ `product.price_set`)          |
| UpdateProduct     | `product:manage`                             | `expectedVersion`; no-op unchanged | `product.updated`                                     |
| ArchiveProduct    | `product:manage`                             | `expectedVersion`; no-op unchanged | `product.archived`                                    |
| ReactivateProduct | `product:manage`                             | `expectedVersion`; no-op unchanged | `product.reactivated`                                 |
| SetSellingPrice   | `product:price`                              | `expectedVersion`; same amount no-op | `product.price_set`                                 |
| CreateCategory    | `product:manage`                             | keyed, `product_category.create.v1` | `product_category.created`                          |
| RenameCategory    | `product:manage`                             | `expectedVersion`; no-op unchanged | `product_category.updated`                            |
| ArchiveCategory   | `product:manage`                             | `expectedVersion`; no-op unchanged | `product_category.archived`                           |
| AddPack           | `product:manage`                             | keyed, `product_pack.add.v1`      | `product_pack.added`                                    |
| RetirePack        | `product:manage`                             | natural (retired pack is a no-op) | `product_pack.retired`                                  |

- Every use case follows the Build 1 pattern: `requireUserActor`, then inside the transaction
  `requireActingMembership` re-reads the membership, the target is locked by `(businessId, id)`, related IDs
  (category, product of a pack) are checked against the same business, and malformed or foreign IDs are
  `NOT_FOUND`. Domain errors map to `VALIDATION_FAILED`, `CONFLICT` and the new `VERSION_CONFLICT`.
- Keyed creates use `KeyedIdempotency.runBusinessScoped`. Uniqueness checks run inside `plan`, so a replay returns the
  stored result (`replayed: true`) rather than conflicting with itself; the same key with a different command is
  `IDEMPOTENCY_KEY_REUSED`. The result codecs store catalog metadata only.
- Uniqueness: SKU in any status, barcode among ACTIVE variants (also checked on reactivation), category name among
  ACTIVE categories (case-insensitive), pack name among ACTIVE packs of the variant. An archived category already
  assigned to a product may stay assigned but cannot be newly assigned (`CONFLICT`).
- The money boundary rejects a JSON-number `amountMinor` (only an integer string is accepted) and any currency other
  than the business currency.
- There are no read use cases in this slice. `product:read` is declared for S3.

## Permissions (`modules/identity/permissions.ts`)

| Permission       | Roles                                             |
| ---------------- | ------------------------------------------------- |
| `product:read`   | OWNER, MANAGER, CASHIER, STOCK_KEEPER, ACCOUNTANT |
| `product:manage` | OWNER, MANAGER, STOCK_KEEPER                      |
| `product:price`  | OWNER, MANAGER                                    |

`permissions.test.ts` proves the Build 1 permissions of every role are unchanged and the catalog mapping is exact.
No inventory permission was added (they belong to S5 and S6).

## Audit

- **`auditField.integerString({ maxLength, allowNegative })`** (kind `integer-string`, ADR-006 field kinds extended
  without changing ADR-006's rules): a base-10 integer string, `^(0|[1-9][0-9]*)$` or with `allowNegative`
  `^(0|-?[1-9][0-9]*)$`, at most 40 characters. It carries values beyond `Number.MAX_SAFE_INTEGER` (prices up to the
  `BIGINT` ceiling) exactly. The worst-case payload size counts it as `maxLength + 2`. Tests cover acceptance,
  rejection of numbers, `-0`, leading zeros, signs where not allowed and over-length values, and the payload size
  limit (157 such fields fit, 158 do not).
- **`auditField.optional` typing fix**: optional fields were typed `never` in the payload type; they are now typed as
  the wrapped field. Runtime behaviour is unchanged.
- **Entity types**: `product`, `product_category`, `product_pack`.
- **Ten actions** (all business stream, payload version 1, written in the mutation's transaction; no-ops write none):
  `product.created`, `product.updated` (change flags plus from/to of name, category, SKU, barcode, stock unit and
  tracking; the description only as changed or not), `product.archived`, `product.reactivated`, `product.price_set`
  (from/to amount as integer strings, currency, price version), `product_category.created`,
  `product_category.updated`, `product_category.archived`, `product_pack.added` (name, factor as integer string),
  `product_pack.retired`. The archive and price actions carry the optional reason in the audit envelope.
- The registry test lists all ten actions and asserts that no inventory action exists yet. The personal-name guard
  now allows `name`, `fromName`, `toName` and `nameChanged` only on the three catalog entity types (product, category
  and pack names are business data, not personal data); a test proves the allowlist is not used elsewhere.

## Price and version behaviour

- The product version is the `expectedVersion` token for every product, variant and price change.
- `priceVersion` is 0 when never priced and advances by one on each real price change. The history is append-only
  (one row per `(business, variant, priceVersion)`), and each entry records amount, currency, setter, optional reason
  and time.
- The version is checked first. Setting the same amount with the current `expectedVersion` is a no-op: it returns
  `changed: false` and writes no history, no audit record and no version increment. The same amount with a stale
  `expectedVersion` (price NGN X at version N, request NGN X with N-1) is `VERSION_CONFLICT`.
- Currency tests: NGN (2 digits), KES (2), JPY (0) and KWD (3), each rejecting a price in another currency; the
  `BIGINT` ceiling accepted and one above it rejected.

## Test results

| Suite | Result |
| --- | --- |
| domain | 16 files, 223 passed (new: `quantity` 22, catalog `identifiers` 19, `product` 17, `category-pack` 8) |
| application | 25 files, 404 passed after the review correction (new: catalog `products` 49, `prices` 22, `packs` 14, `categories` 13, `version-conflict` 2; extended: `audit-payload` 74, `permissions` 20) |
| API unit and compat | 53 passed (one new error-envelope row) |
| integrations 109, shared 28, config 37, worker 11, database 13, text-integrity 12, client-bundle-check 8 | passed |
| web (Vitest) | 9 files, 117 passed |
| mobile (jest-expo) | 19 suites, 338 passed |
| database integration | 19 files, 221 passed |
| worker integration | 9 passed, 1 skipped |
| API integration | 97 passed, 1 skipped |

Every mutation has tests for success, validation failure, idempotent replay and key reuse (keyed creates) or no-op
and version conflict (state-setting), another tenant's IDs (`NOT_FOUND`, nothing written), insufficient permission
for each role without it, and the exact audit payload.

## Dependency boundaries

`pnpm run boundaries` reports no violations (512 modules, 2199 dependencies). The catalog module in `packages/application` imports only
`@tali/domain` and its own package; `packages/domain` stays pure. No rule was changed.

## Verification

| Check | Result |
| --- | --- |
| Competing processes stopped first (API `start` and `dist/main.js`, Expo Metro) | done |
| `pnpm verify` (text integrity, format, build, lint, typecheck, boundaries, all unit tests) | exit 0 (second run; see below) |
| `pnpm test:integration` (run after verify, alone) | exit 0 (second run; see below) |
| gitleaks v8.30.1 (Docker): `git` over history (19 commits); `git` over a temporary clone with the 49 changed and untracked files committed (20 commits); `dir` over a copy of those files with `.gitleaks.toml` | no leaks |
| After the review correction: `pnpm verify` | exit 0 (18 of 18 tasks; see below) |
| After the review correction: `pnpm test:integration` (alone, after verify) | exit 0 (database 221, worker 9 + 1 skipped, API 97 + 1 skipped) |
| After the review correction: gitleaks `git` history (19 commits), temporary clone with the 50 changed files (20 commits), `dir` over those files | no leaks |

### Failed first runs (no assertion failed)

- **`pnpm verify`, first run: web Vitest workers did not start.** Only `@tali/web#test` failed: 7 of its 9 test files
  failed before running with `[vitest-pool]: Failed to start forks worker ... Timeout waiting for worker to
  respond`. The 2 files that started passed (9 tests), and every other package's tests passed. Turbo then stopped the
  mobile Jest task before it reported. Root cause: host memory. 2.9 GB of 15.7 GB were free, and about 1.8 GB was
  held by the WSL VM running some 20 unrelated Docker containers from other projects, while Turbo ran several
  Vitest pools and jest-expo in parallel. This is the host-saturation failure analysed in
  `docs/audits/build-1-slice-3.md`. The unchanged second run exited 0 with 18 of 18 tasks (web 117 and mobile 338
  passed). The Vitest configuration was not changed.
- **`pnpm test:integration`, first run: test database unreachable.** Global setup failed with `P1001: Can't reach
  database server at 127.0.0.1:55433` before any test ran. Windows has reserved port 55433 on this machine since
  Build 1 Slice 6, so the local test container is published on `127.0.0.1:57433` through the existing
  `TALI_POSTGRES_TEST_PORT` override. The second run set the existing `TEST_DATABASE_URL` and
  `TEST_MIGRATION_DATABASE_URL` overrides to that port (local-only credentials from `.env.example`) and exited 0.
  No repository file changed.
- **After the review correction, `pnpm verify` first run: the same web worker-start failure.** Only `@tali/web#test`
  failed: 7 of 9 files did not start a worker; the 2 that started passed (13 tests); every other package passed,
  including application 404. No assertion failed. A second attempt did not run: PowerShell could not open its log
  file, and the half-started process was stopped. The next clean run, unchanged, exited 0 with 18 of 18 tasks (web
  117, mobile 338). Integration ran afterwards, alone, with the same port overrides.

## Review correction: expectedVersion precedes no-op detection (2026-10-05)

The first submission detected a same-state no-op before checking `expectedVersion`, so a stale request whose target
state already held succeeded as a no-op. ADR-008 section 9 requires a mismatch to be `VERSION_CONFLICT` (the
stocktake precedence of section 12.4 is not part of Slice 1). The human review required the correction.

- Order now implemented for UpdateProduct, ArchiveProduct, ReactivateProduct, SetSellingPrice, UpdateCategory
  (rename) and ArchiveCategory: permission and membership; tenant-safe locked lookup by `(businessId, id)`; compare
  `expectedVersion` with the current aggregate version (product version, or category version) and throw
  `VERSION_CONFLICT` on mismatch; only then decide whether the requested state already holds (`changed: false`, no
  write, no audit, no history, no version increment) or perform the change. Request-shape validation (malformed
  IDs, names, prices, versions) still happens before the transaction.
- The change is in the domain transitions (`updateProduct`, `archiveProduct`, `reactivateProduct`,
  `setSellingPrice`, `renameCategory`, `archiveCategory`). The application-level same-price shortcut in
  `prices.ts` that returned before the domain check was removed. Uniqueness and assignability checks still run
  after the transition, so they never pre-empt a version conflict.
- Tests for each of the six: A (current version, state holds: success, `changed: false`, nothing written, version
  unchanged), B (stale version, state holds: `VERSION_CONFLICT`, nothing written), C (stale version, real change:
  `VERSION_CONFLICT`, nothing written), in both the domain and application suites. SetSellingPrice covers NGN X at
  version N requested with N-1.
- RetirePack is unchanged (see below).

## Deviations and interpretations

- **`VERSION_CONFLICT` API mapping: accepted by the human maintainer** as required exhaustive plumbing.
  `VERSION_CONFLICT` is a new application error code; the API error-envelope status map is exhaustive over the
  codes, so it gained `VERSION_CONFLICT: 409` and a test row. No route, DTO, contract or controller changed.
- **RetirePack without `expectedVersion`: accepted by the human maintainer.** ADR-008 gives packs no version, and
  `ProductPack` has none. Retiring is natural state-setting: ACTIVE to RETIRED is a real change with one audit
  record; RETIRED to RETIRED is a successful no-op with no audit.
- **Stock-unit change rejected while any ACTIVE pack exists for the variant: accepted by the human maintainer.**
  Active pack factors derive their meaning from the current stock unit, so a unit change would silently reinterpret
  them. RETIRED packs do not block: they cannot be used for new inventory entry, and a pack that ever took part in
  inventory history is covered by the separate rule that the stock unit is immutable once any movement exists. The
  correction path is retire the pack, change the stock unit (if every other guard permits), add a replacement pack.
  Tests: an ACTIVE pack blocks; after retirement pack presence alone no longer blocks; movement state (from the test
  reader) still blocks independently; the replacement pack is then added.
- **Pack-name uniqueness compares the exact normalized name**, not case-insensitively.
- **The personal-name guard in the audit registry test was narrowed with an explicit allowlist** for catalog names.
- **No read use cases**; `product:read` is declared and mapped only.
- **Low-stock threshold guard on stock-unit change** (ADR-008 section 7.4) is deferred to S5, where thresholds exist.

## Risk

- **Tenancy.** Every port method is scoped by the context business, related IDs are checked against it, and every
  mutation has a cross-tenant test. `UnitReferenceRepository` is global reference data and holds no tenant data.
- **Money.** Prices are `Money` in integer minor units in the business currency; no float arithmetic. The kernel
  `Money.fromMinorUnitsString` coerces a JS number through a regex test; the catalog boundary rejects non-strings
  first. This pre-existing runtime-coercion risk remains deferred to transport-boundary enforcement: the kernel was
  not changed, and the S3 transport contracts must reject non-string money wire values.
- **Inventory guard source.** `VariantInventoryStateReader` is a port only in Slice 1, with no production adapter.
  Its production wiring is an S2/S3 composition concern, and whatever is wired there must be replaced by the real
  inventory-backed implementation when S5 lands.
- **Audit field kind.** `integer-string` adds a field kind under ADR-006's existing rules (bounded, schema-validated,
  no personal data); ADR-006 itself was not edited.
