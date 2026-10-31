# ADR-009. Ledger posting foundation, chart of accounts and inventory valuation

- Status: ACCEPTED (2026-10-15); **amended 2026-10-29** (section 38). The original acceptance is unchanged.
- Date: 2026-10-15
- Deciders: Tali maintainers (human approval given 2026-10-15), with review by the business's accountant (complete,
  section 32; reversal-residual clarification 2026-10-29, section 38). Drafted by an AI agent from the reviewed
  Build 3 planning report and the maintainer's Build 3 direction (2026-10-15), accepted by the human maintainer.
  Acceptance record in section 37; amendment record in section 38.
- Related: `docs/product/mvp-scope.md` ("Ledger from the first sale", Core MVP ledger and inventory, open decisions 5
  and 6); `docs/architecture/data-principles.md` sections 2 to 4, 11 to 14; `.cursor/rules/20-financial-integrity.mdc`;
  `.cursor/rules/10-database.mdc`; ADR-002 sections 13, 14 and 25; ADR-004; ADR-005 sections 5, 8, 12 and 19; ADR-006;
  ADR-008 sections 7 to 13, 19 and 25; ADR-010 (accepted); ADR-011 (accepted); `docs/plans/005-build-3-sales-ledger.md`;
  `docs/reviews/build-3-accountant-review.md`
- Scope: Build 3. The ledger posting foundation that must exist before or with the first sale, the default chart of
  accounts, and perpetual inventory valuation with cost of goods sold.

## 1. Context

Build 2 delivered a quantity-only catalog and inventory (ADR-008). It records stock movements and balances but no
money value: goods receipts and opening stock carry no cost, and there is no ledger. ADR-008 section 19 forbids unit
cost, valuation, COGS, journal entries, tax treatment and any `SALE` movement until this ADR is accepted, and names
this ADR as the place that decides the valuation method (open decision 6), COGS posting, cost capture on receipts and
the opening valuation of stock already held as quantity only.

Constraints that already apply:

- `mvp-scope.md`: the ledger posting foundation (chart of accounts, deterministic posting rules, balanced journal
  entries) exists before or together with the first sales implementation; sales post correct accounting entries from
  their first production-capable release. The later "ledger/reporting completion" milestone (implementation step 7)
  covers reporting, account management, period controls and accountant review capabilities.
- `data-principles.md` section 3: double entry; every entry balances per currency; entries are immutable once posted;
  corrections are new reversal or adjustment entries; balances are derived from entries, cached only when updated in
  the same transaction and verifiable. Section 4: "Inventory valuation (cost method) is decided by ADR and applied
  consistently; movements that affect value post corresponding ledger entries."
- `20-financial-integrity.mdc`: deterministic domain services; no floating-point money; integer minor units with
  currency; one currency per business; no hardcoded currency; audit in the same transaction; idempotency for every
  financial entry point; posted amounts immutable.
- ADR-002 section 13: `Money { amountMinor: bigint; currency }`; a fixed-scale `NUMERIC` is allowed only for derived
  unit costs if this ADR approves it. This ADR does **not** need that exception (section 18).
- ADR-004: one `UnitOfWork.run` per mutation; keyed idempotency; audit in the same transaction; no external effects
  inside the transaction.
- ADR-005 section 5 leaves open whether currency or time zone may change once financial activity exists. This ADR
  answers for currency only (section 14).
- The human maintainer's Build 3 direction (2026-10-15): modular-monolith PostgreSQL ledger; stable account roles;
  no public arbitrary-journal API; derived balances; no account-management UI or period close in Build 3; perpetual
  weighted average cost, not FIFO; explicit valuation status; unvalued stock never silently backfilled.
- The maintainer's review decisions M1 to M16 (2026-10-15), recorded in `docs/plans/005-build-3-sales-ledger.md`
  section 4. Those that affect this ADR are applied in place.

## 2. Decision summary

1. A **`ledger` module** inside the modular monolith owns accounts, journal entries and journal lines in PostgreSQL
   (section 3).
2. **Per-business accounts** created from a versioned **chart-of-accounts template** (sections 4 to 6).
3. Posting rules address **stable system account roles**, never account codes or names (section 5).
4. **JournalEntry** and **JournalLine** with an explicit **DEBIT/CREDIT direction and a positive amount** (sections 7
   to 9).
5. Every entry **balances**; enforced in the domain, re-checked by an operator script (section 10).
6. Posted entries are **immutable**; corrections are **reversal entries** that mirror the original exactly
   (sections 11 and 12).
7. **Typed source relationships**: each entry references exactly one source document (section 13).
8. **One business currency**; the business currency becomes immutable once financial history exists. Time zone is
   not frozen (section 14).
9. **Server time is authoritative** for online postings; the business date is derived from server recording time in
   the business time zone; device-reported time is evidence only and can never backdate a posting (section 15).
10. **No cached account balances** in Build 3 (section 16).
11. **No public posting API**; only application services post, inside their own transaction (section 17).
12. **Perpetual weighted average cost (WAC)** in a "total value" form: no sub-minor unit costs are stored
    (section 18).
13. Each stock item has an explicit **valuation status, `VALUED` or `UNVALUED`**, tracked in a valuation projection
    beside the Build 2 balance, without rewriting quantity history (section 19).
14. **Initial opening valuation** values legacy, never-valued stock through an explicit, audited action against
    `OPENING_BALANCE_EQUITY`. A **later operational valuation** of an item that became `UNVALUED` during normal
    operations posts the difference as an inventory gain (`INVENTORY_GAIN`) or shrinkage (`INVENTORY_SHRINKAGE`),
    never to `OPENING_BALANCE_EQUITY` (section 20).
15. **Cost capture** on future goods receipts and opening stock, by OWNER or MANAGER only (section 21).
16. Sale lines **snapshot their cost and cost status** (section 22).
17. **Unvalued stock** keeps working for quantity and sales, but posts no COGS and shows no authoritative value or
    margin; nothing is backfilled later; recorded inventory value is disclosed as incomplete while any item is
    `UNVALUED` (section 23).
18. **COGS and inventory asset postings** follow fixed rules (sections 24 and 25).
19. Reversals restore **exactly the snapshotted value** (section 26). The `REVERSAL` journal remains an exact
    line-by-line mirror (section 12).
20. When that exact inventory-value reversal would leave an invalid recorded-value state, a same-transaction
    **`REVERSAL_RESIDUAL`** stock valuation and `ORIGINAL` journal restore a valid, non-negative projection
    (section 26.1; amendment 2026-10-29, section 38). Residual lines are never added to the `REVERSAL` entry.
21. Audit, idempotency, concurrency, rollout and operator checks (sections 27 to 30).

## 3. Ledger module boundaries

- New module `ledger` with the standard layering: `packages/domain/src/modules/ledger` (accounts, journal entry
  invariants, posting plan, reversal), `packages/application/src/modules/ledger` (chart provisioning, the internal
  posting service, read use cases, ports), `packages/database` (repositories, schema), read-only API routes.
- Valuation belongs to the **inventory** module (it is a property of stock items) and calls the ledger posting port.
- The ledger owns its tables. Other modules post only through the ledger's application port, inside their own
  `UnitOfWork.run`; they never write ledger tables directly.
- A new dependency-cruiser rule restricts imports of the ledger posting port to the application modules that own
  posting sources (`sales`, `inventory` in Build 3). The existing `ai-no-catalog-inventory` rule is extended so AI
  code can never reach the ledger (`40-ai-safety.mdc`).
- Not in this ADR: reporting, account management, period close, receivables, payables, payments, purchasing
  accounting beyond the clearing account needed for valuation (section 21), external accounting export.

## 4. Account model

`ledger_accounts`, one row per business account:

| Column                          | Meaning                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `business_id`, `id` (UUIDv7)    | Tenant key and identity; `UNIQUE (business_id, id)` for composite foreign keys.         |
| `code`                          | Display code from the template (for example `1000`); unique per business; not used by posting rules. |
| `name`                          | Display name from the template; not used by posting rules.                               |
| `type`                          | `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `CONTRA_REVENUE`, `EXPENSE`.                  |
| `normal_balance`                | `DEBIT` or `CREDIT`, derived from the type and stored for clarity (CHECK).              |
| `system_role`                   | The stable role (section 5); unique per business among roles; NULL for future user accounts. |
| `template_version`              | The chart template version that created it.                                              |
| `status`                        | `ACTIVE` only in Build 3 (no archive without account management).                        |
| `created_at`                    | Timestamp.                                                                               |

- Accounts are never deleted. Build 3 has no use case that renames, recodes or adds accounts.
- The app role gets SELECT and INSERT only.

## 5. Stable system account roles

Posting rules name a role; the posting service resolves it to the business's account. Build 3 roles:

| Role                        | Type           | Used for                                                                 |
| --------------------------- | -------------- | ------------------------------------------------------------------------ |
| `CASH_ON_HAND`              | ASSET          | `CASH` tenders                                                           |
| `BANK_TRANSFER_PENDING`     | ASSET          | `BANK_TRANSFER` tenders, not externally verified (ADR-011 section 13)    |
| `POS_CARD_CLEARING`         | ASSET          | `POS_CARD` tenders awaiting settlement                                   |
| `OTHER_TENDER_CLEARING`     | ASSET          | `OTHER` tenders                                                          |
| `INVENTORY`                 | ASSET          | Inventory asset at WAC                                                   |
| `SALES_REVENUE`             | REVENUE        | Gross line revenue (before line discount; excluding tax)                 |
| `SALES_DISCOUNTS`           | CONTRA_REVENUE | Line discounts                                                           |
| `TAX_PAYABLE`               | LIABILITY      | Tax collected (ADR-010; unused while no tax is configured)               |
| `COST_OF_GOODS_SOLD`        | EXPENSE        | COGS for valued sale lines                                               |
| `INVENTORY_SHRINKAGE`       | EXPENSE        | Valued write-offs, decreasing adjustments, count shortages, and decreases from operational valuation (section 20.3) |
| `INVENTORY_GAIN`            | REVENUE        | Valued increasing adjustments, count surpluses (A9), and increases from operational valuation (section 20.3) |
| `OPENING_BALANCE_EQUITY`    | EQUITY         | Counter-entry for initial opening valuation and valued opening stock only (section 20.2); not for later operational valuation |
| `GOODS_RECEIVED_NOT_INVOICED` | LIABILITY    | Counter-entry for goods receipts with cost, until purchasing (step 9)    |

Every role is exactly one account per business in Build 3. Later builds may add roles (receivables, payables, bank
accounts) through a new template version; existing roles are never repurposed.

## 6. Chart-of-accounts template

- A versioned template in `packages/domain` (pure data): version `1` creates one account per role in section 5 with
  the codes and names in the accountant review pack, section 3. The template is accountant-approved (A1, A2).
- Provisioning is an application use case, `ProvisionChartOfAccounts`, idempotent by `(business_id,
  template_version)`. It runs in the same transaction as business creation for new businesses, and once for each
  existing business during rollout (section 29).
- Posting fails closed with `LEDGER_NOT_PROVISIONED` if a required role is missing; nothing is written.
- Names and codes are display data. Changing them, adding accounts or archiving accounts is account management
  (implementation step 7), not Build 3.

## 7. JournalEntry

`journal_entries`:

| Column                                   | Meaning                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `business_id`, `id` (UUIDv7)             | Tenant key and identity.                                                      |
| `currency`                               | Must equal the business currency (composite FK to `businesses (id, currency_code)`, as for prices). |
| `occurred_at`                            | The source event's occurrence time; for online Build 3 mutations, the **server receipt time** (section 15). |
| `business_date`                          | Derived from `occurred_at` (server time online) in the business time zone (section 15). |
| `recorded_at`                            | Server time at which the entry was durably posted.                            |
| `entry_kind`                             | `ORIGINAL` or `REVERSAL`.                                                     |
| typed source columns                     | Exactly one non-null (section 13).                                            |
| `reverses_entry_id`                      | Set only on a `REVERSAL`; composite FK; `UNIQUE (business_id, reverses_entry_id)`. |
| `posting_rule`, `posting_rule_version`   | Which deterministic rule produced the lines (for example `SALE_POSTED`, `1`). |
| `actor_membership_id`, `device_id`, `location_id`, `source_channel`, `correlation_id` | Recording envelope, as on inventory movements. |
| `description`                            | Short system text (for example "Sale S-000123"); never free user input.       |

## 8. JournalLine

`journal_lines`:

| Column                        | Meaning                                                                   |
| ----------------------------- | ------------------------------------------------------------------------- |
| `business_id`, `entry_id`, `line_number` | Primary key; composite FK to the entry.                        |
| `account_id`                  | Composite tenant FK to `ledger_accounts`.                                  |
| `direction`                   | `DEBIT` or `CREDIT`.                                                       |
| `amount_minor`                | `BIGINT`, `CHECK (amount_minor > 0)`.                                      |
| `currency`                    | Equal to the entry currency (composite FK to the entry's `(business_id, id, currency)`). |
| `memo_kind`                   | Optional bounded enum describing the line (for example `TENDER_CASH`, `COGS`). |

Lines are aggregated per account and memo kind for one source document; per-item detail lives in the source records
(sale lines, tenders, movement valuations), not in journal lines.

## 9. DEBIT/CREDIT representation

**Decision:** an explicit `direction` plus a strictly positive `amount_minor`.

- Alternative considered: signed amounts (positive debit, negative credit). Rejected: easier to misread, and a zero or
  sign error cannot be caught by a simple CHECK.
- Zero-amount lines are never written; a rule that would produce a zero line omits it.

## 10. Entry balancing

- The domain builds a `PostingPlan` (lines with role, direction, amount) and refuses it unless it has at least two
  lines and the sum of debits equals the sum of credits, in the entry currency. Unbalanced plans are programming
  errors and abort the transaction.
- Entries and their lines are inserted in the same statement batch inside the source mutation's transaction.
- `db:ledger-consistency` (section 30) re-verifies every entry. A database constraint trigger is not used: business
  rules stay out of triggers (`00-architecture.mdc`); the CHECKs cover what a row-level constraint can.

## 11. Immutability

- The app role gets SELECT and INSERT only on `journal_entries` and `journal_lines`. No UPDATE, DELETE or TRUNCATE;
  foreign keys to them use `ON DELETE RESTRICT`; both tables join the protected and no-delete lists of
  `verify-schema`.
- An entry is never edited. A wrong entry is corrected only by its reversal, followed where needed by a new original.

## 12. Reversal entries

- A reversal is a new `REVERSAL` entry that references the original, copies every line with the opposite direction
  and the same amount and account, and has the same currency. An original is reversed at most once.
- A reversal is posted only by the reversal use case of its source (for example the full sale reversal, ADR-011
  section 21); there is no generic "reverse entry" API.
- Reversal date: the reversal carries the **business date on which the reversal is recorded**, not the original's
  (maintainer decision M12; accountant confirmation A13). The original keeps its own date. Future accounting-period
  controls may prevent postings into closed periods; a reversal never posts into the original's date.
- **Amended 2026-10-29 (section 38):** a residual inventory-value correction after a document reversal is **not**
  extra lines on this `REVERSAL` entry. The `REVERSAL` remains an exact mirror (same typed source, currency,
  accounts/system roles, amounts, memo kinds, number and order of lines, opposite DEBIT/CREDIT). The correction is
  a separate `ORIGINAL` journal sourced by a `REVERSAL_RESIDUAL` stock valuation (section 26.1). Exact-mirror
  validation is not relaxed.

## 13. Typed source relationships

Following ADR-008 section 8, each entry has exactly one non-null typed source column, with a composite foreign key
and a CHECK that exactly one is set:

| Source column                | Source document                                  | Introduced by          |
| ---------------------------- | ------------------------------------------------ | ---------------------- |
| `sale_id`                    | Sale (ADR-011)                                   | Sales persistence slice |
| `opening_batch_id`           | Opening stock with cost (section 21)             | Valuation slice        |
| `goods_receipt_id`           | Goods receipt with cost (section 21)             | Valuation slice        |
| `adjustment_id`              | Valued adjustment or write-off (section 25)      | Valuation slice        |
| `stocktake_id`               | Valued count corrections (section 25)            | Valuation slice        |
| `valuation_id`               | Stock valuation document (section 20)            | Valuation slice        |

- One `ORIGINAL` entry per source document at most (partial unique index on each source column where `entry_kind =
  'ORIGINAL'`). A reversal carries the same source column as its original.
- Future sources (payments, expenses, purchasing) add their own column, CHECK and FK in the migration that introduces
  them. There is no polymorphic `source_type`/`source_id`.

## 14. Currency rules

- Every entry and line is in the business currency; a posting plan in any other currency is rejected
  (`CURRENCY_MISMATCH`). No conversion, no multi-currency accounting.
- No currency is hardcoded: the posting service takes the currency from `BusinessContext` and the template carries
  no currency.
- **The business currency becomes immutable once financial history exists**: any journal entry, sale or valuation
  record for the business. The business-currency change path (if any is ever added) must check this inside its
  transaction and fail with `CONFLICT`. This answers the currency part of ADR-005 section 5.
- **Time zone is not frozen by this ADR.** Posted entries keep their stored business date and UTC timestamps
  regardless of any later time-zone change. Whether and how a business may change its time zone is a separate future
  business-setting decision.

## 15. Business date and timestamps

This applies the time vocabulary of ADR-002 section 15. For every online Build 3 mutation that posts to the ledger:

- The **authoritative time is server time**: `occurred_at` is the server receipt time of the request (as for Build 2
  inventory, ADR-008 section 7), and `recorded_at` is the server time the entry was durably posted (UTC
  `timestamptz`, from the server `Clock`).
- `business_date` is **derived from that server time** using the business time zone at that moment, and stored. It
  is never recomputed, including after a later time-zone change.
- A client- or device-reported time is **evidence only**. Where it is kept, it is stored on the source document as
  `device_reported_at` (ADR-002 section 15) and never on journal entries. It cannot set or backdate `occurred_at`,
  `business_date`, journal entries, inventory valuation, tax snapshots or any authorization decision (device clocks
  are not trusted, `70-security.mdc`).
- The later offline sync ADR decides how captured offline events are dated; nothing in Build 3 lets a client choose a
  posting date.
- No accounting periods exist in Build 3. The posting service has a single, documented check point where the future
  period-control milestone will reject postings into a closed period; in Build 3 it always allows.

## 16. No cached account balances in Build 3

Account balances are derived by summing lines (`SUM(CASE direction ...)`) per account, with an index on
`(business_id, account_id)`. No balance table, no running totals. A cache may be added later only if updated in the
same transaction and verifiable (`data-principles.md` section 3).

## 17. Posting permissions and boundaries

- There is **no public or arbitrary journal posting API**. Entries are created only as a side effect of an
  authorized business mutation (sale, valued stock change, valuation), inside that mutation's transaction, by a
  deterministic posting rule. The mutation's own permission governs it.
- Read access: new permission `ledger:read`, **OWNER and ACCOUNTANT only** in Build 3 (maintainer decision M14), for
  read-only routes listing accounts, account balances and a single entry with its lines. MANAGER has no raw journal
  access; MANAGER sees operational cost, COGS and margin through sales and inventory screens.
- Cost, COGS, inventory value and margin are visible to **OWNER, MANAGER and ACCOUNTANT only**, never to CASHIER or
  STOCK_KEEPER (maintainer decision M6). Responses omit these fields for other roles; this is enforced server-side by
  a new permission `inventory:cost-read` (OWNER, MANAGER, ACCOUNTANT).
- Posting rules are pure functions of the source record; same input and state give the same lines. No AI, randomness
  or external data in posting logic (`20-financial-integrity.mdc` rule 2).

## 18. Valuation method: perpetual weighted average cost (WAC)

**Decision (accountant-approved, A15):** perpetual moving weighted average cost per **stock item** (business,
location, variant), in a "total value" form.

- Each stock item tracks its on-hand quantity (Build 2 balance) and its recorded **value** in minor units of the
  business currency (section 19).
- An increase with a known cost adds that cost to the value.
- A decrease of quantity `q` from on-hand `Q` removes `value x q / Q`, rounded with `HALF_EVEN` (accountant-approved,
  A19). When `q = Q`, exactly the remaining value is removed, so no value is stranded and rounding never accumulates.
- No unit cost below the minor unit is stored; the average unit cost shown to users is a derived display value.
  ADR-002's `NUMERIC` exception is therefore not needed.
- **"Cost price where known"** (Core MVP item deferred by ADR-008 section 13) is delivered as this derived average
  cost of a `VALUED` stock item, fed by costs captured on opening stock, receipts and valuations (sections 20 and
  21). There is **no editable cost field on the product or variant**; WAC valuation is the authoritative cost basis
  (maintainer decision M3).

Alternatives considered:

| Method        | Assessment                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------ |
| FIFO          | Rejected by the maintainer: cost layers per receipt, harder reversals, poor fit for unknown cost. |
| Periodic inventory | Rejected: no COGS per sale, contradicts "movements that affect value post ledger entries".  |
| Standard cost | Rejected: requires maintained standards and variance accounting the pilot does not have.          |

## 19. Inventory valuation status and projection

Build 2 quantity history is not rewritten. Valuation is a parallel projection plus append-only valuation facts.

`inventory_valuations` (one row per stock item, created lazily when first needed):

| Column                       | Meaning                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `business_id`, `location_id`, `variant_id` | Primary key; composite FK to the stock item's balance.                     |
| `status`                     | `VALUED` or `UNVALUED`.                                                                  |
| `value_minor`, `currency`    | Recorded inventory value of this item in the ledger's `INVENTORY` account.               |
| `first_valued_at`            | Set once, when the item first becomes `VALUED`; NULL if it has never been valued. Distinguishes initial opening valuation from later operational valuation (section 20). |
| `version`                    | Incremented on every change (optimistic check and gap-free sequence).                    |
| `updated_at`                 | Timestamp.                                                                               |

`inventory_movement_valuations` (append-only, one row per movement recorded after the valuation slice is deployed):

| Column                       | Meaning                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `business_id`, `movement_id` | Primary key; composite FK to `inventory_movements`.                                      |
| `cost_basis`                 | `SUPPLIED_COST`, `WEIGHTED_AVERAGE`, `REVERSAL_OF_ORIGINAL` or `NOT_VALUED`.              |
| `value_delta_minor`          | Signed change to the item's value (zero when `NOT_VALUED`).                              |
| `value_after_minor`, `status_after` | Item value and status immediately after this movement. `value_after_minor` is the intermediate fact, not the current projection (see rules below). |
| `supplied_cost_minor`        | The total cost the user supplied, when any (also kept when not applied, as evidence).    |
| `journal_entry_id`           | The entry that posted this value change, when non-zero.                                  |

Rules:

- A stock item with no valuation row is `UNVALUED` with value zero. All Build 2 stock starts `UNVALUED`.
- **Invariant:** for every business, the balance of the `INVENTORY` account equals the sum of `value_minor` over its
  stock items. Checked by the operator script (section 30). `inventory_valuations.value_minor` (the **current
  projection**) is always `>= 0`.
- **Amended 2026-10-29 (section 38):** `inventory_movement_valuations.value_after_minor` may represent the exact
  intermediate value immediately after an exact reversal movement and **before** a same-transaction
  `REVERSAL_RESIDUAL` correction. A negative movement-fact `value_after_minor` is allowed **only** when
  `cost_basis = REVERSAL_OF_ORIGINAL` and the required residual correction is written in the same transaction.
  Ordinary WAC and non-reversal facts still require non-negative value-after. The reversal fact's
  `value_delta_minor` remains the exact negative of the original delta; it is never altered to avoid a residual.
- `VALUED` means the recorded value is authoritative for the whole on-hand quantity. `UNVALUED` means it is not:
  `value_minor` may be stale or zero, and Tali shows no inventory value, average cost or margin for the item.
- Transitions:
  - `UNVALUED -> VALUED` only through an explicit valuation action (section 20) or valued opening stock (section 21).
  - `VALUED -> UNVALUED` when an increase arrives without a cost (section 21) or a surplus arrives when on-hand is
    zero (section 25). The transition writes no journal entry; `value_minor` is unchanged until the next valuation.
- Every quantity change, valued or not, keeps working exactly as in Build 2.

## 20. Valuation of `UNVALUED` stock

### 20.1 Stock valuation document

- New append-only document table `stock_valuations` (referenced by the journal source column `valuation_id`): one
  stock item per document, `kind` (section 20.2, 20.3 or 20.4), `quantity_at_valuation_minor`,
  `balance_version_at_valuation` (staleness, as for stocktakes), `new_value_minor`, `previous_value_minor`, a
  **required** reason (1 to 500 characters), journal entry id, envelope fields, and `trigger_movement_id`
  (section 20.4).
- Client-facing `RecordStockValuation` is an explicit, authorized, keyed and audited action
  (`inventory.valuation_recorded`, section 27). It values the item's **current** on-hand quantity at its current
  balance version and creates only `INITIAL_OPENING` or `OPERATIONAL`. `REVERSAL_RESIDUAL` is never accepted from a
  client request (section 20.4).
- The user enters either a total value or a unit cost per stock unit for the item's current on-hand quantity; a unit
  cost is converted to the total with `HALF_EVEN` (accountant-approved, A19) and the total is what is stored.
- If the item's balance version changed after the user saw the quantity, the action fails with `VALUATION_STALE` and
  writes nothing.
- Valuing an item with zero on-hand sets it `VALUED` with value zero.
- Permission: new `inventory:value`, **OWNER and MANAGER only** (maintainer decision M5).
- Only `UNVALUED` items can be valued. Revaluing an already `VALUED` item is **not** offered in Build 3.
- For `RecordStockValuation`, the `kind` is decided by the server from `first_valued_at`, never chosen by the client.
  `REVERSAL_RESIDUAL` is decided only by the residual rule inside an authorized document reversal (section 26.1).

### 20.2 Initial opening valuation (`kind = INITIAL_OPENING`)

- Applies to an item that has **never** been `VALUED` (`first_valued_at` is NULL): legacy Build 2 stock and stock
  recorded without cost before the item was first valued.
- Effect (accountant-approved, A11 and A17): posts `new_value - previous_value` as Dr `INVENTORY` /
  Cr `OPENING_BALANCE_EQUITY`, sets `value_minor = new_value`, sets the status to `VALUED` and sets
  `first_valued_at`.
- `OPENING_BALANCE_EQUITY` is used **only** for this initial valuation of legacy or pre-ledger stock and for valued
  opening stock of a never-valued item (section 21).

### 20.3 Later operational valuation (`kind = OPERATIONAL`)

- Applies to an item that **was** `VALUED` and became `UNVALUED` during normal operations, for example after a
  receipt without cost (section 21) or a surplus at zero on-hand (section 25).
- Treatment (accountant-approved, A22): an **inventory gain / adjustment**, using the approved inventory adjustment
  accounts. Let `difference = new_value - previous_value` (`previous_value` is the item's recorded `value_minor`):
  - `difference > 0` (the valuation increases recorded inventory value): Dr `INVENTORY` / Cr `INVENTORY_GAIN`, amount
    `difference`;
  - `difference < 0` (the valuation decreases recorded inventory value): Dr `INVENTORY_SHRINKAGE` / Cr `INVENTORY`,
    amount `-difference`;
  - `difference = 0`: no journal entry (zero lines are never written, section 9); the document is still recorded and
    audited.
- **`OPENING_BALANCE_EQUITY` is never used for an operational valuation.**
- Conditions: the action is explicit and authorized (`inventory:value`), carries a required reason, is audited, uses
  the current on-hand quantity and balance version, and fails with `VALUATION_STALE` (nothing written) if stock
  changed since the quantity and value were reviewed.
- Effect: sets `value_minor = new_value` and the status to `VALUED`. The new total value is authoritative **from that
  point forward** only. It never rewrites prior movements, sales, COGS or journal entries, and it does not backfill
  COGS for sales recorded while the item was `UNVALUED` (section 23).

### 20.4 Reversal residual valuation (`kind = REVERSAL_RESIDUAL`) (added 2026-10-29)

- System/domain generated only, inside an authorized document-reversal transaction when section 26.1 Case B or
  Case C is triggered. Never a client `RecordStockValuation` kind.
- Carries the same business, location, variant, authorized actor/envelope and reversal reason as that reversal.
- `trigger_movement_id` is **required**; composite FK to the reversal `inventory_movements` row in the same
  business. At most one residual valuation per trigger movement. For `INITIAL_OPENING` and `OPERATIONAL`,
  `trigger_movement_id` is NULL. No generic source references.
- Its journal is a separate `ORIGINAL` entry with source `valuation_id`, posting rule `INVENTORY_REVERSAL_RESIDUAL`
  version 1 (section 26.1). It is not a `REVERSAL` entry.

## 21. Cost capture for future receipts and opening stock

- Opening stock and goods receipt lines accept an optional **total cost** for the line (preferred over a unit cost,
  because it is what the merchant paid; accountant-approved, A10). A unit-cost entry, if the UI offers it, converts to
  a total with `HALF_EVEN`.
- **Valued opening stock** (an item that has never been `VALUED`, opening quantity with cost): Dr `INVENTORY`,
  Cr `OPENING_BALANCE_EQUITY` (as section 20.2, accountant-approved, A11); the item becomes `VALUED` and
  `first_valued_at` is set.
- **Opening stock into an item that is or has been `VALUED`**: treated like a receipt without cost (below); a supplied
  cost is kept as evidence only, because `OPENING_BALANCE_EQUITY` is limited to never-valued stock. The item is then
  valued through a goods receipt with cost or an operational valuation (section 20.3).
- **Goods receipt with cost into a `VALUED` item**: `INVENTORY` debit, `GOODS_RECEIVED_NOT_INVOICED` credit (until
  purchasing, step 9, matches it to a supplier invoice). Value increases by the cost.
- **Goods receipt without cost into a `VALUED` item**: **allowed** (maintainer decision M4). The item becomes
  `UNVALUED` and no entry is posted; Tali never invents a cost. Its later valuation is an operational valuation
  (section 20.3).
- **Any receipt or opening into an `UNVALUED` item**: no entry; a supplied cost is kept as evidence on the movement
  valuation row (`NOT_VALUED`) and does not change the status. The item becomes `VALUED` only by a valuation action.
- Cost entry permission: entering a cost needs `inventory:value` (**OWNER and MANAGER only**) in addition to the
  receipt or opening permission. **STOCK_KEEPER may not enter costs** (maintainer decision M5); a STOCK_KEEPER's
  receipt is always without cost.
- Reversal of a valued receipt: the exact snapshotted value is reversed (section 26).

## 22. Sale-line cost snapshots

Each sale line records, at posting time: `cost_status` (`VALUED`, `UNVALUED`, or `NOT_APPLICABLE` for untracked
products, which have no movement and no COGS: maintainer decision M1), `cost_minor` (the COGS amount when `VALUED`,
otherwise NULL) and, for tracked lines, the stock item valuation version it read. These are immutable and are what a
reversal uses.

## 23. Unknown or unvalued cost, and disclosure

When a sale line's stock item is `UNVALUED`:

- the sale is recorded and its quantity leaves stock as usual;
- revenue, discount, tax and tender lines post as usual;
- **no COGS line and no inventory credit** are posted for that line; its movement valuation row is `NOT_VALUED`;
- the line snapshots `cost_status = UNVALUED`; the sale response and screens show "cost unknown" and no margin;
- the item appears in a "stock needing valuation" list;
- a later valuation action values the item **from that point on only**; it never creates COGS for earlier sales and
  never re-posts history. Correcting the accounting for earlier periods, if the accountant requires it, is a later,
  explicit adjustment decision (out of scope).

**Disclosure while any stock item is `UNVALUED`:**

- The item's **quantity remains authoritative**.
- Its recorded inventory value (`value_minor`, and therefore the `INVENTORY` account balance that includes it) is
  **incomplete and non-authoritative for management valuation purposes**.
- Sales continue, but COGS for the affected lines is **unknown and not posted**.
- Tali **must not present an authoritative margin** for affected lines, or for any sale or total that includes them.
- Future inventory-value and gross-margin reports must **visibly qualify or suppress** totals that include unvalued
  items or lines (for example "incomplete: 3 items unvalued"); Build 3 screens follow the same rule.
- The ledger remains **truthful about the values actually recorded**; it does not invent missing costs. Tali never
  claims a complete economic inventory valuation while unvalued stock exists.

## 24. COGS posting

For a `VALUED` sale line: COGS = the WAC removal value for the line quantity (section 18). Posted in the sale's own
journal entry: `COST_OF_GOODS_SOLD` debit, `INVENTORY` credit. COGS lines are aggregated per sale.

## 25. Inventory asset posting for other stock changes on valued items

Once an item is `VALUED`, every Build 2 stock change on it carries value:

| Movement                                     | Value change                | Journal entry                                         |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| `WRITE_OFF`, decreasing `ADJUSTMENT`         | WAC removal                 | Dr `INVENTORY_SHRINKAGE`, Cr `INVENTORY`              |
| `COUNT_CORRECTION` shortage                  | WAC removal                 | Dr `INVENTORY_SHRINKAGE`, Cr `INVENTORY`              |
| Increasing `ADJUSTMENT`, `COUNT_CORRECTION` surplus, on-hand above zero | At the current average (value x q / Q) | Dr `INVENTORY`, Cr `INVENTORY_GAIN` (accountant-approved, A9) |
| Same, with on-hand zero                      | None; item becomes `UNVALUED` (later valuation is operational, section 20.3) | None |
| `PURCHASE_RECEIPT`, `OPENING`                | Section 21                  | Section 21                                            |
| `SALE`                                       | Section 24                  | In the sale entry                                     |

For `UNVALUED` items none of these post anything. Build 2 adjustment, write-off and stocktake use cases gain this
behaviour in the valuation slice; their quantity rules are unchanged.

## 26. Exact reversal of snapshotted value

- Reversing a document reverses its journal entry exactly (section 12) and adds back exactly the snapshotted
  `value_delta_minor` of each original movement (`cost_basis = REVERSAL_OF_ORIGINAL`). The current average is never
  used for a reversal. There is no current-WAC recalculation on reversal.
- This holds whatever the item's status is now. If the item is now `UNVALUED`, its recorded `value_minor` may change
  but stays non-authoritative until it is valued.
- A reversal of a `NOT_VALUED` movement posts no value.
- **Amended 2026-10-29:** the exact reversal itself is unchanged when it would leave an invalid recorded-value
  state. A separate residual correction (section 26.1) then restores a valid projection so the `INVENTORY`
  invariant (section 19) holds at commit. Residual lines are never added to the `REVERSAL` journal.

### 26.1 Residual correction after an exact inventory-value reversal (added 2026-10-29)

Accountant choice C (2026-10-29; `docs/reviews/build-3-accountant-review.md` section 14.2), accepted by the
maintainer: apply the exact reversal, then create a separate inventory gain/shrinkage adjustment to bring inventory
value back to a valid state.

After applying the exact snapshotted inventory-value reversal, compute the **raw resulting recorded value** (current
projection plus the exact reversal `value_delta_minor` values). Do not invent a WAC restatement.

| Case | Condition | Residual |
| ---- | --------- | -------- |
| A | raw resulting value `>= 0` and no other invalid valued-state condition | None. |
| B | raw resulting value `< 0` | Exact reversal unchanged. Separate `REVERSAL_RESIDUAL` amount `abs(raw resulting value)`: Dr `INVENTORY` / Cr `INVENTORY_GAIN`. Final projection value `0`. If status before/after the reversal is `UNVALUED`, it remains `UNVALUED`; correcting to zero does not make missing cost authoritative. |
| C | resulting quantity `= 0` **and** status after the exact reversal would be `VALUED` **and** raw resulting value `> 0` | Exact reversal unchanged. Separate `REVERSAL_RESIDUAL` amount equal to the residual value: Dr `INVENTORY_SHRINKAGE` / Cr `INVENTORY`. Final projection value `0`; the item remains `VALUED`. |
| D | resulting quantity `= 0` **and** raw value `= 0` | None. |

The residual journal is:

- `entry_kind = ORIGINAL` (not `REVERSAL`);
- typed source = `valuation_id` of the `REVERSAL_RESIDUAL` stock valuation;
- `posting_rule = INVENTORY_REVERSAL_RESIDUAL`, `posting_rule_version = 1`.

It does not change `LedgerPostingService` exact-reversal validation.

The reversal movement valuation fact retains `value_delta_minor` = the exact negative of the original delta. If that
delta makes the raw value after that movement negative, the fact preserves that intermediate `value_after_minor`
(allowed to be negative only for `REVERSAL_OF_ORIGINAL` in this paired case). The following `REVERSAL_RESIDUAL`
document is what brings the **final** `inventory_valuations` projection to zero.

All of the following commit in **one** database transaction, or none do: document reversal; reversal inventory
movement(s); exact `REVERSAL` journal; movement valuation facts; residual stock valuation document (when required);
residual `ORIGINAL` journal (when required); final valuation projection; audit; idempotency state.

## 27. Audit

New ADR-006 actions, flat bounded payloads; detail stays in the immutable records:

- `ledger.chart_provisioned`: template version, account count.
- `inventory.valuation_recorded`: valuation id, kind, variant id, quantity, previous and new value, journal entry id.
  `REVERSAL_RESIDUAL` uses this same action when the accepted payload can represent the kind without ambiguity
  (kind is already enumerated). If a negative previous/raw value or `triggerMovementId` cannot be represented,
  make the smallest ADR-006-compliant `payload_schema_version` change. The residual payload identifies valuation
  id, kind `REVERSAL_RESIDUAL`, variant, previous/raw value as appropriate, final value, residual journal entry id,
  and a bounded reason/envelope. It does not serialize complete journals or movements. The document reversal's
  existing audit remains a separate record.
- Existing inventory actions and the sale actions (ADR-011) gain optional `journalEntryId`, `valueDeltaMinor` and
  `valuationStatusAfter` fields (new `payload_schema_version`).
- Journal entries are not separately audited: the source mutation's audit record identifies the entry. Journal lines
  are never copied into audit payloads.

## 28. Idempotency and concurrency

- Postings happen inside the source mutation's keyed transaction, so a replay replays the source and never posts
  twice. Valuation actions are keyed (`Idempotency-Key`).
- Lock order extends ADR-008 section 9: variants `FOR SHARE`, then balances `FOR UPDATE` in ascending variant order,
  then the matching `inventory_valuations` rows `FOR UPDATE` in the same order, then (for sales) the receipt counter.
  Ledger tables are insert-only and take no locks beyond foreign-key checks.
- Read-committed with explicit locks (ADR-004 section 9); a valuation action checks the balance version it was shown.

## 29. Migration and rollout for existing businesses

- Forward-only migrations add the ledger tables, the valuation tables, the typed journal source columns and the
  grants. No Build 2 table is rewritten; no historical movement gains a value.
- Chart provisioning for businesses that already exist is an idempotent operator command (or a one-time step in the
  deployment runbook) that calls `ProvisionChartOfAccounts`; it is **not** a SQL data backfill in a migration.
  Today only development and test data exist; running it in any shared environment requires explicit maintainer
  approval (`10-database.mdc`). Maintainer decision M16: provisioning for existing businesses is always this
  idempotent operator command, never a SQL data backfill.
- Every existing stock item remains `UNVALUED` until a person values it.

## 30. Operator consistency checks

Read-only scripts that report and never repair, following `db:inventory-consistency`:

- `db:ledger-consistency`: every entry has at least two lines; debits equal credits; line and entry currency equal the
  business currency; every line account belongs to the entry's business; exactly one typed source per entry; at most
  one original per source; each reversal mirrors its original line for line; every sale has exactly one original
  entry and every reversed sale exactly one reversal.
- `db:inventory-consistency` (extended): `value_minor` equals the sum of `value_delta_minor` plus valuation-document
  deltas per item; per business the `INVENTORY` account balance equals the sum of `value_minor`; every movement
  recorded after the valuation slice has a valuation row; a `VALUED` item with zero on-hand has **projection**
  value zero; `inventory_valuations.value_minor >= 0`.
- **Amended 2026-10-29 (section 26.1):** residual pairing:
  - when a `REVERSAL_OF_ORIGINAL` movement fact would leave a negative raw value: exactly one `REVERSAL_RESIDUAL`
    valuation references that reversal movement; its amount brings the final recorded value exactly to zero; its
    `ORIGINAL` journal matches Dr `INVENTORY` / Cr `INVENTORY_GAIN`;
  - when a `VALUED` item reaches quantity zero with positive residual value: exactly one `REVERSAL_RESIDUAL`
    valuation references the triggering reversal movement; its amount equals the entire residual; its `ORIGINAL`
    journal is Dr `INVENTORY_SHRINKAGE` / Cr `INVENTORY`; final value `0`;
  - no residual document exists when no residual correction is needed;
  - the exact `REVERSAL` journal still passes the ordinary line-by-line mirror check.

## 31. Illustrative postings (accountant-approved: A to L under A21, M and N under A22)

Illustrative only. Amounts are in the business currency, written in major units with two decimals for readability
(stored as integer minor units). The rate in examples H and I is an arbitrary 10% (1,000 basis points) chosen for
arithmetic, **not** any jurisdiction's tax rate. Sale examples are repeated with tender detail in ADR-011 section 25.

Starting position for the examples: a `VALUED` item with 10 units on hand and value 3,500.00.

- **A. Cash sale, known cost.** 2 units at 500.00. COGS = 3,500.00 x 2 / 10 = 700.00.
  Dr Cash on hand 1,000.00; Cr Sales revenue 1,000.00; Dr Cost of goods sold 700.00; Cr Inventory 700.00.
  Debits 1,700.00 = credits 1,700.00.
- **B. Bank transfer tender, not externally verified.** As A, paid by transfer.
  Dr Bank transfers pending verification 1,000.00; Cr Sales revenue 1,000.00; Dr COGS 700.00; Cr Inventory 700.00.
- **C. POS/card tender.** Dr POS/card clearing 1,000.00; Cr Sales revenue 1,000.00; COGS lines as A.
- **D. Split tender.** Dr Cash on hand 600.00; Dr Bank transfers pending verification 400.00; Cr Sales revenue
  1,000.00; COGS lines as A. Debits 1,700.00 = credits 1,700.00.
- **E. Line discount of 10% (1,000 basis points).** Discount 100.00, net 900.00.
  Dr Cash on hand 900.00; Dr Sales discounts 100.00; Cr Sales revenue 1,000.00; Dr COGS 700.00; Cr Inventory 700.00.
  Debits 1,700.00 = credits 1,700.00.
- **F. Reversal of A.** Dr Sales revenue 1,000.00; Cr Cash on hand 1,000.00; Dr Inventory 700.00; Cr COGS 700.00.
  The item's value returns to 3,500.00 with 10 units.
- **G. Unvalued cost.** Same sale on an `UNVALUED` item: Dr Cash on hand 1,000.00; Cr Sales revenue 1,000.00. No COGS
  or inventory lines; the line shows "cost unknown".
- **H. Exclusive tax (illustrative 10%) on the discounted line of E.** Tax 90.00 on net 900.00; customer pays 990.00.
  Dr Cash on hand 990.00; Dr Sales discounts 100.00; Cr Sales revenue 1,000.00; Cr Tax payable 90.00; Dr COGS 700.00;
  Cr Inventory 700.00. Debits 1,790.00 = credits 1,790.00.
- **I. Inclusive tax (illustrative 10%).** Price 1,000.00 including tax: tax = 1,000.00 x 1,000 / 11,000 = 90.909...,
  rounded `HALF_EVEN` to 90.91; revenue 909.09. Dr Cash on hand 1,000.00; Cr Sales revenue 909.09; Cr Tax payable
  90.91 (COGS lines as A). Debits 1,700.00 = credits 1,700.00.
- **J. Initial opening valuation** (item never valued). 10 units valued at 3,500.00: Dr Inventory 3,500.00;
  Cr Opening balance equity 3,500.00.
- **K. Goods receipt with cost.** 5 units for a total of 1,800.00: Dr Inventory 1,800.00; Cr Goods received not
  invoiced 1,800.00. New value 5,300.00 for 15 units.
- **L. Write-off of 1 unit after K.** 5,300.00 x 1 / 15 = 353.333..., rounded `HALF_EVEN` to 353.33:
  Dr Inventory shrinkage 353.33; Cr Inventory 353.33. Value 4,946.67 for 14 units.
- **M. Operational valuation, increase (A22).** After L, 6 units are received without cost: no entry; the item is now
  `UNVALUED` with 20 units and recorded value 4,946.67. An owner values the 20 units at 7,000.00 (difference
  +2,053.33): Dr Inventory 2,053.33; Cr Inventory gain 2,053.33. Value 7,000.00 for 20 units, `VALUED`.
- **N. Operational valuation, decrease (A22).** Same starting point as M, valued instead at 4,500.00 (difference
  -446.67): Dr Inventory shrinkage 446.67; Cr Inventory 446.67. Value 4,500.00 for 20 units, `VALUED`.
  Neither M nor N uses Opening balance equity, and neither changes COGS of earlier sales.
- **O. Residual after exact reversal, negative raw value (section 26.1 Case B; added 2026-10-29).** Illustrative:
  reversing a snapshotted receipt of 500.00 when the item's recorded value is only 100.00. The `REVERSAL` journal
  still mirrors the original (Inventory credit 500.00 against the original debit). The reversal movement fact keeps
  `value_delta_minor = -500`. Raw resulting value `-400`. Then a separate `REVERSAL_RESIDUAL` `ORIGINAL` journal:
  Dr Inventory 400.00; Cr Inventory gain 400.00. Final projection value `0`. If the item is `UNVALUED`, it stays
  `UNVALUED`.
- **P. Residual after exact reversal, VALUED zero quantity with leftover value (section 26.1 Case C; added
  2026-10-29).** Illustrative: exact reversal leaves quantity `0` and raw value `50.00` while status remains
  `VALUED`. The `REVERSAL` journal is unchanged. A separate `REVERSAL_RESIDUAL` `ORIGINAL` journal: Dr Inventory
  shrinkage 50.00; Cr Inventory 50.00. Final projection value `0`; status remains `VALUED`.

## 32. Accountant review

Acceptance required the accountant to answer every question below; all were answered before acceptance (the
plain-language version with the answer table is `docs/reviews/build-3-accountant-review.md`).

**Accountant review outcome (Osasu, 2026-10-15; evidence in `docs/reviews/build-3-accountant-review.md` section 14):**

- **A1 to A21: APPROVED.** The proposals in this ADR for those questions stand as written (for A9, the proposed
  `INVENTORY_GAIN` revenue treatment).
- **A22: APPROVED / RESOLVED** by the accountant's explicit clarification (2026-10-15): a later operational valuation
  uses an inventory gain / adjustment treatment with the approved adjustment accounts, Dr `INVENTORY` /
  Cr `INVENTORY_GAIN` for an increase and Dr `INVENTORY_SHRINKAGE` / Cr `INVENTORY` for a decrease, never
  `OPENING_BALANCE_EQUITY` (section 20.3).
- **A1 to A22 are all accountant-approved** as of 2026-10-15.
- **Reversal residual (post-acceptance clarification, 2026-10-29):** when an exact snapshotted-value reversal would
  leave a negative recorded value or a `VALUED` zero-quantity leftover value, the accountant chose treatment C:
  keep the exact reversal and post a separate inventory gain/shrinkage adjustment (section 26.1 / 38). This does
  not reopen A1 to A22.

The questions as reviewed:

- A1. The default chart of accounts and codes (template version 1, section 6).
- A2. The system account roles and their account types (section 5).
- A3. `CASH_ON_HAND` as the single cash account for cash tenders.
- A4. `BANK_TRANSFER_PENDING` as an asset holding transfers the cashier asserts but no bank has confirmed.
- A5. `POS_CARD_CLEARING` for card payments awaiting settlement (fees are not modelled in Build 3).
- A6. `OTHER_TENDER_CLEARING` for other tenders.
- A7. `SALES_REVENUE` recognised at the sale's business date.
- A8. Line discounts as `SALES_DISCOUNTS` (contra-revenue, gross presentation) rather than net revenue.
- A9. `INVENTORY_GAIN` as revenue for count surpluses and increasing adjustments, or a contra-expense against
  shrinkage instead.
- A10. Capturing a line's total cost (not unit cost) on receipts and opening stock.
- A11. `OPENING_BALANCE_EQUITY` as the counter-account for the **initial** opening valuation of never-valued stock
  (section 20.2) and for valued opening stock, noting that never-valued quantity may include units received without
  cost after Tali's ledger went live.
- A12. `GOODS_RECEIVED_NOT_INVOICED` as the interim counter-account for receipts with cost before purchasing exists.
- A13. Reversals posted on the business date they are recorded, not the original date (maintainer decision M12;
  confirmed by the accountant).
- A14. A single `TAX_PAYABLE` account (ADR-010) for all configured tax treatments.
- A15. Perpetual moving weighted average cost per item and location.
- A16. Treatment of `UNVALUED` stock: sales post revenue but no COGS; nothing is backfilled later; recorded
  inventory value disclosed as incomplete (section 23).
- A17. The initial opening valuation process (section 20.2), including that Build 3 offers no revaluation of valued
  items.
- A18. Receipts without cost turning a valued item `UNVALUED` (maintainer decision M4: allowed; confirmed by the
  accountant).
- A19. `HALF_EVEN` rounding for COGS removal, unit-cost-to-total conversion and line amounts; and line-level rounding.
- A20. Tax rounding (`HALF_EVEN` per line, ADR-010).
- A21. Whether any example in section 31 needs correction (reviewed examples A to L; M and N were added afterwards
  to illustrate the A22 answer and apply it exactly; O and P were added 2026-10-29 to illustrate section 26.1
  and were not part of the 2026-10-15 example review).
- A22. When an item that was valued became `UNVALUED` during normal operations (for example after a receipt without
  cost) and is later explicitly valued (section 20.3), which account or treatment takes the other side of the value
  recorded? Drafted without a proposal; answered by the accountant's clarification above.

## 33. Consequences

- Sales can post correct, balanced entries from their first release; the ledger is the financial source of truth.
- Build 2 stock is quantity-correct but financially `UNVALUED` until merchants value it; while any item is
  `UNVALUED`, inventory value and margin are incomplete and must be qualified or suppressed (section 23).
- Items made `UNVALUED` by operations can be valued again only by an explicit operational valuation, whose difference
  is reported as inventory gain or shrinkage.
- Valued stock changes in Build 2 use cases now post journal entries; their quantity behaviour is unchanged.
- A later purchasing build must clear `GOODS_RECEIVED_NOT_INVOICED` against supplier invoices.
- Reporting completion (step 7) builds on derived balances and may add verified caches.
- **Amended 2026-10-29:** an exact inventory-value reversal that would leave a negative recorded value or a `VALUED`
  zero-quantity leftover value is completed by a same-transaction `REVERSAL_RESIDUAL` `ORIGINAL` adjustment. The
  `REVERSAL` journal stays an exact mirror.

## 34. Compliance with governance rules

- `20-financial-integrity.mdc`: deterministic posting, balanced entries, immutable postings, reversals, integer minor
  units, one currency, no hardcoded currency or tax, audit in the same transaction, idempotent entry points.
- `10-database.mdc`: tenant keys and composite FKs, append-only grants, no deletes, forward-only migrations, no data
  backfill in migrations.
- `30-multitenancy.mdc`: every account, entry and valuation is business-scoped; posting resolves accounts within the
  business only.
- `40-ai-safety.mdc`: no AI path to posting; boundary rule extended.
- `00-architecture.mdc`: ledger is a module of the monolith; no new datastore or service; no triggers with business
  logic.

## 35. Changes to other documents (applied on acceptance, 2026-10-15)

- `docs/product/mvp-scope.md`: open decision 6 resolved (WAC); open decision 5 narrowed to the approved chart and
  posting rules (pilot tax configuration stays open under ADR-010).
- `docs/decisions/README.md` index status; ADR-008 is not edited (this ADR extends it as ADR-008 section 19 expects).

## 36. Deferred items

Ledger reporting, account management, period close and period controls, multi-currency, receivables and payables,
payment and settlement postings, purchasing invoice matching, card fee accounting, revaluation of valued items,
correction of past COGS for previously unvalued sales, external accounting export, time-zone change policy.

## 37. Human approval record

- **Accepted 2026-10-15 by the human maintainer**, after AI-assisted drafting and review. The ADR was drafted with AI
  assistance; the AI agent did not accept it.
- Accountant review: **complete**. Received from Osasu on 2026-10-15; A1 to A21 approved, and A22 approved through
  the accountant's explicit clarification of the same date (section 32).
- With ADR-010 and ADR-011, this acceptance completes Build 3 slice S0 and unblocks S1
  (`docs/plans/005-build-3-sales-ledger.md`). It approves no tax rate or pilot tax configuration (ADR-010).
- **Amendment 2026-10-29:** the human maintainer accepted the accountant's reversal-residual choice C and the
  architecture rules in section 38. The ADR remains ACCEPTED. Historical sections 1 to 37 are not erased.

Maintainer review decisions applied (2026-10-15; full list in Plan 005 section 4): M1 (untracked lines
`NOT_APPLICABLE`, section 22), M3 (no catalog cost field, section 18), M4 (costless receipt into a valued item
allowed and turns it `UNVALUED`, section 21), M5 (cost entry and valuation OWNER/MANAGER only, sections 20 and 21),
M6 (cost visibility OWNER/MANAGER/ACCOUNTANT, section 17), M12 (reversal business date, section 12), M14
(`ledger:read` OWNER/ACCOUNTANT, section 17), M16 (operator-command provisioning, section 29).

## 38. Amendment 2026-10-29: reversal residual accounting

**Status:** ACCEPTED ADR remains ACCEPTED. This section records a maintainer-directed amendment after accountant
clarification. It does not erase the 2026-10-15 acceptance (section 37) or reopen A1 to A22.

**Authority:** accountant Osasu, 2026-10-29 (`docs/reviews/build-3-accountant-review.md` section 14.2); accepted by
the human maintainer on the same date, subject to the architecture rules below.

**Accountant answer (choice C):** apply the exact reversal and then create a separate inventory gain/shrinkage
adjustment to bring the inventory value back to a valid state.

**Architecture interpretation (non-negotiable):**

1. ADR-009's exact journal reversal invariant remains intact (section 12). A `REVERSAL` entry is still an exact
   mirror of the original: same typed source, currency, accounts/system roles, amounts, memo kinds, number and
   order of lines, opposite DEBIT/CREDIT, **no extra lines**.
2. The residual correction is **not** included in the `REVERSAL` entry. It is a new `ORIGINAL` journal whose
   source is the `valuation_id` of a `REVERSAL_RESIDUAL` stock valuation (section 20.4), posting rule
   `INVENTORY_REVERSAL_RESIDUAL` version 1.
3. Residual rules, intermediate movement-fact semantics, same-transaction all-or-nothing commit, consistency
   pairing and audit are those in sections 20.4, 26.1, 27 and 30.

**Not chosen:** putting residual INVENTORY / INVENTORY_GAIN / INVENTORY_SHRINKAGE lines on the same `REVERSAL`
journal; inventing a current-WAC restatement; stopping the reversal indefinitely once the policy is implemented.

**Implementation:** this amendment is governance. Slice 3 code must still be updated to match; it must not be
treated as already implemented.

**Documents updated with this amendment:** this ADR; `docs/decisions/README.md` index row; Plan 005 S3;
`docs/audits/build-3-slice-3.md`; `docs/reviews/build-3-accountant-review.md` section 14.2.
