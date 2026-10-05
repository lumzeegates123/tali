# ADR-008. Catalog, quantity and inventory model

- Status: ACCEPTED (2026-10-05)
- Date: 2026-10-05
- Deciders: Tali maintainers (human approval given 2026-10-05; drafted by an AI agent from the Build 2 plan, accepted
  by the human maintainer). Acceptance record in section 26.
- Related: `docs/plans/004-build-2-catalog-inventory.md`; `docs/architecture/data-principles.md` sections 4 to 6, 11
  to 13; `docs/product/mvp-scope.md` (Core MVP catalog and inventory, open decisions 6 and 9); ADR-002 sections 13
  to 15 and 25; ADR-004; ADR-005 sections 6, 8, 19 and 20; ADR-006
- Scope: Build 2 (product catalog and inventory). Quantity-only: no monetary cost, valuation, ledger posting, tax or
  sales.

## 1. Context

Build 1 (identity and tenancy) is complete. Build 2 creates the authoritative product catalog and inventory
foundation required before Sales (implementation steps 3 and 4 of `mvp-scope.md`).

Constraints that already apply:

- The canonical inventory movement types are listed in `data-principles.md` section 4. They are `OPENING`,
  `PURCHASE_RECEIPT`, `SALE`, `CUSTOMER_RETURN`, `SUPPLIER_RETURN`, `ADJUSTMENT`, `COUNT_CORRECTION` and `WRITE_OFF`.
  `TRANSFER` is post-MVP. Types are not invented.
- Movements are append-only, reference a **product variant** and a `location_id`, and on-hand equals the sum of
  movements. A cached quantity must be updated in the same transaction and be rebuildable (`10-database.mdc`).
- Quantities are integers in base units or exact decimals, never floats.
- The APPROVED Core MVP catalog has "products and variants, selling price, cost price where known, archive (not
  delete)".
- Restock *with cost* has accounting effects and needs the ledger posting foundation first (`mvp-scope.md`,
  implementation order).
- Open decision 9 (unit of measure and packs) and open decision 6 (inventory valuation) are not approved. ADR-002
  section 25 requires an inventory valuation ADR before restock with cost. This ADR decides only the inventory
  portion of open decision 9 (section 24).
- The APPROVED Core MVP inventory scope includes a **low-stock indicator** (section 7.4).
- Mutation protocol (ADR-004), permissions (ADR-005 section 8), audit payload fields (ADR-006), tenant-safe composite
  keys (ADR-005 section 19) and the destructive-operation policy (ADR-005 section 20) apply unchanged.

## 2. Decision summary

1. **Product plus one hidden default ProductVariant** per product in Build 2 (section 3).
2. **Optional, flat ProductCategory** (section 3).
3. **ProductPack** is an integer conversion to the stock unit, **without a barcode** in Build 2 (section 3).
4. **Stock unit** is the smallest practical unit the merchant transacts individually, chosen from a global reference
   list with nine initial units (section 4).
5. **Quantity** is an exact scaled integer: `bigint` minor quantity plus a unit code, with a string wire contract
   (section 4).
6. **SKU** is optional, normalized, and unique per business across all statuses (section 5).
7. **Barcode** is optional on the variant only. A valid GTIN is normalized to GTIN-14, and any other syntactically
   valid code is an ordinary merchant barcode. It is unique among ACTIVE variants of the business (section 5).
8. **Stock is scoped to business and location** (section 6).
9. **Append-only movements plus a transactional balance projection** (section 7), and a separate location-and-variant
   **low-stock threshold** setting from which a derived `LOW_STOCK` state is computed (section 7.4).
10. **Typed, database-enforced source relationships** replace polymorphic `source_type`/`source_id` (section 8).
11. **Locking, concurrency and idempotency** follow ADR-004 (section 9).
12. **Build 2 negative-stock policy:** manual decreases may not take on-hand below zero (section 10).
13. **Stocktake** with staleness detection, a blind-count workflow (not a security boundary), and a stated precedence
    for posting idempotency (section 12).
14. **Goods receipt** is quantity-only, with no supplier, purchase order or cost (section 11).
15. **No monetary cost or valuation** in Build 2 (section 13).
16. **Selling price** is master data, per stock unit and business-wide, with append-only history (section 14).
17. **Permissions:** ten new permissions extend the ADR-005 catalogue (section 15).
18. **Audit** actions are defined, with a new bounded integer-string audit field kind for quantities and minor units
    (section 16).
19. **Archive, never delete**, and residual stock on archived products stays visible to inventory flows
    (section 17).
20. **AI may only propose. Offline sync is not built**, but nothing here blocks it (section 18).
21. **The ledger/accounting ADR (proposed ADR-009)** must be accepted before cost, valuation, COGS, tax or `SALE`
    (section 19).

## 3. Catalog model

### 3.1 Product

- Table `products`: `business_id`, `id` (UUIDv7), `name`, `description`, `category_id`, `status`, `version`,
  `created_at`, `updated_at`, `created_by_membership_id`.
- `name`: required. NFC and trimmed (this field's contract normalizes, per ADR-004 section 5), 1 to 120 characters.
  Not unique; a normalized-name index supports search.
- `description`: optional, at most 500 characters, no markup interpretation.
- `status`: `ACTIVE` or `ARCHIVED` (CHECK).
- `version`: a positive integer, incremented by every change; used for optimistic concurrency (section 9).

### 3.2 ProductVariant (hidden default)

- Table `product_variants`: `business_id`, `id`, `product_id` (composite FK), `is_default`, `status`, `sku`,
  `sku_normalized`, `barcode`, `barcode_normalized`, `stock_unit_code` (FK to `units_of_measure`),
  `track_inventory`, `current_price_minor`, `current_price_currency`, `price_version`, `version`, timestamps.
- **Build 2 invariant:** every product has exactly one variant, created in the same transaction, with
  `is_default = true` (partial unique index: one default per product). Its `status` always equals the product's
  status, changed in the same transaction (application invariant, tested). The UI never shows the variant
  separately.
- Movements, balances, prices, packs, SKU and barcode belong to the **variant**, so a later multi-variant feature adds
  variants without migrating stock history.
- `track_inventory` (default true): an untracked variant has no balance and rejects inventory operations. Changing it
  from true to false is allowed only when its balance at every location is zero. Changing it from false to true starts
  at zero, and opening stock may then be recorded.
- `stock_unit_code` is immutable once any movement exists for the variant.
- Before any movement exists, a stock-unit change is **rejected with `409 CONFLICT` while a low-stock threshold is
  configured for the variant at any location**. The guard checks every configured threshold for the variant across all
  of the business's locations, not only the currently resolved or default location: the unit may not change while any
  location has a configured (non-`NULL`) threshold. The merchant clears the thresholds, changes the unit, then sets
  them again in the new unit. No implicit threshold conversion is permitted; a threshold is never converted or
  reinterpreted (section 7.4).

### 3.3 ProductCategory

- Table `product_categories`: `business_id`, `id`, `name` (NFC, trimmed, 1 to 60 characters), `status` (`ACTIVE` or
  `ARCHIVED`), `version`, timestamps.
- Flat: no parent, no hierarchy. A product has at most one category.
- Name unique per business among ACTIVE categories, compared case-insensitively after normalization (partial unique
  index on the normalized name).
- Archiving a category leaves products referencing it unchanged; it is no longer offered for new assignment.

### 3.4 ProductPack

- Table `product_packs`: `business_id`, `id`, `variant_id` (composite FK), `name` (NFC, trimmed, 1 to 40 characters),
  `factor_minor`, `status` (`ACTIVE` or `RETIRED`), timestamps.
- `factor_minor`: the number of **minor** stock-unit quantities in one pack. It is an integer from 2 to 10^9. Examples:
  a carton of 24 bottles is 24; a 50 KG bag is 50000 (KG scale 3).
- A pack is used **only for data entry** on opening stock, receipts, adjustments and counts. Stock is always held in
  the stock unit. Packs never convert across kinds (a mass pack cannot be counted in pieces).
- Pack name unique per variant among ACTIVE packs.
- A pack is immutable: its factor and name never change. A wrong pack is retired and a new one added, so movement
  snapshots stay true.
- **No barcode in Build 2.** `product_variants` and `product_packs` are separate tables, so a UNIQUE constraint cannot
  enforce one business-wide active barcode namespace across both. Pack barcodes are deferred to Build 3 or a later
  catalog ADR. If they are required, that decision evaluates a shared business-scoped catalog identifier (barcode)
  registry with one unique index.
- Pack names are free text. The UI may suggest `Carton`, `Crate`, `Bag`, `Dozen` and `Bundle`.

## 4. Units of measure and Quantity

### 4.1 Stock unit semantics

The variant's stock unit is **the smallest practical inventory unit the merchant intends to transact individually**.
Larger packaging is a ProductPack, not a stock unit.

| Product | Stock unit | Pack                   |
| ------- | ---------- | ---------------------- |
| Coke    | `BOTTLE`   | "Carton" = 24 `BOTTLE` |
| Indomie | `PACK`     | "Carton" = 40 `PACK`   |
| Rice    | `KG`       | "Bag" = 50 `KG`        |
| Egg     | `PIECE`    | "Crate" = 30 `PIECE`   |

`PACK` as a stock unit means a retail pack sold individually (for example one Indomie pack). It is unrelated to the
ProductPack entity, which is packaging used for entry.

### 4.2 Unit reference data

Global, read-only table `units_of_measure`: `code` (PK, `^[A-Z]{1,16}$`), `kind` (`COUNT`, `MASS` or `VOLUME`),
`scale` (`0` to `3`). Initial seed:

| Code     | Kind     | Scale | Minor quantity |
| -------- | -------- | ----- | -------------- |
| `PIECE`  | `COUNT`  | 0     | 1 piece        |
| `BOTTLE` | `COUNT`  | 0     | 1 bottle       |
| `SACHET` | `COUNT`  | 0     | 1 sachet       |
| `TIN`    | `COUNT`  | 0     | 1 tin          |
| `PACK`   | `COUNT`  | 0     | 1 pack         |
| `KG`     | `MASS`   | 3     | 1 gram         |
| `G`      | `MASS`   | 0     | 1 gram         |
| `L`      | `VOLUME` | 3     | 1 millilitre   |
| `ML`     | `VOLUME` | 0     | 1 millilitre   |

- `CARTON`, `CRATE`, `BAG`, `DOZEN` and `BUNDLE` are **not** initial stock units; they are pack names.
- The list is **not closed**. Adding a unit is a reviewed migration with a kind and a scale. Local measures (for
  example mudu or derica) are **not** added as global standard units without pilot evidence and a defined exact
  conversion.
- There is no conversion between units: not across kinds, and not between units of the same kind (`KG` and `G`). The
  only conversion is pack to stock unit.

### 4.3 Quantity value object

- `Quantity { amountMinor: bigint; unit: UnitCode }` in `packages/domain/src/kernel`, alongside `Money`. Its scale comes
  from the unit reference data, never hard-coded.
- Arithmetic is exact `bigint` addition, subtraction, comparison and integer multiplication (pack count times factor).
  Operations across different units are rejected. Build 2 has no division.
- Bounds: absolute value at most 10^15 minor quantities.
- **PostgreSQL:** `BIGINT` columns named `*_minor`, with CHECK bounds, plus the unit code (FK) where the unit is not
  fixed by the variant. No `NUMERIC`, `REAL` or `DOUBLE PRECISION`.
- **Wire:** `{ "quantityMinor": "1500", "unit": "KG" }`, a base-10 integer string, never a JSON number. A command may
  instead send a decimal string in stock units (`"1.5"` for 1.5 KG), parsed exactly against the scale. More fractional
  digits than the scale allows are **rejected, never rounded**. Pack entry is `{ "packId": "...", "packCount": "2" }`,
  where `packCount` is a positive integer string.
- Fingerprints encode the normalized `bigint` (ADR-004 section 5 rule 5), so offline replay later is deterministic.
- Clients only format quantities for display. They never compute authoritative stock.

## 5. Identifiers

### 5.1 SKU

- Optional on the variant. Stored as entered (`sku`) and normalized (`sku_normalized`): NFC, trimmed, inner whitespace
  collapsed to one space, upper-cased. After normalization: 1 to 64 characters of `[A-Z0-9 ._/-]`.
- **Unique per business across all statuses**: `UNIQUE (business_id, sku_normalized)`. An archived product keeps its
  SKU, so a SKU is never silently reused for a different item.
- Not globally unique. Lookups always include `business_id`.

### 5.2 Barcode

- Optional, on the **variant only** (section 3.4).
- General syntax: trimmed; 1 to 64 characters of `[0-9A-Za-z-]`; case preserved and compared exactly.
- **GTIN normalization:** if the code is all digits, has length 8, 12, 13 or 14, **and** passes the GTIN check-digit
  validation, it is stored in `barcode_normalized` as canonical GTIN-14 (left zero-padded). UPC-A and EAN-13 forms of
  one item therefore match.
- Otherwise, if it passes the general syntax, it is an **ordinary merchant barcode**, stored unchanged in
  `barcode_normalized`. An all-digit code of a GTIN length that fails the check digit is **accepted as an ordinary
  merchant barcode**. It is never rejected for that reason, and never relabelled as a standards GTIN.
- The two forms cannot collide: a canonical GTIN-14 always has a valid check digit, so it never equals an ordinary
  code that failed validation.
- No `barcode_scheme` column in Build 2: whether a stored code is a valid GTIN is derivable from its value.
- **Unique among ACTIVE variants of the business**: partial unique index
  `(business_id, barcode_normalized) WHERE status = 'ACTIVE' AND barcode_normalized IS NOT NULL`. A scan resolves to at
  most one active sellable item.
- An archived variant releases its barcode. Reactivating it returns `409 CONFLICT` if another ACTIVE variant now holds
  that barcode; nothing changes.
- Multiple barcodes per variant are not supported in Build 2.

### 5.3 Names

Product names are not unique (section 3.1). A duplicate-name warning is deferred.

## 6. Location-scoped stock

- Every movement, balance, opening batch, goods receipt, adjustment and stocktake carries a NOT NULL `location_id` with
  a composite FK to `business_locations (business_id, id)`.
- Location-bound use cases receive a `LocationBoundContext` from the existing default-location resolver. Build 2 API
  routes take no location ID. A later location-selection feature adds one, verified against the business.
- No constraint assumes a single location: there is no singleton index and no location-free stock.

## 7. Movements and balances

### 7.1 `inventory_movements` (append-only)

Columns: `business_id`, `id` (UUIDv7), `location_id`, `variant_id`, `type`, `quantity_delta_minor`,
`balance_after_minor`, `balance_version`, the typed source columns (section 8), the pack snapshot (`pack_id`,
`pack_name`, `pack_count`, `pack_factor_minor`, all null or all set), `reverses_movement_id`, `reason_code`,
`reason_note`, `actor_membership_id` (composite FK), `device_id` (composite FK, set only when verified),
`source_channel`, `occurred_at`, `business_date`, `recorded_at`, `correlation_id`.

- The application role has INSERT and SELECT only. The table joins the ESLint protected-model list, and
  `verify-schema.mjs` checks the privileges.
- `quantity_delta_minor <> 0`.
- Pack snapshot CHECK: when set, `abs(quantity_delta_minor) = pack_count * pack_factor_minor`. The pack FK is
  `(business_id, pack_id, variant_id) -> product_packs (business_id, id, variant_id)`, so the pack belongs to the same
  variant.
- `balance_version` is the stock item's version after this movement: `UNIQUE (business_id, location_id, variant_id,
balance_version)`. This gives each stock item a gap-free sequence.
- **Types implemented in Build 2:** `OPENING`, `PURCHASE_RECEIPT`, `ADJUSTMENT`, `WRITE_OFF`, `COUNT_CORRECTION`. The
  database CHECK lists only these. `SALE`, `CUSTOMER_RETURN` and `SUPPLIER_RETURN` remain canonical in
  `data-principles.md`, and are added to the CHECK by the migration that introduces their use case and source column.
- `occurred_at` is the server time of the request in Build 2 (no backdating); `business_date` is derived from it in
  the business time zone (ADR-002 section 15).

### 7.2 Direction and reversal CHECKs

| Type               | Original movement | Reversal movement                 |
| ------------------ | ----------------- | --------------------------------- |
| `OPENING`          | delta > 0         | not reversible                    |
| `PURCHASE_RECEIPT` | delta > 0         | delta < 0                         |
| `ADJUSTMENT`       | delta <> 0        | opposite sign of the original     |
| `WRITE_OFF`        | delta < 0         | delta > 0                         |
| `COUNT_CORRECTION` | delta <> 0        | not reversible (count again)      |

- `reverses_movement_id` is a real composite self FK:
  `(business_id, reverses_movement_id, location_id, variant_id, type) -> inventory_movements (business_id, id,
location_id, variant_id, type)`. A reversal therefore has the same location, variant and type as its original.
- `UNIQUE (business_id, reverses_movement_id)`: at most one reversal per movement.
- That a reversal exactly negates its original's delta is enforced by the domain service and tested (it needs a
  cross-row comparison).

### 7.3 `inventory_balances` (transactional projection)

- Primary key `(business_id, location_id, variant_id)`; composite FKs to location and variant; `quantity_minor`,
  `version`, `last_movement_id`, `updated_at`.
- Updated **in the same transaction** as each movement it reflects: `quantity_minor` changes by exactly the delta, and
  `version` increases by one per movement.
- The application role has SELECT, INSERT and UPDATE, and no DELETE.
- **No `quantity_minor >= 0` CHECK.** Build 2's non-negative rule is a domain policy (section 10), and the future
  sales policy may preserve negative stock.
- **Rebuildability:** a read-only consistency query compares each balance with the sum of its movements and its
  version with the movement count. It runs after every inventory integration-test scenario, and as an operator check
  script. A mismatch is reported, never repaired automatically.

### 7.4 Low-stock threshold and derived low-stock state

The APPROVED Core MVP includes a low-stock indicator. Build 2 implements it narrowly.

**Table `inventory_stock_thresholds`** (configuration, kept separate from the balance projection):

- `business_id`, `id` (UUIDv7, `UNIQUE (business_id, id)` as for every tenant table), `location_id`, `variant_id`,
  `low_stock_threshold_minor`, `version`, `created_at`, `updated_at`;
- `UNIQUE (business_id, location_id, variant_id)`, with composite FKs to `business_locations` and `product_variants`;
- `low_stock_threshold_minor`: `BIGINT`, nullable. `NULL` means "not configured". When set, it is from 0 to 10^15,
  in minor quantities of the variant's **current stock unit** (section 4.3). It is never negative and never a float.
- The application role has SELECT, INSERT and UPDATE, and no DELETE. Clearing sets the value to `NULL` and keeps the
  row.

Why separate:

- The threshold is not on `product_variants`, because stock is location-specific.
- It is not on `inventory_balances`, because that table is a rebuildable projection of movements; configuration is
  not derived from movements.

**Derivation rule** (pure domain function, computed on read, never stored):

```text
LOW_STOCK  <=>  variant.status = ACTIVE
           AND  variant.track_inventory = true
           AND  threshold is configured (not NULL)
           AND  on_hand_minor <= low_stock_threshold_minor
```

- On-hand is the balance quantity at that location, or zero when no balance row exists.
- A threshold of 0 is allowed: zero on-hand (out of stock) is then `LOW_STOCK`.
- No threshold configured: no `LOW_STOCK` state is derived.
- An **archived** variant never derives `LOW_STOCK`. It stays discoverable while it has residual stock (section 17),
  but it is not a replenishment candidate.
- An untracked variant never derives `LOW_STOCK`; a stored threshold is kept but ignored.

**Mutations** (state-setting configuration, **not** inventory movements):

- SetLowStockThreshold and ClearLowStockThreshold. Neither creates an `InventoryMovement` or changes a balance.
- The threshold value uses the same `Quantity` input rules as other quantities (decimal string within the unit's
  scale, or `quantityMinor`), and the unit must be the variant's current stock unit.
- The target must be an ACTIVE, tracked variant. Setting a threshold on an archived or untracked variant is
  `409 CONFLICT`.
- Concurrency: the variant is read `FOR SHARE` (so a concurrent unit, archive or tracking change serializes); the
  threshold row is locked `FOR UPDATE`.
- Version semantics (state-setting, `expectedVersion` always required):
  - the absence of an `inventory_stock_thresholds` row is configuration version 0;
  - `expectedVersion = 0` means the caller expects no existing row; a successful initial SetLowStockThreshold inserts
    the row at version 1;
  - if a row already exists (including a cleared row with a `NULL` threshold), `expectedVersion = 0` returns
    `409 VERSION_CONFLICT`;
  - every later set or clear requires the current persisted version, and a successful change increments it;
  - two concurrent initial creates produce exactly one winner: the `UNIQUE (business_id, location_id, variant_id)`
    constraint plus transactional handling (insert, and on a uniqueness collision re-read the row under the same
    transaction rules) make the loser receive `409 VERSION_CONFLICT`, never a duplicate row or a silent overwrite;
  - ClearLowStockThreshold with `expectedVersion = 0` and no row is a no-op.
- Setting the current value, or clearing an absent or already-cleared threshold, is a successful no-op with no audit
  record (ADR-004 section 7).
- Permission: `inventory:threshold` (section 15). Viewing the threshold and the derived state requires
  `inventory:read`.

**Out of Build 2:** notifications, push alerts, forecasting, automatic reorder points, reorder quantities, supplier
recommendations, automatic purchasing and AI-generated restock orders.

## 8. Typed source relationships

Polymorphic `source_type`/`source_id` is rejected because PostgreSQL cannot enforce the reference. Each Build 2
movement instead references its source document through a typed, nullable composite FK:

| Movement type                | Source column        | References                                                                            |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `OPENING`                    | `opening_batch_id`   | `inventory_opening_batches (business_id, id)`                                         |
| `PURCHASE_RECEIPT`           | `goods_receipt_id`   | `goods_receipts (business_id, id)`                                                    |
| `ADJUSTMENT`, `WRITE_OFF`    | `adjustment_id`      | `inventory_adjustments (business_id, id, kind)` via `(business_id, adjustment_id, type)` |
| `COUNT_CORRECTION`           | `stocktake_id`       | `stocktake_lines (business_id, stocktake_id, variant_id)` via `(business_id, stocktake_id, variant_id)` |

CHECK constraints:

- `num_nonnulls(opening_batch_id, goods_receipt_id, adjustment_id, stocktake_id) = 1`;
- `(type = 'OPENING') = (opening_batch_id IS NOT NULL)`;
- `(type = 'PURCHASE_RECEIPT') = (goods_receipt_id IS NOT NULL)`;
- `(type IN ('ADJUSTMENT', 'WRITE_OFF')) = (adjustment_id IS NOT NULL)`;
- `(type = 'COUNT_CORRECTION') = (stocktake_id IS NOT NULL)`.

Consequences:

- An adjustment document has a `kind` (`ADJUSTMENT` or `WRITE_OFF`) with `UNIQUE (business_id, id, kind)`. The FK
  including `type` guarantees that a movement's type matches its document's kind.
- A count correction's FK to the stocktake line guarantees that a counted line for that variant exists in that
  stocktake.
- Document lines are the movements themselves for opening batches, goods receipts and adjustments:
  `UNIQUE (business_id, goods_receipt_id, variant_id) WHERE reverses_movement_id IS NULL`, and the same for opening
  batches and adjustments. No separate line tables are created for them in Build 2. A reversal movement references the
  same document as its original.
- Every composite FK target above (and the pack and reversal FKs in section 7) gets the matching UNIQUE constraint,
  for example `UNIQUE (business_id, id, kind)` on adjustments and `UNIQUE (business_id, id, location_id, variant_id,
type)` on movements.
- No generic `InventoryDocument` abstraction: the four documents have different lifecycles (sections 11 and 12).
- A future type adds its own typed source column, CHECK and FK in the migration that introduces it.

## 9. Concurrency, locking and idempotency

Every stock change is one `UnitOfWork.run` at `read-committed` (ADR-004 section 9):

1. Authenticate, resolve `BusinessContext` and the default location, and check the permission, before the
   idempotency lookup (ADR-004 section 6).
2. Load the affected variants `FOR SHARE`. Archive, reactivate, `track_inventory` and unit changes take
   `FOR UPDATE` on the variant, so they cannot interleave with a stock change.
3. Create missing balance rows (`INSERT ... ON CONFLICT DO NOTHING`), then lock them `FOR UPDATE` **in ascending
   `variant_id` order**, to avoid deadlocks between multi-line documents.
4. Make the pure domain decision; insert the document and movements; update the balances; write the audit record;
   insert the keyed idempotency record. All commit together.

- Lock timeout maps to `409 CONCURRENT_MODIFICATION`. Serialization failures and deadlocks are retried within the
  ADR-004 bound.
- Product, variant, category, low-stock threshold and stocktake edits carry `expectedVersion`. A mismatch is `409 VERSION_CONFLICT`,
  except where section 12.4 gives precedence to the posted state.
- At most 200 lines per document request.

**Idempotency** (business scope only, ADR-004 section 4.2):

| Mechanism                          | Use cases                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Keyed (`Idempotency-Key` required) | CreateProduct, CreateCategory, AddPack, RecordOpeningStock, PostGoodsReceipt, RecordAdjustment, RecordWriteOff, CreateStocktake |
| State-setting (no-op when it holds) | UpdateProduct, UpdateCategory, SetSellingPrice, Archive/Reactivate product, Archive category, RetirePack, RecordStocktakeCount, RemoveStocktakeLine, PostStocktake, CancelStocktake, ReverseGoodsReceipt, ReverseAdjustment, SetLowStockThreshold, ClearLowStockThreshold |
| Natural key                        | One `OPENING` per stock item: partial unique index `(business_id, location_id, variant_id) WHERE type = 'OPENING'`      |

- Reversals are state-setting: reversing an already `REVERSED` document is a successful no-op with no new movement and
  no audit record.
- Opening stock is allowed only while the stock item has no movement. Afterwards it returns `409 CONFLICT` and the
  merchant uses a count or adjustment.
- Future offline commands use their client-generated command UUID as the idempotency key (ADR-004 section 3). Movements
  already record `occurred_at`, `business_date`, `device_id` and `source_channel`, so the sync ADR adds envelope fields
  without reshaping history. Build 2 generates document IDs on the server; nothing prevents client-generated UUIDv7
  document IDs later.

## 10. Negative stock (Build 2 policy)

- **Manual decreases may not take on-hand below zero.** An `ADJUSTMENT` with a negative delta, a `WRITE_OFF`, or the
  reversal of a goods receipt or of a positive adjustment is rejected with `409 INSUFFICIENT_STOCK` if the resulting
  balance would be negative. Nothing is written.
- A `COUNT_CORRECTION` sets stock to the counted quantity, which is zero or more, so posting a count never produces a
  negative balance.
- Increases (`OPENING`, `PURCHASE_RECEIPT`, a positive adjustment) are always allowed.
- **Sales and offline replay are not decided here.** A credible `SALE` that would take stock negative must be recorded
  and flagged, never silently dropped (NEEDS_ATTENTION, `architecture-principles.md` section 7). Whether online sales
  may block or allow negative stock, and whether that is configurable per business or product, is decided by the Build
  3 sales ADR. Build 2 adds no policy column.

## 11. Opening stock, goods receipts and adjustments

- **Opening batch** (`inventory_opening_batches`: `business_id`, `id`, `location_id`, `note`, actor, channel, device,
  `occurred_at`, `business_date`, `recorded_at`). One `OPENING` movement per line. Not reversible; errors are corrected
  by a count or an adjustment.
- **Goods receipt** (`goods_receipts`: as above, plus an optional `reference` of at most 64 characters, for example a
  delivery-note number, and `status`).
  - Quantity-only: **no supplier, no purchase order, no cost.** The purchasing build extends this entity (optional
    supplier, purchase-order link, line costs) rather than replacing it, as `data-principles.md` section 8 allows a
    goods receipt without a purchase order.
  - `status`: `POSTED`, then optionally `REVERSED`. Reversal creates one reversal movement per line, sets the status
    and records `reversed_at`, `reversed_by_membership_id` and `reversal_reason` (required) in one transaction. It is
    never a status-only change.
- **Adjustment** (`inventory_adjustments`: as above, plus `kind`, `reason_code`, `reason_note` and `status`).
  - `kind = ADJUSTMENT` reason codes: `FOUND_STOCK`, `DATA_ENTRY_CORRECTION`, `OTHER`. Deltas may be positive or
    negative per line.
  - `kind = WRITE_OFF` reason codes: `DAMAGED`, `EXPIRED`, `SPOILED`, `THEFT_OR_LOSS`, `OTHER`. Deltas are negative.
  - `reason_note` (at most 500 characters) is required for `OTHER`.
  - Reversal works as for goods receipts.
- Document header updates are limited to the reversal columns by **column-level** `UPDATE` grants. No DELETE grant.
- Archived variants are rejected for opening and receipts. Untracked variants are rejected for every inventory
  operation.

## 12. Stocktake

### 12.1 Tables

- `stocktakes`: `business_id`, `id`, `location_id`, `status` (`DRAFT`, `POSTED`, `CANCELLED`), `version`, `note`,
  created, posted and cancelled actor and time, `business_date` (set at posting).
- At most one `DRAFT` stocktake per location: partial unique index `(business_id, location_id) WHERE status = 'DRAFT'`.
- `stocktake_lines`: `business_id`, `stocktake_id`, `variant_id` (`UNIQUE (business_id, stocktake_id, variant_id)`),
  `status` (`COUNTED` or `REMOVED`), `counted_quantity_minor` (0 or more), `expected_at_count_minor`,
  `balance_version_at_count`, `version`, counted-by and counted-at, and after posting `variance_minor`.

### 12.2 Counting

- Only variants that are counted are affected. Uncounted variants are never zeroed implicitly (partial counts).
- RecordStocktakeCount sets a line's counted quantity (direct quantity, or packs plus loose quantity summed by the
  server). It captures the current balance and balance version as `expected_at_count_minor` and
  `balance_version_at_count`. A new line needs no version; changing an existing line requires its `expectedVersion`.
- RemoveStocktakeLine marks a mistaken line `REMOVED`; it is ignored at posting.
- Each line change increments the stocktake's `version`. Line changes lock the stocktake `FOR UPDATE` and require
  status `DRAFT`.
- Archived variants with non-zero on-hand stock can be counted (section 17).

### 12.3 Blind-count workflow

- In the stocktake counting flow, `expectedAtCount` and variances are omitted from stocktake responses for actors
  without `inventory:count-post`, and counting screens do not display an expected figure. A STOCK_KEEPER therefore
  counts without being shown the expected quantity in that workflow.
- Purpose: to reduce **anchoring** during normal counting, so counters record what they see rather than what the
  system expects.
- **This is a workflow behaviour, not a security or confidentiality boundary.** STOCK_KEEPER keeps `inventory:read`
  and may view current stock elsewhere (stock list, movement history). The blind-count workflow does not prevent a
  determined counter from learning the expected quantity, and inventory quantities are not secret from any role that
  holds `inventory:read`.

### 12.4 Posting and its idempotency precedence

PostStocktake runs in this order:

1. Lock and load the stocktake `FOR UPDATE`.
2. **If `status = POSTED`:** return the existing posted result as a successful no-op (replay). No version check, no
   staleness check, no movement, no audit record. A retry after an ambiguous successful response never fails merely
   because the posting itself incremented the version.
3. If `status = CANCELLED`: `409 CONFLICT`.
4. Otherwise enforce `expectedVersion` (`409 VERSION_CONFLICT` on mismatch), so the poster confirms the lines they
   reviewed.
5. Lock the balances of the counted lines in `variant_id` order. If any line's current balance version differs from
   its `balance_version_at_count`, return `409 STOCKTAKE_STALE` listing those variant IDs (bounded). Nothing is
   written; the lines are counted again or reconfirmed.
6. For each `COUNTED` line: `variance = counted - current balance`. A non-zero variance creates one
   `COUNT_CORRECTION` movement; a zero variance creates none. Store `variance_minor` on the line, set `POSTED`, posted
   actor and time, and write `inventory.stocktake_posted`.

A `POSTED` stocktake is immutable. Corrections are a later stocktake or an adjustment. CancelStocktake mirrors the
precedence: `CANCELLED` is a no-op, `POSTED` is `409 CONFLICT`, and a `DRAFT` cancel writes no movement.

## 13. No monetary cost or valuation in Build 2

- No `Product.cost` or variant cost field, no unit cost on movements, receipts or adjustments, and no stock valuation
  report.
- Reason: a cost field would implicitly create a valuation policy (open decision 6) and accounting effects before the
  ledger posting foundation exists (`mvp-scope.md` implementation order; ADR-002 section 25).
- Quantity-only movements have no monetary or accounting effect, so Build 2 ships no "accounting effect later".
- The APPROVED Core MVP item "cost price where known" is **deferred**, not dropped. It is delivered with ADR-009.

## 14. Selling price

- `product_variant_prices` (append-only, INSERT and SELECT only): `business_id`, `id`, `variant_id`, `amount_minor`
  (`BIGINT`, greater than zero), `currency`, `price_version`, `effective_at`, `set_by_membership_id`, `reason`
  (optional, at most 500 characters).
- The currency must equal the business currency. This is enforced by a composite FK `(business_id, currency) ->
businesses (id, currency_code)` (a UNIQUE on `businesses (id, currency_code)` is added), and a different currency
  is rejected by the application.
- The variant holds the current price and `price_version`, updated in the same transaction as the history row.
  `price_version` is the basis for a later `pricingVersion` in offline commands (ADR-002 section 25).
- Price is optional in Build 2 ("not priced yet"); Build 3 decides whether a sale requires one.
- **Per stock unit:** for a `KG` variant the price is per kilogram. Pack prices are not in Build 2.
- **Business-wide**, not per location. No promotions, discounts or tax here.
- Setting the current price again is a successful no-op. Past transactions are never recomputed (there are none yet;
  Build 3 snapshots the price on each line).

## 15. Permissions

Default deny. Ten permissions are added to the ADR-005 catalogue (three `product:*`, seven `inventory:*`); they are
derived from the role at context resolution, as in Build 1.

| Permission             | OWNER | MANAGER | CASHIER | STOCK_KEEPER | ACCOUNTANT | Use cases                                                         |
| ---------------------- | ----- | ------- | ------- | ------------ | ---------- | ----------------------------------------------------------------- |
| `product:read`         | yes   | yes     | yes     | yes          | yes        | List, search and get products, categories, packs, price history  |
| `product:manage`       | yes   | yes     |         | yes          |            | Create, update, archive and reactivate products; categories; packs |
| `product:price`        | yes   | yes     |         |              |            | SetSellingPrice                                                   |
| `inventory:read`       | yes   | yes     | yes     | yes          | yes        | Balances, movement history, documents, thresholds and the derived low-stock state |
| `inventory:threshold`  | yes   | yes     |         | yes          |            | SetLowStockThreshold, ClearLowStockThreshold                      |
| `inventory:opening`    | yes   | yes     |         |              |            | RecordOpeningStock                                                |
| `inventory:receive`    | yes   | yes     |         | yes          |            | PostGoodsReceipt                                                  |
| `inventory:adjust`     | yes   | yes     |         |              |            | RecordAdjustment, RecordWriteOff, ReverseGoodsReceipt, ReverseAdjustment |
| `inventory:count`      | yes   | yes     |         | yes          |            | CreateStocktake, RecordStocktakeCount, RemoveStocktakeLine        |
| `inventory:count-post` | yes   | yes     |         |              |            | PostStocktake, CancelStocktake, see expected quantities           |

- Creating a product with an initial price requires both `product:manage` and `product:price`.
- CASHIER and ACCOUNTANT are read-only in Build 2. Offline permissions remain with the sync ADR (open decision 3).

## 16. Audit

Business stream, written in the same transaction (ADR-004 section 8). Payloads are built explicitly with ADR-006
fields; no entity is serialized.

| Action                          | Entity type               | Payload (bounded)                                                    | Reason   |
| ------------------------------- | ------------------------- | -------------------------------------------------------------------- | -------- |
| `product.created`               | `product`                 | variant ID, name, SKU, barcode, stock unit, track flag, category ID  |          |
| `product.updated`               | `product`                 | from and to values for changed identifying fields; description-changed flag |   |
| `product.archived`              | `product`                 | variant ID                                                           | optional |
| `product.reactivated`           | `product`                 | variant ID                                                           |          |
| `product.price_set`             | `product`                 | variant ID, from and to minor amounts, currency, price version       | optional |
| `product_category.created`      | `product_category`        | name                                                                 |          |
| `product_category.updated`      | `product_category`        | from and to name                                                     |          |
| `product_category.archived`     | `product_category`        | none                                                                 |          |
| `product_pack.added`            | `product_pack`            | variant ID, name, factor                                             |          |
| `product_pack.retired`          | `product_pack`            | variant ID                                                           |          |
| `inventory.opening_recorded`    | `inventory_opening_batch` | line count                                                           |          |
| `inventory.received`            | `goods_receipt`           | line count, reference present flag                                   |          |
| `inventory.receipt_reversed`    | `goods_receipt`           | line count                                                           | required |
| `inventory.adjusted`            | `inventory_adjustment`    | reason code, line count                                              | required |
| `inventory.written_off`         | `inventory_adjustment`    | reason code, line count                                              | required |
| `inventory.adjustment_reversed` | `inventory_adjustment`    | kind, line count                                                     | required |
| `inventory.stocktake_started`   | `stocktake`               | none                                                                 |          |
| `inventory.stocktake_cancelled` | `stocktake`               | counted line count                                                   | optional |
| `inventory.stocktake_posted`    | `stocktake`               | counted line count, correction movement count, zero-variance count   |          |
| `inventory.low_stock_threshold_set`     | `inventory_stock_threshold` | variant ID, stock unit, from threshold (absent if none), to threshold |  |
| `inventory.low_stock_threshold_cleared` | `inventory_stock_threshold` | variant ID, stock unit, from threshold                              |  |

- The envelope carries actor, membership, verified device, `location_id`, channel and correlation ID. For threshold
  actions the envelope's business and `location_id` plus the payload's variant ID identify the setting. Threshold
  values use the integer-string field kind below. No stock quantity or movement history is included.
- **New field kind:** a bounded base-10 integer-string field (for `bigint` quantities and minor-unit amounts), because
  `auditField.integer` accepts JavaScript safe integers only. Its maximum length and sign rules are declared per
  field. The registry secret-name test still applies.
- **Per-line before and after** values are carried by the movements (`quantity_delta_minor`, `balance_after_minor`,
  `balance_version`), which are append-only and reference the audited document. The 8 KiB payload cap therefore never
  forces per-line detail into the audit record.
- Successful no-ops write no audit record. Denials are logs, not audit.
- The audit entity-type union is extended with the entity types above.

## 17. Archive, no-delete and residual-stock visibility

- `products`, `product_variants`, `product_categories`, `product_packs`, `product_variant_prices`, the four inventory
  document tables, `stocktake_lines`, `inventory_movements`, `inventory_balances` and `inventory_stock_thresholds`
  have **no DELETE grant**, join the
  ESLint no-delete list, and are checked by `verify-schema.mjs`. Even an unused product is archived, not deleted, in
  Build 2.
- Archiving a product is allowed whatever its stock. An archived product accepts no opening stock and no goods
  receipt, but **may still be adjusted, written off and counted** so remaining stock can be cleared.
- **Residual-stock visibility (required):** an archived variant with a non-zero balance at a location stays
  discoverable in inventory administration and stocktake flows.
  - API: the stock list (`GET .../inventory/balances`) returns every ACTIVE tracked variant (on-hand zero when no
    balance row exists) and every ARCHIVED variant with a non-zero balance, with `productStatus`, the threshold and the
    derived `lowStock` flag, and a `lowStock=true` filter. Archived items never carry `lowStock = true` (section 7.4). An inventory item search used by adjustment, write-off and stocktake flows includes
    ACTIVE variants and ARCHIVED variants with non-zero stock. Catalog list and search default to ACTIVE, with an
    explicit `status=ARCHIVED` filter.
  - Clients: inventory and stocktake screens show archived items with residual stock, labelled "Archived", and never
    show a LOW STOCK indicator for them (they are not reorder candidates). The normal catalog and future selling
    search may hide them.
  - An archived variant with zero stock is reachable only through the catalog's archived filter.
- SKUs stay reserved after archiving; barcodes are released (section 5).

## 18. AI and offline boundaries

- AI code may not import catalog or inventory repositories or call their mutating use cases (`40-ai-safety.mdc`).
  Build 2 adds a dependency-cruiser rule and a boundary test for the new modules.
- Future text, voice, photo or WhatsApp flows produce typed proposals (for example `ProposedGoodsReceipt`,
  `ProposedAdjustment`). After a person confirms, the same keyed use cases run under that person's context,
  permissions and idempotency, and the audit record carries the proposal ID. No proposal tables are created in
  Build 2.
- **Offline is not built in Build 2.** The offline catalog view and offline-queued inventory operations remain MVP
  obligations of the later sync build. The movement fields, typed IDs, keyed idempotency and `price_version` above are
  chosen so that offline replay can be added without changing history.

## 19. Ledger and accounting dependency

- **Decided here without a ledger ADR:** catalog master data, units and quantities, quantity-only movements and
  balances, documents, stocktakes, low-stock thresholds and the derived low-stock state, the Build 2 negative-stock
  rule, selling price as master data, permissions and audit.
- **Not allowed until the ledger/accounting ADR is accepted:** unit-cost authority, inventory valuation, COGS, journal
  entries, tax treatment, and any `SALE` inventory mutation. Build 3 implementation starts only after it is accepted.
- **Recommended future ADRs (proposals only; numbers are not reserved by this ADR):**
  - ADR-009: ledger posting foundation, chart of accounts and inventory valuation. Needs accounting review. It decides
    the valuation method (open decision 6), COGS posting, cost capture on receipts, and the opening valuation of stock
    already held as quantity only.
  - ADR-010: configurable tax treatment. Needs accounting review.

## 20. Error codes added with the implementing slices

| Code                 | HTTP | Meaning                                                          |
| -------------------- | ---- | ---------------------------------------------------------------- |
| `VERSION_CONFLICT`   | 409  | `expectedVersion` does not match the current version             |
| `INSUFFICIENT_STOCK` | 409  | A manual decrease would take on-hand below zero (section 10)     |
| `STOCKTAKE_STALE`    | 409  | Counted lines whose balance changed since counting (section 12.4) |

Uniqueness collisions (SKU, active barcode, category name, active pack name) and invalid transitions use the existing
`409 CONFLICT`. Cross-tenant identifiers are `404`.

## 21. Alternatives considered

- **Defer variants, stock on the product.** Simpler now, but contradicts the canonical movement shape and the APPROVED
  "products and variants", and forces a stock-history migration later. Rejected.
- **Full multi-variant catalog in Build 2.** Not needed by the pilot profile yet. Rejected for now.
- **One stock unit only (option A).** Merchants who buy cartons and sell units would convert by hand. Rejected.
- **Pack selling and pack prices now.** Belongs with Sales. Deferred.
- **`NUMERIC` quantities.** Exact, but adds a second numeric model beside `Money` and Prisma `Decimal` handling.
  Scaled integers match `Money`. Rejected.
- **Balance computed from movements on every read.** Rebuildable, but slower, with no natural lock target. Rejected in
  favour of a transactional projection with a rebuild check.
- **Serializable isolation instead of row locks.** More retries under contention, no stronger guarantee here.
  Rejected.
- **Polymorphic `source_type`/`source_id`.** Not enforceable. Rejected (section 8).
- **A generic `InventoryDocument` table.** Uniform, but the documents differ in lifecycle and fields. Rejected.
- **Pack barcodes in Build 2.** Not enforceable across two tables without a registry. Deferred (section 3.4).
- **Rejecting GTIN-length codes with a bad check digit.** Would block real merchant codes. Rejected.
- **Recording unit cost now as non-posting evidence.** Creates valuation inputs and accounting meaning before the
  ledger decision. Rejected.
- **Location-specific prices.** One location in the pilot. Deferred.

## 22. Consequences

- Positive: exact, auditable, tenant-safe stock with database-enforced sources and balances that can always be
  verified against movements. Sales, purchasing and offline sync extend the model rather than replace it.
- Negative and risks:
  - pack selling, pack barcodes, multiple barcodes and the offline catalog are not in Build 2;
  - the low-stock indicator is deliberately minimal: no alerts, forecasting or reorder suggestions;
  - the seed unit list may be incomplete for local measures;
  - the stocktake staleness rule may cause recounts once sales exist;
  - the blind-count workflow reduces anchoring but is not a security boundary (section 12.3);
  - quantity-only stock needs an opening valuation when ADR-009 introduces costing.
- Financial integrity: no monetary effect in Build 2; no hard deletes; reversals are new movements; append-only
  movements and price history.
- Tenancy: composite FKs on every reference; every query takes `business_id`; cross-tenant tests for every endpoint.
- Audit and idempotency: as sections 9 and 16.
- AI safety: unchanged; AI can only propose.
- Migration and rollback: forward-only migrations per slice; each slice is a separate PR; nothing is deployed beyond
  local and test environments by Build 2.

## 23. Compliance with governance rules

- `00-architecture.mdc`: logic in domain and application services; clients format only; no new datastore or service.
- `10-database.mdc`: `BIGINT` quantities, NOT NULL `location_id`, append-only movements, a same-transaction cached
  balance rebuildable from movements, composite tenant keys, `verify-schema.mjs` expectations.
- `20-financial-integrity.mdc`: canonical movement types only; no stock overwrite (counts create
  `COUNT_CORRECTION`); explicit negative-stock policy; reversals reference originals; no accounting effect without the
  ledger foundation.
- `30-multitenancy.mdc`: business and location from the resolved context; related IDs verified by composite FKs.
- `40-ai-safety.mdc`: section 18.
- `50-api.mdc`: `Idempotency-Key` on creating inventory mutations; pagination; quantities and money as strings.
- `60-testing.mdc`: Plan 004 requires the six mandatory cases, concurrency tests and balance-equals-movements after
  every scenario.
- `70-security.mdc`: input validation and bounds; no secrets in payloads.
- `data-principles.md` section 4 lists `unit cost where relevant` for movements; Build 2 has none (section 13).

## 24. Changes to other documents

- **Open decision 9 is partially resolved by this ADR, not fully closed.**
  - This ADR resolves the **Build 2 inventory portion**: the `Quantity` representation, the stock unit and its
    semantics, `ProductPack` integer conversions, and pack use for opening, receiving, adjustment and count data
    entry.
  - This ADR does **not** resolve: selling by pack, pack-level selling prices, purchasing or commercial cost by pack,
    transaction-line pack selection and snapshots, or any other Build 3 commercial pack semantics.
- **On acceptance of this ADR (2026-10-05),** in the same change:
  1. the Quantity, stock-unit and data-entry pack model is recorded as an APPROVED product decision in
     `mvp-scope.md`, by reference to this ADR (sections 3.4 and 4);
  2. open decision 9 is narrowed to the commercial pack semantics for sales and purchasing listed above.
- Open decision 6 (inventory valuation) is unchanged and still open. No other APPROVED text changes.
- The low-stock indicator is already APPROVED Core MVP scope; section 7.4 implements it without changing that text.
- No change to `data-principles.md` is needed: the movement types used are canonical.

## 25. Deferred items

Multi-variant UI and options; pack selling and pack prices; pack barcodes (shared identifier registry); multiple
barcodes per variant; low-stock notifications, push alerts, forecasting, automatic reorder points, reorder
quantities, supplier recommendations, automatic purchasing and AI-generated restock orders; camera barcode scanning; location selection and
additional locations; transfers (post-MVP); per-business negative-stock configuration (Build 3); cost price,
valuation, COGS and tax (ADR-009, ADR-010); offline catalog and offline inventory commands (sync ADR); supplier and
purchase-order links on goods receipts (purchasing); duplicate-name warnings.

## 26. Human approval record

- **Accepted 2026-10-05 by the human maintainer**, after AI-assisted design and review. The ADR was drafted with AI
  assistance; the AI agent did not accept it.
- History: the Build 2 plan was approved with changes on 2026-10-05, and this ADR incorporates those changes. A second
  review on 2026-10-05 resolved three items, also incorporated: the low-stock indicator is Build 2 scope (section
  7.4); blind counting stays a workflow default, not a security guarantee (section 12.3); open decision 9 is
  partially resolved, not closed (section 24).
- Two implementation clarifications are recorded as accepted behaviour for Plan 004 slices S5 and S6: the version-0
  semantics for initial threshold creation (section 7.4) and the cross-location stock-unit-change guard (section 3.2).
- **What acceptance unblocks:** Build 2 implementation may proceed to Slice 1, in the order of Plan 004.
- **What acceptance does not mean:**
  - no catalog or inventory code, schema or migration exists yet, and no implementation test has passed;
  - no package is approved by this acceptance; any new dependency still needs review;
  - unit cost authority, inventory valuation, COGS, the `SALE` movement use case, journal posting and tax behaviour
    remain out of Build 2; ADR-009 must be accepted before valuation or Sales implementation, and ADR-010 remains the
    future tax-treatment decision;
  - commercial pack semantics (open decision 9, as narrowed) and inventory valuation (open decision 6) remain open.
