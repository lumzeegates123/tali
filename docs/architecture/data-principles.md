# Data Principles

Enforced by `.cursor/rules/10-database.mdc`, `20-financial-integrity.mdc` and `30-multitenancy.mdc`.
This document is canonical for inventory movement types (section 4) and the location model (section 5).
Payment and reconciliation terms are defined in `reconciliation-principles.md` section 2.

## 1. Tenant scoping

- A **business** is the tenant. Every business-owned record has a non-null `business_id`.
- Tenant context is derived from the authenticated actor's verified membership, never from untrusted input.
- Indexes and unique constraints on business data include `business_id`.
- Shared reference data (currencies, countries, default chart-of-accounts templates) is explicitly marked as
  global and is read-only for tenants.
- Cross-tenant data access is a critical security failure. Defense in depth (e.g. database row-level security)
  is encouraged but does not replace scoping in application code.

## 2. Money

- Monetary amounts are stored and computed as **integer minor units** (e.g. `1250` = 12.50 in a two-decimal
  currency) using `bigint` in TypeScript and `BIGINT` in the database, or via an approved decimal/money
  abstraction chosen by ADR. JavaScript `number` floating-point arithmetic is never used for money.
- Every amount has a **currency** (ISO 4217 code, e.g. `NGN`). The number of minor-unit decimals comes from the
  currency definition, not from hard-coded `100`.
- **One currency per business in the MVP**, set at business creation. Operations involving different currencies
  are **rejected**.
- **No currency is hardcoded in domain logic.** `NGN` (the pilot currency) may appear only in configuration, seed
  data or market defaults. Domain code takes the currency from the business or the amount.
- **No currency conversion in the MVP.** Multi-currency accounting and FX conversion are post-MVP. The data model
  keeps a currency on every amount so they can be added later without changing meaning.
- Rates (tax, discount, interest) are stored as integer basis points or exact decimals.
- Rounding is explicit, uses a named mode (e.g. half-even or half-up, chosen per use case and documented), and
  happens at defined points (e.g. per line vs per document is a documented business rule).
- Splitting/allocating amounts must distribute remainders so the parts always sum to the whole.

## 3. Double-entry ledger

- The ledger is the financial source of truth. Sales, payments, expenses, restocks, purchases, adjustments and
  reversals produce **journal entries** consisting of lines (account, debit or credit, amount, currency).
- The **ledger posting foundation** exists before or together with the first sales implementation (and before any
  other feature with accounting effects). Financial features never ship without their accounting effects.
- Every journal entry balances: total debits = total credits per currency. Enforced in the domain service and
  verified in tests; database constraints/checks are added where practical.
- Journal entries are **immutable once posted**. Corrections are new entries (reversal and/or adjustment) that
  reference the original.
- Accounting periods can be closed (period controls). Closed periods are not modified; corrections post in an open
  period. Daily close is **not** an accounting-period close (section 10).
- Balances (account balances, customer and supplier balances) are derived from entries. Cached balances are allowed
  only if updated in the same transaction and verifiable against entries.
- Users do not need accounting knowledge: business events are mapped to postings by deterministic domain rules.
  Posting rules and the default chart of accounts require accounting review before production use.

## 4. Inventory movements (canonical list)

Stock is represented by **inventory movements**: append-only records of quantity changes, each with type,
product variant, `location_id`, quantity delta, unit/pack, unit cost where relevant, source document/reference,
actor, reason and timestamp.

This is the **canonical list of movement types**. Other documents reference it rather than copying it.
New types require updating this list (and an ADR if accounting treatment changes).

| Type | Direction | Meaning | MVP |
|------|-----------|---------|-----|
| `OPENING` | in | Opening stock when a product or business starts using Tali | Yes |
| `PURCHASE_RECEIPT` | in | Stock received from a supplier: restock (core) or goods receipt (purchasing) | Yes |
| `SALE` | out | Stock sold | Yes |
| `CUSTOMER_RETURN` | in | Stock returned by a customer | Yes |
| `SUPPLIER_RETURN` | out | Stock returned to a supplier | Yes |
| `ADJUSTMENT` | in/out | Manual correction with required reason (e.g. found stock, data-entry correction) | Yes |
| `COUNT_CORRECTION` | in/out | Difference between counted and expected stock from a stock count | Yes |
| `WRITE_OFF` | out | Damaged, expired, spoiled or stolen stock | Yes |
| `TRANSFER` | out + in | Movement between two locations of the same business | **Post-MVP** |

Rules:
- On-hand quantity per variant and location = sum of movements. A cached quantity is allowed only if updated in
  the same transaction as the movement and rebuildable from movements.
- A stock count never overwrites quantity; it records a `COUNT_CORRECTION` for the difference.
- Reversal of a movement is a new movement of the same type with the opposite delta, referencing the original.
- **Restock before full purchasing:** a merchant can record a `PURCHASE_RECEIPT` with quantity received, unit/pack,
  unit cost where known, and source/reference where available. A stock purchase is **inventory acquisition, not
  automatically an operating expense**; its accounting treatment follows the approved posting rules. The purchasing
  module later extends the same movement model (a `GoodsReceipt` produces `PURCHASE_RECEIPT` movements).
- Inventory valuation (cost method) is decided by ADR and applied consistently; movements that affect value post
  corresponding ledger entries.
- Quantities are integers in base units, or exact decimals for fractional goods. Never floats.

## 5. Location model

Tali is **location-aware from day one**.

- Every stock movement has a `location_id`.
- Sales have a `location_id` where operationally applicable.
- Cash sessions (drawer/till sessions and their counts) are location scoped.
- Purchasing and receiving (goods receipts, restocks, supplier returns) are location scoped.
- Relevant staff actions (sales, counts, adjustments, cash handling, daily close) retain location context.
- Locations belong to a business and are tenant scoped like any other business record.

Private-pilot MVP:
- exactly **one active default location** is created automatically per business;
- no branch-management UI;
- no multi-location consolidated reporting;
- no transfer workflow (`TRANSFER` is defined but post-MVP).

## 6. Pricing, discounts and tax

- Products/variants have a **selling price** and an optional **cost price** (where known). Price changes are
  recorded with history; they never change past transactions.
- Every sale/purchase line stores **transaction-time snapshots**: unit price, cost price where known, quantity,
  discount, tax treatment and computed line amounts. Reports use the snapshots, not current prices.
- **Simple discounts** only: fixed amount or percentage (in basis points) on a line or a whole sale, subject to
  permission and recorded in the snapshot. No promotion engine.
- **Tax is configurable, never hardcoded.** Tax treatments (e.g. rate in basis points, inclusive/exclusive,
  exempt, ledger account) come from approved business configuration per business and product/line. No
  jurisdiction's rules or rates (including Nigeria's) are embedded in domain code. The default for a new business
  is "no tax configured" until configured.
- Pilot tax and chart-of-accounts configuration requires **accounting review before production use**.

## 7. Transaction identity and document numbers

- The true identifier of every transaction and record is an **immutable UUID** (or ULID), generated by the server
  or, for offline capture, by the device. It never changes.
- Human-facing document numbers (e.g. receipt numbers) are **display identifiers, not database identity**.
- Receipts issued offline use **business/device-scoped human receipt numbering**; a globally sequential number is
  not required while offline. The final format is decided in the sync ADR.
- Human document numbers are unique within their defined scope and generated safely under concurrency.

## 8. Purchasing and payables

The purchasing model (minimal version in the core MVP) distinguishes these entities:

| Entity | Meaning |
|--------|---------|
| `Supplier` | A business the merchant buys from. |
| `PurchaseOrder` | An intent to buy, sent or agreed with a supplier. No stock or ledger effect by itself. |
| `PurchaseOrderItem` | A line on a purchase order: variant, **ordered quantity**, expected unit cost. |
| `GoodsReceipt` | Goods physically received at a location. Creates `PURCHASE_RECEIPT` movements for **received quantity**. |
| `SupplierInvoice` | The supplier's bill. Records **invoiced quantity** and amount; creates a payable and ledger postings. |
| `SupplierPayment` | Money paid to a supplier; allocated to one or more supplier invoices. |
| `Payable` | Amount owed to a supplier, derived from invoices, payments, returns and adjustments. |
| `SupplierReturn` | Goods returned to a supplier. Creates `SUPPLIER_RETURN` movements and, where applicable, credits. |

Rules:
- **Ordered, received, invoiced and paid quantities remain distinct** and are tracked per line. They are never
  collapsed into a single field and are never overwritten to force agreement.
- "Paid quantity" is derived from supplier-invoice lines covered by allocated, CONFIRMED supplier payments;
  payments themselves are recorded as money amounts.
- Differences (short delivery, over-invoicing, price differences) are visible and resolved through explicit
  records (additional receipts, returns, credit notes, adjustments), never by editing history.
- Goods receipts may occur without a purchase order, and invoices may arrive before or after goods.

## 9. Offline-captured records

- Commands captured offline carry a client-generated UUID (idempotency key and transaction identity), device ID,
  actor, business ID, location ID, device time of capture, and snapshots of price/discount/tax actually used.
- The server records both the **device-reported capture time** and the **server received-at time**. Device time is
  evidence only and is **not trusted for authorization**.
- Sync lifecycle (see `architecture-principles.md` section 7): `LOCALLY_RECORDED -> SYNC_RECEIVED -> VALIDATED ->
  POSTED`, or `LOCALLY_RECORDED -> SYNC_RECEIVED -> CONFLICT -> NEEDS_ATTENTION`, or `REJECTED` (permitted reasons only).
- Sync status is separate from reconciliation terminology. A POSTED record is CONFIRMED, not EXTERNALLY_VERIFIED,
  until a trusted external source supports it.
- Credible business events that conflict with current server state are preserved as NEEDS_ATTENTION with what
  was actually charged/recorded; they are never silently dropped, recalculated or discarded.
- Rejected commands are retained with reasons and surfaced to users.

## 10. Daily close

- A daily close is an **operational close**, recorded and audited per business and location for a business date.
  It is **not an accounting-period close** and does not lock the ledger.
- Physical cash is counted (CASH_COUNTED) and compared to expected cash; variances are recorded as explicit
  adjustment transactions with reason. Cash counting does not externally verify individual cash transactions.
- It lists unsynced, needs-attention, unconfirmed, unreconciled and disputed items at the time of close.
- Records arriving after close for a closed business date (e.g. late offline sync) keep their business date and
  are handled by an explicit, audited rule (policy decided by ADR), never by silently rewriting the closed day.

## 11. Immutability, deletion, void and correction

- Financial and inventory records (sales, payments, receipts, invoices, receivables, payables, expenses,
  purchase records, journal entries, inventory movements, reconciliation records, cash sessions, audit records)
  are **never silently hard-deleted** and posted amounts are never updated in place.
- Corrections use **reversal** (exact negation referencing the original) or **adjustment** (difference referencing
  the original), always with a reason, actor and audit record.
- **Void/cancel of a posted financial transaction** is implemented with the appropriate reversal/compensating
  records (ledger, inventory, receivable/payable) and an audit trail. A posted transaction is never made to
  disappear through a status-only void.
- A **draft/unposted record or proposal** may be cancelled or discarded by status change, with audit, without a
  financial reversal, because it never posted.
- Master data (products, customers, suppliers, locations) is archived, not deleted, when referenced by records.
- Personal-data erasure requests are handled by anonymizing personal fields while preserving the financial
  records required by bookkeeping obligations.

## 12. Audit records

Every sensitive mutation writes an append-only audit record in the same transaction. All financial and inventory
mutations, permission changes and sensitive settings changes are sensitive. Audit records contain at least:

- `business_id`, audit ID, timestamp (UTC)
- actor type and ID (user, staff, system job, integration, AI proposal with approving user) and device ID where relevant
- location ID where relevant
- action (e.g. `sale.posted`, `payment.reversed`, `inventory.adjusted`, `role.granted`)
- entity type and ID
- before and after state (or a diff) for changed fields
- reason (required for reversals, adjustments, voids and permission changes)
- source channel (web, mobile, WhatsApp, API, webhook, AI assistant, offline sync)
- correlation ID / idempotency key and, where relevant, AI proposal ID or external event ID

Audit records are insert-only for the application; they are never updated or deleted by application code.

## 13. Idempotency

- All mutation entry points accept an idempotency key or rely on a natural unique key, stored with a unique
  constraint scoped by `business_id` (or by provider for external events). Offline commands use their UUID.

## 14. Time

- Store timestamps in UTC. Each business has a time zone used for display, day boundaries and reporting periods.
- Distinguish the business date of a transaction (when it happened) from the recorded-at timestamp (when it was
  entered or received).

## 15. Data provenance

- Records created from external or AI-derived input link to their evidence (raw event, document, message,
  transcript) and to the proposal and confirming actor, so every number can be explained.
