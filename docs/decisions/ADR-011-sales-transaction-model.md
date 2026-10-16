# ADR-011. Sales transaction model

- Status: ACCEPTED (2026-10-15)
- Date: 2026-10-15
- Deciders: Tali maintainers (human approval given 2026-10-15). Posting rules were reviewed by the accountant with
  ADR-009 (approved, section 25). Drafted by an AI agent from the maintainer's Build 3 direction (2026-10-15), accepted
  by the human maintainer. Acceptance record in section 31.
- Related: `docs/product/mvp-scope.md` (Core MVP sales; open decisions 7 and 9); `docs/architecture/architecture-principles.md`
  section 7 (offline lifecycle); `docs/architecture/reconciliation-principles.md` section 2; `docs/architecture/data-principles.md`
  sections 2, 4 and 5; `.cursor/rules/20-financial-integrity.mdc`; ADR-002 section 25; ADR-004; ADR-005; ADR-006;
  ADR-008 sections 7 to 10, 12, 14 and 17; ADR-009 (accepted); ADR-010 (accepted);
  `docs/plans/005-build-3-sales-ledger.md`
- Scope: Build 3 online, fully tendered sales and their full reversal.

## 1. Context

`mvp-scope.md` lists cash and credit sales in the Core MVP. The maintainer's Build 3 direction (2026-10-15) delivers
the **fully tendered** part first: the sale is paid in full at the counter. Credit sales, receivables and payment
allocation follow in Build 4. ADR-008 section 10 leaves the online negative-stock policy to this ADR, and section 14
leaves to Build 3 whether a sale requires a price. ADR-009 defines the ledger and valuation this ADR posts to.

## 2. Decision summary

1. **Online, fully tendered sales only**: tender total equals the sale total.
2. Records: **Sale**, **SaleLine**, **SaleTender**.
3. Lifecycle **`POSTED -> REVERSED`**; no server-side draft; the cart lives on the client.
4. Posted lines, tenders and totals are **immutable**.
5. **UUIDv7 identity**, client-generated; a separate **online receipt number** for display.
6. **Keyed idempotency** with the sale ID as key.
7. Authoritative **catalog price snapshot** with expected price version; mismatch returns **`PRICE_CHANGED`**. A sale
   requires a price. **No price override.**
8. **Line discounts only** (fixed or basis points) under `sales:discount`; never 100%, so every line, sale and
   tender amount is positive. No zero-total sales.
9. **Tax snapshot** per line, default `NO_TAX` (ADR-010).
10. Tenders `CASH`, `BANK_TRANSFER`, `POS_CARD`, `OTHER`; **split tender** allowed; non-cash tenders are **merchant
    assertions, not externally verified**; cash received and change are display snapshots only.
11. One **`SALE` inventory movement** per tracked line with a typed `sale_id` source.
12. **Stock-unit selling only**; no pack selling or pack prices.
13. Untracked products sell without movement or COGS; archived products are rejected.
14. **Online negative stock is blocked** with `INSUFFICIENT_STOCK` (effective policy `BLOCK`, no override).
15. **Full sale reversal** only, as an error-correction workflow (not a customer return), OWNER/MANAGER only, with a
    confirmed tender unwind.
16. **Server time is authoritative**; device-reported time is evidence only.
17. Audit, permissions (CASHIER reads own sales only), and identifiers ready for later offline capture, with no sync
    implementation.

## 3. Fully tendered online sales

- A sale is recorded in one request when the customer has paid in full. The server validates everything, then writes
  the sale, lines, tenders, movements, valuation rows, journal entry and audit record in one `UnitOfWork.run`.
- There is no customer on the sale, no amount due, no receivable and no partial payment. A sale that cannot be fully
  tendered is not recordable in Build 3. No generic or anonymous receivable is created.
- Only the `API` channel from authenticated web and mobile clients online. Offline capture is not built (section 24).

## 4. Sale

`sales` (business-owned):

| Column                                | Meaning                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `business_id`, `id` (UUIDv7)          | Tenant key; client-generated identity (section 8).                        |
| `location_id`                         | The default location (ADR-005 `LocationBoundContext`; composite tenant FK). |
| `receipt_number`                      | Display identifier (section 8); `UNIQUE (business_id, receipt_number)`.   |
| `status`                              | `POSTED` or `REVERSED`.                                                   |
| `currency`                            | Business currency (composite FK to `businesses (id, currency_code)`).     |
| `gross_total_minor`, `discount_total_minor`, `tax_total_minor`, `total_minor` | Sums of the line values (section 10); `total_minor` is what the customer paid. |
| `cost_status`                         | `VALUED` (every tracked line valued), `PARTIAL`, `UNVALUED`, or `NOT_APPLICABLE` (no tracked lines). |
| `cogs_total_minor`                    | Sum of valued line COGS; never shown as margin unless `cost_status = VALUED`. |
| `recorded_by_membership_id`           | The signed-in staff member who recorded it (employee attribution).        |
| `device_id`, `source_channel`, `correlation_id` | Envelope, as on inventory movements.                             |
| `occurred_at`, `recorded_at`          | **Authoritative** server receipt time and server posting time (ADR-002 section 15; ADR-009 section 15). |
| `business_date`                       | Derived from server time in the business time zone; never from client input. |
| `device_reported_at`                  | Optional client/device-reported time; **evidence only, non-authoritative** (section 19.1). |
| `journal_entry_id`                    | The original entry.                                                       |
| `reversed_at`, `reversed_by_membership_id`, `reversal_reason`, `reversal_journal_entry_id`, `reversal_tender_unwound_confirmed` | Set once by the reversal (section 21); `reversed_at` is server time. |

App-role grants: SELECT and INSERT; UPDATE only on `status` and the reversal columns (column-level, as for goods
receipts). No DELETE.

## 5. SaleLine

`sale_lines`: `business_id`, `sale_id`, `line_number` (1 to 200; maintainer decision M13), `variant_id`, `product_name` and `sku` snapshots,
`tracked` flag snapshot, `quantity_minor`, `unit`, `unit_scale`, `unit_price_minor`, `price_version`,
`gross_minor`, `discount_kind` (`NONE`, `FIXED`, `BASIS_POINTS`), `discount_value` (minor amount or basis points),
`discount_minor`, `net_minor`, the tax snapshot (ADR-010 section 7), `total_minor`, `cost_status` (`VALUED`,
`UNVALUED`, `NOT_APPLICABLE`), `cost_minor`, `valuation_version_read`, `movement_id` (for tracked lines). Insert-only.

## 6. SaleTender

`sale_tenders`: `business_id`, `sale_id`, `tender_number` (1 to 10; maintainer decision M13), `method` (`CASH`, `BANK_TRANSFER`, `POS_CARD`,
`OTHER`), `amount_minor` (> 0), `reference` (optional, at most 64 characters, for example a slip number, evidence
only), `verification_status` fixed at `NOT_VERIFIED` for non-cash methods and `NOT_APPLICABLE` for cash, and for
`CASH` only the optional display snapshots `cash_received_minor` and `change_given_minor` (section 13). Insert-only.

## 7. Lifecycle

- `POSTED` on creation; `REVERSED` after a full reversal (section 21). No other transition. Invalid transitions throw.
- **No server-side draft.** The cart, quantities and tender entry live in client memory until the cashier submits.
  Nothing is stored for an abandoned cart. (Parked or held sales are not in Build 3.)
- Posted amounts, lines and tenders never change. A mistake is corrected by reversing the whole sale and recording a
  new one.

## 8. Identity and receipt number

- `id` is a **UUIDv7 generated by the client** for each submission (the existing `KeyedCommand` pattern), validated
  as UUIDv7 by the server. This is the true identity and the idempotency key, and matches the later offline command
  model.
- `receipt_number` is a **display identifier only**, issued by the server in the **online namespace**:
  `S-` followed by a business-scoped sequence of at least six digits (`S-000123`), from a `sale_receipt_sequences`
  row locked `FOR UPDATE` in the sale transaction.
- Numbers need not be globally gapless; a gap is not an error. They are never the database identity or a foreign
  key.
- **Namespace reservation:** future device-scoped offline numbers (format decided by the sync ADR) must not match
  `^S-[0-9]+$`, so the two can never collide.

## 9. Idempotency

- `POST .../sales` requires `Idempotency-Key`, which must equal the body's `saleId` (`VALIDATION_FAILED` otherwise).
- Replay with the same key and fingerprint returns the stored result with `Idempotent-Replayed: true` (ADR-004).
  Same key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- The reversal request is keyed separately with its own client UUID.

## 10. Prices, quantities and line amounts

- **A sale requires a price.** A variant without a current price is rejected with `PRICE_NOT_SET`.
- The client sends, per line, the `variantId`, the quantity in the stock unit, and the `expectedPriceVersion` it
  displayed. The server reads the current price; if any line's version differs, the whole sale is rejected with
  `409 PRICE_CHANGED`, listing the affected variant IDs with current price and version, and nothing is written.
- **No price override**: the client cannot send a unit price. The price on the line is the server's snapshot.
- **Stock-unit selling only**: the line unit must equal the variant's stock unit; pack quantities, pack prices and
  pack barcodes are not accepted (ProductPack remains a data-entry concept, ADR-008).
- Quantity is greater than zero and within the `Quantity` bounds.
- `gross = unit_price x quantity_minor / 10^scale`, rounded `HALF_EVEN` when the unit has a fractional scale (for
  example `KG`); exact for whole units (accountant-approved, ADR-009 A19).

## 11. Line discounts

- Optional per line: `FIXED` (minor units) or `BASIS_POINTS`. `BASIS_POINTS` gives
  `round_HALF_EVEN(gross x bps / 10,000)` (accountant-approved, ADR-009 A19).
- **A 100% line discount is not allowed** (maintainer decision M7):
  - `FIXED` must be greater than zero and **less than** the line gross;
  - `BASIS_POINTS` must be 1 to 9,999;
  - after rounding, the discount must still be less than the line gross, so every line's net is greater than zero;
  - otherwise `DISCOUNT_EXCEEDS_LINE`.
- Every line therefore has a positive net amount, every sale a positive total, and every tender a positive amount
  (section 13). **Zero-total and free-sale workflows are outside Build 3.**
- Any discount requires `sales:discount` (`PERMISSION_DENIED` otherwise). No sale-level discount, no allocation, no
  promotion engine.
- Posted as `SALES_DISCOUNTS` (contra-revenue, ADR-009 section 5).

## 12. Tax snapshot

- Per line, from the variant's assigned treatment (ADR-010); `NONE` by default. Before ADR-010 is implemented every
  line snapshots `NONE`.
- `net = gross - discount`. Exclusive: `tax` on `net`, `total = net + tax`. Inclusive: `tax` within `net`,
  `total = net`. No tax: `total = net`.

## 13. Tenders

- Methods: `CASH`, `BANK_TRANSFER`, `POS_CARD`, `OTHER`; 1 to 10 tenders; each amount greater than zero.
- The sum of tender amounts must equal the server-computed sale total, which is always positive (section 11);
  otherwise `TENDER_TOTAL_MISMATCH` (details: the server total).
- **Cash received and change given** (maintainer decision M8): a `CASH` tender may carry the cash the customer handed
  over (`cashReceived`, at least the tender amount). The server computes `change_given = cash_received - amount` and
  stores both as immutable receipt/display snapshots. They **do not affect the ledger**: the journal posts only the
  tender `amount`, which is the actual sale tender. Non-cash tenders carry neither field.
- **A non-cash tender is the merchant's assertion that payment was received.** It is **not externally verified**,
  **not reconciled** and **not a trusted provider event**. It posts to a pending/clearing account (ADR-009 section 5),
  and the sale is `CONFIRMED` by the cashier in the sense of `reconciliation-principles.md` section 2, never
  `EXTERNALLY_VERIFIED`. Screens say "not verified".
- Later reconciliation may match a clearing balance to a bank or provider record; that is not in Build 3.

## 14. Inventory: SALE movement

- The sales persistence migration adds `SALE` to the movement types, a typed `sale_id` source column with its
  composite FK, and the CHECK updates (ADR-008 section 8).
- One `SALE` movement per tracked line, negative delta, with the sale's envelope and `location_id`, plus its ADR-009
  valuation row.
- Lock order follows ADR-009 section 28.

## 15. Tracked and untracked products

- Tracked: movement, stock check, valuation and COGS as above.
- Untracked (`track_inventory = false`): **sellable** (maintainer decision M1), still requires a price, no
  movement, no stock check, `cost_status = NOT_APPLICABLE`, no COGS.

## 16. Archived products

A line for an `ARCHIVED` product is rejected with `PRODUCT_ARCHIVED`. Residual stock of archived products is cleared
through adjustments, write-offs and counts (ADR-008 section 17).

## 17. Online negative stock

- If any tracked line would take its balance below zero, the sale is rejected with `409 INSUFFICIENT_STOCK` (variant
  IDs and available quantity, bounded). **Nothing is written**: no sale, movement, valuation, journal or audit
  record.
- No database `>= 0` CHECK is added; the rule is enforced in the domain, as in Build 2, so later offline replay can
  record a credible negative-stock sale as `NEEDS_ATTENTION` (`architecture-principles.md` section 7).
- **Policy (maintainer decision M15):** for Build 3 the effective online negative-stock policy for every business and
  product is `BLOCK`. The domain evaluates the policy in business and product context (a policy resolver that today
  always returns `BLOCK`), so a later decision can introduce configuration without changing the sale use case. There
  is **no merchant-configurable override** in Build 3.
- The future offline rule is preserved: a credible offline sale that conflicts with stock is recorded as
  `NEEDS_ATTENTION`, never silently dropped (`architecture-principles.md` section 7; sync ADR).

## 18. Stocktake interaction

- A sale is never blocked by a draft stocktake.
- A sale changes the balance version of its items, so a stocktake line counted before the sale makes the post fail
  with `STOCKTAKE_STALE` (ADR-008 section 12.4). The counter recounts or reconfirms. Guidance: count when the shop is
  closed or the item is not being sold. No stock freeze is built.

## 19. Location, employee, device, channel

- Location: the default location from `LocationBoundContext`; a client-supplied location is not accepted.
- Employee attribution: the signed-in membership; shared devices need separate staff sign-in (`70-security.mdc`).
- Device: a trusted device is required for mobile, as for inventory mutations (`DEVICE_NOT_TRUSTED`); web follows the
  existing guard behaviour.
- Correlation ID and channel from the request context.

### 19.1 Time

- The authoritative time of an online sale and of its reversal is **server time** (`occurred_at` as server receipt
  time and `recorded_at` for the sale; `reversed_at` for the reversal; ADR-002 section 15). The `SALE` movements and
  journal entries carry the same server times.
- `business_date` is derived from server recording time in the business time zone (ADR-009 section 15).
- A client may send `deviceReportedAt`; it is stored as `device_reported_at`, explicitly **evidence only**. It never
  sets `business_date`, never backdates the journal, inventory movements, valuation or tax snapshots, and plays no
  part in authorization.

## 20. Permissions

| Permission       | OWNER | MANAGER | CASHIER | STOCK_KEEPER | ACCOUNTANT | Use cases                                  |
| ---------------- | ----- | ------- | ------- | ------------ | ---------- | ------------------------------------------ |
| `sales:read`     | yes   | yes     |         |              | yes        | List and get all sales in the business/location |
| `sales:read-own` | yes   | yes     | yes     |              | yes        | List and get sales recorded by the actor   |
| `sales:create`   | yes   | yes     | yes     |              |            | RecordSale                                 |
| `sales:discount` | yes   | yes     |         |              |            | Any line discount                          |
| `sales:reverse`  | yes   | yes     |         |              |            | ReverseSale                                |

- **Read scope (maintainer decision M2):** CASHIER may read only sales recorded by that cashier
  (`recorded_by_membership_id` equals the actor's membership, filtered server-side in the query; another cashier's sale
  returns `404`). OWNER, MANAGER and ACCOUNTANT may read all sales in the current business and location.
- **Cost visibility (maintainer decision M6):** cost, COGS and margin fields appear in sale responses only for OWNER,
  MANAGER and ACCOUNTANT (`inventory:cost-read`, ADR-009 section 17), never for CASHIER or STOCK_KEEPER. Margin is
  shown only when the sale's `cost_status` is `VALUED`; otherwise it is suppressed or marked incomplete (ADR-009
  section 23).
- MANAGER has this operational view but no raw journal access (`ledger:read` is OWNER and ACCOUNTANT only).
- Every request is tenant-scoped; a sale ID from another business returns `404`.

## 21. Full sale reversal

**Nature.** Build 3 full sale reversal is an **error-correction workflow**, not a customer return. It corrects a sale
that should not stand as recorded (for example a wrong item or a wrong tender), and as part of that correction it
reverses the **recorded tender assertion**. It is not a `CUSTOMER_RETURN` and creates no refund record. Customer
returns and refunds remain deferred.

- `POST .../sales/:saleId/reversal` with a required reason (1 to 500 characters), keyed. OWNER or MANAGER only
  (`sales:reverse`, maintainer decision M12). There is **no same-day-only restriction**.
- **Tender unwind confirmation:** the request must carry `tenderUnwoundConfirmed: true`. The UI requires the
  authorized OWNER or MANAGER to confirm that the original tender has been unwound or returned as applicable (for
  example cash returned from the drawer, a transfer sent back, a card payment voided on the terminal) before it
  submits. Without it the request fails with `VALIDATION_FAILED`. The confirmation is stored
  (`reversal_tender_unwound_confirmed`) and audited. **Tali does not independently verify the refund** in Build 3.
- Only a `POSTED` sale; a `REVERSED` sale returns `409 CONFLICT` (a replay with the same key returns the stored result).
- In one transaction:
  - **Journal:** the exact reversal of the sale's entry (ADR-009 section 12), dated the reversal's business date
    (derived from server time). Future accounting-period controls may prevent postings into closed periods.
  - **Inventory:** one reversal movement per original `SALE` movement (`reverses_movement_id`), restoring the
    quantity; allowed whatever the product's current archive status, since it corrects history.
  - **Valuation:** exactly the snapshotted COGS is added back (ADR-009 section 26).
  - **Tenders:** the cash and clearing accounts are reversed by the journal, reversing the original tender
    assertion. Tali records no refund payment; the unwinding happens outside Tali and is asserted by the confirming
    OWNER or MANAGER.
  - Sale status `REVERSED` with reversal columns; audit `sale.reversed`.
- No partial reversal, line return, `CUSTOMER_RETURN` movement or refund record.

## 22. Audit

- `sale.recorded` (entity `sale`): receipt number, line count, tender count, total, discount total, tax total, cost
  status, journal entry ID. No line detail (it is in the immutable records).
- `sale.reversed`: receipt number, reversal journal entry ID, tender-unwound confirmation flag; reason required.
- Same transaction; ADR-006 bounded payloads; the entity-type union gains `sale`.

## 23. API

Routes under `v1/businesses/:businessId`, guards as for inventory:

- `POST /sales`: RecordSale. Body: `saleId`, optional `deviceReportedAt` (evidence only), `lines[]` (`variantId`,
  `quantity`, `expectedPriceVersion`, optional `discount`), `tenders[]` (`method`, `amount`, optional `reference`,
  optional `cashReceived` for `CASH`). Returns the sale with server-computed totals, line snapshots, change given and
  the receipt number.
- `GET /sales`, `GET /sales/:saleId`: read, scoped per section 20.
- `POST /sales/:saleId/reversal`: ReverseSale. Body: `reason`, `tenderUnwoundConfirmed`.
- Errors: `VALIDATION_FAILED`, `PERMISSION_DENIED`, `PRICE_NOT_SET`, `PRICE_CHANGED`, `PRODUCT_ARCHIVED`,
  `INSUFFICIENT_STOCK`, `DISCOUNT_EXCEEDS_LINE`, `TENDER_TOTAL_MISMATCH`, `LEDGER_NOT_PROVISIONED`, `CONFLICT`,
  `IDEMPOTENCY_KEY_REUSED`, `DEVICE_NOT_TRUSTED`, `NOT_FOUND`. A retired tax treatment can never be assigned to an
  active variant (ADR-010 section 5), so sales have no tax-retirement error.
- Money and quantities use the existing wire shapes.

## 24. Offline forward compatibility

Client-generated UUIDv7 identity used as idempotency key, device ID, `device_reported_at` as evidence, `price_version` on
each line, the reserved receipt namespace and the domain-level (not database-level) stock rule allow the sync build
to replay captured sales later. Build 3 builds **no** local store, queue, sync engine, `NEEDS_ATTENTION` handling or
offline UI.

## 25. Posting rule `SALE_POSTED` version 1

For each sale (amounts per ADR-009 section 31 examples A to I):

| Line                       | Account role                                      | Direction | Amount                                    |
| -------------------------- | ------------------------------------------------- | --------- | ----------------------------------------- |
| Each tender method         | `CASH_ON_HAND`, `BANK_TRANSFER_PENDING`, `POS_CARD_CLEARING`, `OTHER_TENDER_CLEARING` | DEBIT | Sum per method |
| Discounts                  | `SALES_DISCOUNTS`                                 | DEBIT     | Sum of line discounts                     |
| Revenue                    | `SALES_REVENUE`                                   | CREDIT    | Sum of `gross` (exclusive or no tax) and `gross - tax` (inclusive) |
| Tax                        | `TAX_PAYABLE`                                     | CREDIT    | Sum of line tax                           |
| COGS                       | `COST_OF_GOODS_SOLD`                              | DEBIT     | Sum of valued line cost                   |
| Inventory                  | `INVENTORY`                                       | CREDIT    | Same amount                               |

Balance check: tenders + discounts = revenue + tax, because each line's total equals `gross - discount + exclusive
tax`, or `gross - discount` with inclusive tax inside it. COGS and inventory are equal. Zero lines are omitted.

For inclusive tax with a discount, the discount is posted at its tax-inclusive amount (approved by the accountant
through ADR-010 T4 and ADR-009 A8).

**Accountant approval of posting dependencies.** The accounting this ADR depends on was approved by the accountant
(Osasu, 2026-10-15) through ADR-009 A1 to A21 (chart, tender clearing accounts, revenue and discounts, COGS and
valuation, reversal date, rounding, examples A to I) and ADR-010 T1 to T7 (tax framework). ADR-009 A22 (operational
valuation counter-account) is also approved; it does not affect any sale posting, so this ADR's posting rules are
unchanged.

## 26. Not in this ADR

Credit sales, receivables, customer accounts on sales, payment allocation, partial returns, customer returns,
refunds, exchanges, pack selling, pack prices, pack barcodes, price override, sale-level discounts, held or parked
sales, offline queue and sync, AI or voice selling, receipt printing hardware, card-fee accounting, reconciliation.

## 27. Maintainer decisions applied (2026-10-15)

- M1. Untracked products are sellable; no movement, no COGS (section 15).
- M2. CASHIER reads only own sales; OWNER, MANAGER and ACCOUNTANT read all (section 20).
- M6. Cost, COGS and margin visible to OWNER, MANAGER and ACCOUNTANT only (section 20).
- M7. No 100% line discount; fixed discount below line gross; basis points 1 to 9,999 (section 11).
- M8. Cash received and change given stored as display snapshots; no ledger effect (section 13).
- M12. Reversal OWNER/MANAGER only, reason required, no same-day restriction, posted on the reversal business date
  (section 21).
- M13. At most 200 lines and 10 tenders per sale (sections 5 and 6).
- M15. Effective online policy `BLOCK` for every business and product; no override (section 17).

## 28. Alternatives considered

- Server-side draft sales: rejected; adds state, locking and cleanup with no Build 3 need.
- Server-generated sale ID: rejected; breaks the offline command model.
- Allowing online negative stock: rejected by the maintainer; online the cashier can see the shortfall.
- Pack selling with derived pack prices: rejected; a commercial pack price is not necessarily unit price times factor.

## 29. Consequences and compliance

- Sales post balanced entries from their first release (`mvp-scope.md`, ADR-002 section 25).
- `20-financial-integrity.mdc` says negative stock policy is "explicit per business/product". Per maintainer
  decision M15, the explicit Build 3 policy is `BLOCK` for every business and product, evaluated by the domain in
  business and product context; a merchant-configurable override is a later decision.
- Tenancy, audit, idempotency and the AI boundary follow ADR-004 to ADR-006; AI code cannot import the sales
  mutating use cases (dependency-cruiser rule added in the sales slice).

## 30. Changes to other documents (applied on acceptance, 2026-10-15)

`mvp-scope.md` open decisions 7 (line discounts) and 9 (stock-unit selling for sales) recorded; ADR index updated.

## 31. Human approval record

- **Accepted 2026-10-15 by the human maintainer**, after AI-assisted drafting and review. The ADR was drafted with AI
  assistance; the AI agent did not accept it. ADR-009, on which the posting rules depend, was accepted the same day.
- Maintainer review decisions of 2026-10-15 are applied (section 27). Accountant approval of the posting dependencies
  is recorded in section 25.
- Every sale line snapshots `NONE` for tax until a separately reviewed pilot tax configuration exists (ADR-010
  section 11); this acceptance approves no tax rate.
