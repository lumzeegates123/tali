# ADR-010. Configurable tax treatment

- Status: ACCEPTED (2026-10-15). The tax **architecture** is accepted; the accountant's framework review is complete
  (T1 to T7 approved, section 12). **`NO_TAX` remains the default. No real tax rate, named tax or pilot tax
  configuration is approved by this acceptance;** any actual pilot configuration still requires its own separately
  reviewed configuration (section 11).
- Date: 2026-10-15
- Deciders: Tali maintainers (human approval given 2026-10-15), with accountant review of the framework. Drafted by an
  AI agent from the maintainer's Build 3 direction (2026-10-15), accepted by the human maintainer. Acceptance record in
  section 16.
- Related: `docs/product/mvp-scope.md` (Core MVP pricing and tax; open decision 5); `.cursor/rules/20-financial-integrity.mdc`
  ("Currency, pricing and tax"); ADR-002 section 13 (Money, rounding); ADR-005 (permissions); ADR-006 (audit);
  ADR-008 section 14 (selling price); ADR-009 (accepted; `TAX_PAYABLE` role); ADR-011 (accepted; sale line snapshots)
- Scope: the framework by which a business's own, reviewed tax configuration is applied to sale lines. It contains no
  jurisdiction's law and no rate.

## 1. Context

`mvp-scope.md` (APPROVED) requires "configurable tax treatment" with "no invented or hardcoded Nigerian tax rules or
rates", and accounting review before production use. `20-financial-integrity.mdc` forbids inventing or hardcoding tax
rules or rates anywhere and requires tax treatment to come from approved business configuration, snapshotted on
transaction lines.

The maintainer directed (2026-10-15) that Build 3 defaults to **no tax**, that this ADR defines the framework, and
that implementing it may be deferred: the tax slice of Build 3 runs only if this ADR and a reviewed pilot
configuration are both approved (`docs/plans/005-build-3-sales-ledger.md`, slice S8).

## 2. Decision summary

1. **No hardcoded jurisdiction rules or rates** in code, seed data, migrations, templates or tests' production paths.
2. **Default: `NO_TAX`.** A business with no configured treatment posts no tax and shows no tax.
3. **Business-owned tax treatments**, each with a **rate in basis points**, a **pricing mode** (inclusive or
   exclusive) and an explicit **rounding mode**.
4. **Line-level calculation**; no sale-level tax computation.
5. **Snapshots** of the treatment and computed amounts on every sale line.
6. A single **`TAX_PAYABLE`** account role (ADR-009).
7. **Product/variant assignment** of a treatment.
8. A clear distinction between **no tax**, **zero-rated** and **exempt**.
9. **No filing, returns, e-invoicing, stacked or compound taxes.**
10. Audited configuration under a dedicated permission.

## 3. No hardcoded rules

- The code knows only the mechanics in this ADR. It contains no tax name, rate, threshold, exemption list or
  jurisdiction.
- Test fixtures use obviously illustrative rates (for example 1,000 basis points) and never name a real tax.
- No seed data creates a treatment. A pilot configuration is entered by an authorized person after accountant/tax
  review, through the audited use case (section 10).

## 4. Tax treatment record

`tax_treatments` (business-owned):

| Column                         | Meaning                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `business_id`, `id` (UUIDv7)   | Tenant key and identity.                                                              |
| `name`                         | Business-chosen label (1 to 80 characters), shown on receipts.                        |
| `kind`                         | `STANDARD` (a positive rate), `ZERO_RATED` (rate 0, reported as taxable at zero) or `EXEMPT` (outside the tax, no rate). |
| `rate_bps`                     | Integer basis points, 1 to 10,000 for `STANDARD`; 0 for `ZERO_RATED`; NULL for `EXEMPT` (CHECK). |
| `pricing_mode`                 | `EXCLUSIVE` (tax added to the price) or `INCLUSIVE` (price contains tax); NULL for `EXEMPT`. |
| `rounding_mode`                | One of the `RoundingMode` values (ADR-002 section 13); `HALF_EVEN` default (T3).         |
| `status`                       | `ACTIVE` or `RETIRED`.                                                                |
| `version`                      | Optimistic concurrency; a treatment's rate, mode and rounding are **immutable** after creation. |
| envelope fields                | Created by, created at, retired by, retired at.                                       |

- To change a rate, the business retires the treatment and creates a new one, then reassigns products. Past lines
  keep their snapshots (section 7).
- `NO_TAX` is not a record: it is the absence of an assigned treatment.

## 5. Assignment

- `product_variants.tax_treatment_id` (nullable, composite tenant FK). NULL means `NO_TAX`.
- Assignment changes are audited and take effect for sales recorded afterwards.
- **A treatment cannot be retired while it is assigned to any active product variant** (maintainer decision M9).
  RetireTaxTreatment fails with `409 TAX_TREATMENT_IN_USE` (bounded list of variant IDs and the total count); the
  owner reassigns or unassigns those variants first. Retirement never silently changes what future sales charge.
- A retired treatment cannot be newly assigned (`TAX_TREATMENT_RETIRED` on assignment).
- Retirement and assignment both lock the treatment row `FOR UPDATE`, so an assignment cannot race a retirement.
- Consequently an active variant never references a retired treatment, and **normal sales never fail because of a
  retirement**. The sale use case treats such a state, if ever found, as an internal invariant violation (operator
  alert and consistency-check finding), not as a user-facing sale rule.
- **Archived variants and retired treatments** (maintainer decision M17). An administrative configuration rule only:
  1. An archived product or variant may keep a reference to a treatment that later becomes `RETIRED`. The
     retirement check above counts only active variants.
  2. A retired treatment never becomes active again because a product is reactivated.
  3. While the variant is still `ARCHIVED`, an OWNER (`tax:manage`) may assign a new `ACTIVE` treatment or explicitly
     clear the assignment to `NO_TAX` (audited as `product.tax_treatment_assigned`).
  4. ReactivateProduct (ADR-008) fails with `409 TAX_TREATMENT_RETIRED` while the variant still references a
     `RETIRED` treatment. Nothing changes: no status, version, assignment or audit record is written.
  5. Reactivation succeeds only after the user has explicitly assigned an `ACTIVE` treatment or cleared the
     assignment to `NO_TAX`. Reactivation never silently clears or replaces tax configuration.
  6. Historical sale tax snapshots (section 7) are immutable and unaffected.
  7. The rule alters no historical product, price, sale or tax record.
- No per-location, per-customer or per-channel treatment in Build 3.

## 6. Calculation

All amounts are integer minor units in the business currency (ADR-011 section 10 defines line gross and discount).
Let `base` be the line amount after discount.

- `EXCLUSIVE`: `tax = round(base x rate_bps / 10,000)`; the customer pays `base + tax`; revenue is `base` (with any
  discount presented as in ADR-009).
- `INCLUSIVE`: `tax = round(base x rate_bps / (10,000 + rate_bps))`; the customer pays `base`; revenue is
  `base - tax`.
- `ZERO_RATED`: tax 0, recorded as taxable at zero. `EXEMPT` and `NO_TAX`: tax 0, recorded as not taxable.
- `round` uses the treatment's `rounding_mode`, applied **once per line** (accountant-approved, T3).
- The sale's tax total is the sum of line taxes; it is never recomputed at sale level.
- **One pricing mode per business for the pilot** (maintainer decision M10): all `ACTIVE` `STANDARD` and
  `ZERO_RATED` treatments of a business use the same pricing mode. Creating a taxable treatment with a different mode
  fails with `409 TAX_PRICING_MODE_CONFLICT`; changing mode means retiring every active taxable treatment first.
  `NO_TAX` and `EXEMPT` are neutral and combine with either mode. A sale may therefore mix taxable, exempt and no-tax
  lines, but never inclusive and exclusive taxable lines.
- Example (illustrative 10%, not a real rate): exclusive base 900.00 gives tax 90.00 and a total of 990.00; inclusive
  base 1,000.00 gives tax 90.909... rounded `HALF_EVEN` to 90.91 and revenue 909.09 (ADR-009 section 31, H and I).

## 7. Line snapshots

Each sale line stores: `tax_treatment_id` (nullable), `tax_name`, `tax_kind` (`NONE`, `STANDARD`, `ZERO_RATED`,
`EXEMPT`), `tax_rate_bps`, `tax_pricing_mode`, `tax_rounding_mode`, `taxable_base_minor`, `tax_minor`. They are
immutable. Reversals copy them; nothing is recomputed from the current configuration.

## 8. Posting

Tax collected posts as a credit to `TAX_PAYABLE` inside the sale entry (ADR-009). A reversal debits it exactly. One
`TAX_PAYABLE` account per business in Build 3; separate accounts per treatment are a later chart decision
(accountant-approved, T5). Settlement with a tax authority, filing and returns are out of scope.

## 9. Not in scope

Tax filing and returns, e-invoicing or fiscal device integration, tax on purchases (input tax), withholding taxes,
stacked or compound taxes, tax-on-tax, thresholds, registration logic, multiple jurisdictions, per-customer
exemption certificates, and any rule that depends on law encoded in code.

## 10. Permissions and audit

- New permission `tax:manage`, **OWNER only** in Build 3 (maintainer decision M11): create and retire treatments,
  assign them to variants.
- Reading treatments uses `product:read`.
- Audit actions: `tax.treatment_created` (name, kind, rate, pricing mode, rounding mode), `tax.treatment_retired`,
  `product.tax_treatment_assigned` (variant ID, from and to treatment IDs). Same transaction, ADR-006 payloads.
- Keyed idempotency for creation and assignment (ADR-004).

## 11. Rollout

- The schema (table, variant column, line snapshot columns) may ship before configuration exists; every line then
  snapshots `NONE`.
- Configuring a treatment for a pilot business requires: this ADR accepted, the accountant/tax reviewer's written
  approval of that business's treatments, and an OWNER entering them. No migration or seed creates them.

## 12. Accountant/tax review (framework complete; configuration review still required)

**Accountant review outcome (Osasu, 2026-10-15; evidence in `docs/reviews/build-3-accountant-review.md` section
14):** T1 to T7 **APPROVED** to the extent covered by the review pack. This approves the framework in this ADR: line
treatments, the `STANDARD` / `ZERO_RATED` / `EXEMPT` / no-tax distinctions, per-line `HALF_EVEN` rounding, tax after
the line discount, one `TAX_PAYABLE` account, and one pricing mode per business. **It does not configure tax.** No
real tax rate, named tax or pilot treatment was supplied by the review, and none is recorded here. Every business
stays `NO_TAX` until a specific pilot configuration is separately reviewed and entered by an OWNER (section 11).

The questions below are unchanged from the reviewed draft.

- T1. Is a single treatment per product line sufficient for the pilot businesses?
- T2. Are `STANDARD`, `ZERO_RATED`, `EXEMPT` and no-tax the right distinctions, and must receipts show them?
- T3. Line-level rounding with `HALF_EVEN` (or another mode), rather than rounding on the sale total.
- T4. Whether tax is computed after the line discount (as proposed) in both pricing modes.
- T5. One `TAX_PAYABLE` account, or one per treatment.
- T6. Whether one pricing mode per business (maintainer decision M10: inclusive or exclusive, never both, for all
  taxable treatments) is appropriate for the pilot businesses.
- T7. Which treatments, if any, the pilot businesses must configure, and the evidence for each rate (supplied by the
  reviewer, never by Tali's code).

## 13. Alternatives considered

- Hardcoded country tax tables: rejected by `mvp-scope.md` and `20-financial-integrity.mdc`.
- Sale-level tax: rejected; harder to snapshot and reverse per line, and inconsistent with line discounts.
- Mutable treatments with rate history: rejected for Build 3; retire-and-replace is simpler and keeps snapshots clear.

## 14. Consequences

- Build 3 can ship with `NO_TAX` and correct ledger postings; enabling tax is configuration plus review, not new
  accounting rules.
- Receipts and reports must distinguish no tax, zero-rated and exempt.

## 15. Compliance with governance rules

No invented rates or rules; integer basis points; explicit rounding; snapshots; audit; permission-checked
configuration; tenant-scoped records; no AI authority over tax.

## 16. Human approval record

- **Accepted 2026-10-15 by the human maintainer**, after AI-assisted drafting and review. The ADR was drafted with AI
  assistance; the AI agent did not accept it.
- Accountant review received from Osasu on 2026-10-15: T1 to T7 approved (section 12), covering the framework only.
- What this acceptance approves: the tax architecture in this ADR. What it does **not** approve: any real tax rate,
  named tax, treatment or pilot configuration. Every business stays `NO_TAX` until a specific pilot configuration is
  separately reviewed and entered under section 11. Rates are never invented or hardcoded. Build 3 slice S8 remains
  optional and runs only with such a reviewed configuration (`docs/plans/005-build-3-sales-ledger.md`).

Maintainer review decisions applied (2026-10-15): M9 (no retirement while assigned to an active
variant, section 5), M10 (one pricing mode per business, section 6), M11 (`tax:manage` OWNER only, section 10), M17
(archived variants referencing a retired treatment must be explicitly reassigned or cleared to `NO_TAX` before
reactivation, section 5).
