# Build 3 accountant review: sales, ledger and stock valuation

> Outcome (added after review): **REVIEWED AND RESOLVED.** Answered by Osasu on 2026-10-15, with the question 23
> clarification on the same date (sections 14 and 14.1). The original text below is kept as reviewed.
>
> Governance note (added 2026-10-15): accounting review complete. ADR-009 A1 to A22 and ADR-010 T1 to T7 are
> resolved and were accepted into ADR-009 and ADR-010 (both ACCEPTED 2026-10-15 by the human maintainer). Actual
> pilot tax rates and configuration were not part of this review; they remain a separate reviewed configuration.

Status: **FOR ACCOUNTANT REVIEW.** Nothing described here is built yet. Your answers decide whether the proposals are
accepted, changed or reconsidered. Technical detail is in `docs/decisions/ADR-009-ledger-accounting-inventory-valuation.md`
(ledger and valuation), `docs/decisions/ADR-010-configurable-tax-treatment.md` (tax) and
`docs/decisions/ADR-011-sales-transaction-model.md` (sales).

All amounts below are in "business currency", written with two decimals for readability. The 10% rate used in the
tax examples is chosen only to make the arithmetic easy. **It is not any country's tax rate.**

## 1. What Tali is

Tali is software for small shops (the first users are provisions and general-retail shops). Owners and staff use it on
a phone or a computer to record products, stock and, from Build 3, sales. Tali keeps the shop's records; it does not
hold or move money.

## 2. Why Build 3 introduces accounting

Until now Tali has counted stock in units only, with no money value. Build 3 adds the first sales. We have decided
that every sale must produce correct double-entry bookkeeping from the very first day, rather than adding accounting
later. So Build 3 also introduces:

- a chart of accounts for each shop;
- automatic, balanced journal entries for every sale and every stock change that affects value;
- a stock value for each product, so that the cost of goods sold can be recorded.

Staff never type journal entries. Each entry is produced by a fixed rule from the business event (a sale, a delivery,
a write-off). Entries are never edited or deleted: a mistake is corrected by a reversing entry.

## 3. Proposed chart of accounts

One set per shop. The codes and names are proposals; please correct them.

| Code | Name                                   | Type                   | Purpose                                                     |
| ---- | -------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| 1000 | Cash on hand                           | Asset                  | Cash taken at the till                                      |
| 1010 | Bank transfers pending verification    | Asset                  | Transfers the cashier says were received, not yet checked against the bank |
| 1020 | POS/card clearing                      | Asset                  | Card payments waiting to be settled by the card provider    |
| 1030 | Other tender clearing                  | Asset                  | Any other payment method                                    |
| 1200 | Inventory                              | Asset                  | Value of stock on hand                                      |
| 2100 | Tax payable                            | Liability              | Tax collected on sales, if the shop configures any         |
| 2200 | Goods received not invoiced            | Liability              | Value of deliveries recorded with a cost, before a supplier invoice exists in Tali |
| 3000 | Opening balance equity                 | Equity                 | Balancing side when existing stock is first given a value   |
| 4000 | Sales revenue                          | Revenue                | Sales at full price, before discounts, excluding tax        |
| 4010 | Sales discounts                        | Contra-revenue         | Discounts given on sale lines                               |
| 4100 | Inventory gains                        | Revenue                | Stock found in excess at a count                            |
| 5000 | Cost of goods sold                     | Expense                | Cost of stock sold                                          |
| 5100 | Inventory shrinkage                    | Expense                | Stock written off, lost or short at a count                 |

Accounts for customers owing money, suppliers, bank accounts and expenses come in later builds.

## 4. Proposed sale postings

For a sale of 2 units at 500.00 each, paid in cash, where the stock cost is known to be 350.00 per unit:

| Account             | Debit    | Credit   |
| ------------------- | -------- | -------- |
| Cash on hand        | 1,000.00 |          |
| Sales revenue       |          | 1,000.00 |
| Cost of goods sold  | 700.00   |          |
| Inventory           |          | 700.00   |
| **Total**           | 1,700.00 | 1,700.00 |

The same sale paid by bank transfer debits "Bank transfers pending verification" instead of cash; by card, "POS/card
clearing". If the customer pays 600.00 in cash and 400.00 by transfer, both accounts are debited and the total is the
same. The cost lines do not change with the payment method.

In Build 3 a sale must be paid in full at the time of sale, and every sale has a total above zero (free or zero-total
sales are not part of Build 3). Selling on credit comes in Build 4.

**Dates.** A sale's accounting date is always the shop's local date at the moment Tali's server records it. A time
reported by the phone or till is kept only as supporting evidence; it can never backdate a sale, its stock movement,
its cost or its tax.

**Cash received and change.** For cash, Tali may store the cash handed over and the change given, for the receipt.
These do not affect the books: only the sale amount is posted to "Cash on hand".

## 5. Weighted average cost

We propose a **perpetual weighted average cost** for each product at each shop location:

- Tali keeps the total value of the stock of a product.
- When stock arrives with a known cost, that cost is added to the total value.
- When stock leaves (a sale, a write-off), the value removed is the total value times the share of units leaving,
  rounded to the nearest minor unit (ties to the even digit, "banker's rounding").
- When the last unit leaves, exactly the remaining value is removed, so rounding never leaves value behind.

Example: 10 units valued at 3,500.00 in total. A sale of 2 units removes 3,500.00 x 2 / 10 = 700.00, leaving 8 units
valued at 2,800.00. A delivery of 5 units costing 1,800.00 then gives 13 units valued at 4,600.00, an average of
about 353.85 per unit (shown for information; Tali stores the total, not the average).

We considered FIFO and rejected it for the pilot as more complex for small shops whose costs are often unknown.

## 6. Existing stock with unknown cost

Shops already in Tali have recorded quantities without costs. We will not guess these costs. Each product's stock is
therefore marked either **valued** or **unvalued**:

- **Unvalued** stock still works for counting and selling. A sale of an unvalued product records the revenue and the
  payment, but **no cost of goods sold** for that line. Screens show "cost unknown" and no margin.
- When the shop later gives the stock a value (section 7), cost of goods sold is recorded **from that point on**.
  Earlier sales are not changed and no cost is filled in after the fact.
- If a delivery of a valued product arrives without a cost, the delivery is still accepted and the product becomes
  unvalued again, rather than Tali guessing a cost. Only an owner or manager may enter costs.

Example of an unvalued sale: Dr Cash on hand 1,000.00 / Cr Sales revenue 1,000.00, and nothing else.

**What this means for the figures.** While any product is unvalued:

- its quantity is still correct;
- the inventory value Tali has recorded is **incomplete** and should not be relied on as a full valuation;
- its sales have revenue but their cost of goods sold is unknown and not posted, so Tali shows no margin for them;
- any future inventory-value or gross-margin report must clearly mark totals as incomplete, or not show them;
- the books show only the values actually recorded. Tali never fills in missing costs, and never claims a complete
  stock valuation while unvalued stock exists.

## 7. Opening valuation

There are two different situations, and we treat them differently.

**A. Initial opening valuation (proposed).** Stock that has never had a value in Tali, mostly stock that existed
before Tali kept accounts. An owner or manager enters the total value (or a cost per unit) of the quantity currently
on hand. Subject to your approval, Tali posts:

| Account                  | Debit    | Credit   |
| ------------------------ | -------- | -------- |
| Inventory                | 3,500.00 |          |
| Opening balance equity   |          | 3,500.00 |

New products recorded with an opening quantity and a cost are posted the same way. Deliveries with a cost are posted
Dr Inventory / Cr Goods received not invoiced (example: 1,800.00 each side), until purchasing and supplier invoices
exist in Tali.

**B. Later valuation after normal operations (not decided).** A product that already had a value can become unvalued
during normal trading, for example when a delivery is recorded without its cost. When the owner later gives it a
value again, using "Opening balance equity" would probably be wrong, because this is not opening stock. **We have not
decided which account should take the other side of that entry, and we are asking you (question 23).** Until you
answer, Tali will not offer this kind of valuation: such products stay unvalued.

> Outcome (added after review): answered by the accountant on 2026-10-15. See section 14 for the approved treatment.

## 8. Discounts

Discounts are given per sale line only, as an amount or a percentage, by owners and managers. We propose showing
revenue at full price and the discount separately:

| Account             | Debit    | Credit   |
| ------------------- | -------- | -------- |
| Cash on hand        | 900.00   |          |
| Sales discounts     | 100.00   |          |
| Sales revenue       |          | 1,000.00 |
| Cost of goods sold  | 700.00   |          |
| Inventory           |          | 700.00   |
| **Total**           | 1,700.00 | 1,700.00 |

Percentage discounts are rounded to the nearest minor unit (banker's rounding). A discount can never be 100% of a
line: every line keeps a positive amount, so every sale has a positive total.

## 9. Tender clearing accounts

A cashier's statement that a transfer or card payment was received is **not proof**: Tali does not yet check it
against the bank or card provider. We therefore propose separate asset accounts ("pending verification" and
"clearing") rather than posting straight to a bank account. Matching these balances to bank and provider records is
a later feature (reconciliation). Card fees are not recorded in Build 3.

## 10. Reversal treatment

A reversal **corrects a sale that was recorded in error** (for example the wrong product or the wrong payment
method). It is **not** a customer return or refund; those come later. A sale can only be reversed in full, by an owner
or manager, with a reason, at any later date. Before completing it, the owner or manager must confirm that the
original payment has been handed back or undone as applicable (cash returned, transfer sent back, card payment voided).
Tali does not check that refund itself in Build 3.

Tali posts the exact opposite of the original entry, on the date the reversal is recorded, and puts the stock back
at the cost recorded on the original sale:

| Account             | Debit    | Credit   |
| ------------------- | -------- | -------- |
| Sales revenue       | 1,000.00 |          |
| Cash on hand        |          | 1,000.00 |
| Inventory           | 700.00   |          |
| Cost of goods sold  |          | 700.00   |
| **Total**           | 1,700.00 | 1,700.00 |

The original entry stays in the books. Reversing the payment lines reverses the cashier's original statement of how
the sale was paid. Tali records no separate refund payment.

## 11. Tax framework

By default **no tax** is applied. Tali contains no country's tax rules or rates. A shop owner may later set up tax
treatments (a name, a rate, whether prices include the tax, and a rounding method), only after you have approved that
shop's configuration. Only the owner may set up tax. Tax is calculated per sale line, after the line discount, and
stored on the line. For the pilot, a shop uses one pricing style for all its taxed products: either all prices
include tax or all prices have tax added, never a mix. A tax setting still in use on a product cannot be withdrawn
until the product is moved to another setting. A withdrawn setting can never come back into use by accident: an
archived product that still points to one cannot be brought back into sale until the owner explicitly chooses a
current setting or "no tax". Past sales always keep the tax recorded on them.

Illustrative 10% (not a real rate), tax added to the price, on the discounted line above:

| Account             | Debit    | Credit   |
| ------------------- | -------- | -------- |
| Cash on hand        | 990.00   |          |
| Sales discounts     | 100.00   |          |
| Sales revenue       |          | 1,000.00 |
| Tax payable         |          | 90.00    |
| Cost of goods sold  | 700.00   |          |
| Inventory           |          | 700.00   |
| **Total**           | 1,790.00 | 1,790.00 |

Illustrative 10%, tax included in a price of 1,000.00: tax = 1,000.00 x 10 / 110 = 90.909..., rounded to 90.91.

| Account             | Debit    | Credit   |
| ------------------- | -------- | -------- |
| Cash on hand        | 1,000.00 |          |
| Sales revenue       |          | 909.09   |
| Tax payable         |          | 90.91    |
| Cost of goods sold  | 700.00   |          |
| Inventory           |          | 700.00   |
| **Total**           | 1,700.00 | 1,700.00 |

The framework distinguishes "no tax", "zero-rated" and "exempt". Tax returns, filing and electronic invoicing are not
part of Tali at this stage.

## 12. Questions for the accountant

The codes in brackets match the technical documents (ADR-009 section 32, ADR-010 section 12).

1. (A1, A2) Is the chart in section 3 suitable, including codes, names and account types?
2. (A3) Is one "Cash on hand" account enough for cash sales?
3. (A4) Is "Bank transfers pending verification" an acceptable asset for unconfirmed transfers?
4. (A5) Is "POS/card clearing" acceptable, with card fees left for later?
5. (A6) Is "Other tender clearing" acceptable for other methods?
6. (A7) Revenue recognised on the sale date: agreed?
7. (A8) Discounts shown separately as contra-revenue (section 8) rather than revenue net of discount?
8. (A9) Should stock found at a count be "Inventory gains" (revenue) or a reduction of shrinkage expense?
9. (A10) Should a delivery's cost be entered as a total for the line (proposed) or per unit?
10. (A11) Is "Opening balance equity" the right balancing account for the **initial** valuation of stock that has
    never had a value (section 7, situation A), including units received without cost before that first valuation?
11. (A12) Is "Goods received not invoiced" the right interim account for deliveries with a cost?
12. (A13) Our maintainer has decided that a reversal is dated on the day it is recorded, not the original sale date.
    Is that acceptable?
13. (A14, T5) One "Tax payable" account, or one per tax treatment?
14. (A15) Is perpetual weighted average cost per product and location acceptable?
15. (A16) Is the unvalued-stock treatment (revenue but no cost of goods sold, no later back-filling, figures marked
    incomplete, section 6) acceptable?
16. (A17) Is the initial opening valuation process acceptable, with no revaluation of already valued stock in
    Build 3?
17. (A18) Our maintainer has decided that a delivery without a cost is accepted and makes a valued product unvalued.
    Is that acceptable from an accounting point of view?
18. (A19) Is banker's rounding acceptable for cost of goods sold, discounts and weighed quantities?
19. (A20, T3) Is tax rounded per line with banker's rounding acceptable?
20. (T4) Should tax be calculated after the line discount in both pricing modes? With tax-included prices, the
    discount is posted at its tax-included amount: acceptable?
21. (T1, T2, T6, T7) Which tax treatments, if any, do the pilot shops need, and is one pricing style per shop (all
    tax-included or all tax-added) appropriate?
22. (A21) Do any of the examples in this document need correcting?
23. (A22) **Open question, no proposal.** When a product that had a value became unvalued during normal trading (for
    example after a delivery without cost) and the owner later gives it a value again (section 7, situation B), which
    account or treatment should take the other side of the value recorded? _(Answered after review; see section 14.)_

## 13. Answer table

Please mark one of APPROVE, CHANGE or COMMENT for each question and add any note.

| No. | Topic                                     | APPROVE | CHANGE | COMMENT | Notes |
| --- | ----------------------------------------- | ------- | ------ | ------- | ----- |
| 1   | Chart of accounts                         |    X     |        |         |       |
| 2   | Cash on hand                              |    X     |        |         |       |
| 3   | Bank transfers pending verification       |    x     |        |         |       |
| 4   | POS/card clearing                         |    X     |        |         |       |
| 5   | Other tender clearing                     |    X     |        |         |       |
| 6   | Revenue on sale date                      |    X     |        |         |       |
| 7   | Discount presentation                     |    X     |        |         |       |
| 8   | Count surpluses                           |    X     |        |         |       |
| 9   | Delivery cost as line total               |    X     |        |         |       |
| 10  | Opening balance equity (initial valuation) |   X     |        |         |       |
| 11  | Goods received not invoiced               |    X     |        |         |       |
| 12  | Reversal date                             |    X     |        |         |       |
| 13  | Tax payable accounts                      |    X     |        |         |       |
| 14  | Weighted average cost                     |    X     |        |         |       |
| 15  | Unvalued stock                            |    X     |        |         |       |
| 16  | Opening valuation                         |    X     |        |         |       |
| 17  | Delivery without cost                     |    X     |        |         |       |
| 18  | Rounding (cost, discount, weight)         |    X     |        |         |       |
| 19  | Tax rounding                              |    X     |        |         |       |
| 20  | Tax after discount                        |    X     |        |         |       |
| 21  | Pilot tax treatments and pricing style    |    X     |        |         |       |
| 22  | Examples                                  |    X     |        |         |       |
| 23  | Later valuation after normal operations   |    X     |        |         |       |

Reviewer name: ____Osasu________________ Date: ___10/15/2026_________

The maintainer records the outcome in each ADR's approval section. Any CHANGE answer that alters a posting rule sends
the affected ADR back to drafting before acceptance.

## 14. Review outcome

Recorded by the maintainer from the completed answer table above, which is preserved as evidence.

- Reviewer: Osasu
- Date: 2026-10-15
- Rows 1 to 22: **APPROVED** (ADR-009 A1 to A21; ADR-010 T1 to T7).
- Row 23 (ADR-009 A22): marked APPROVE in the table, but the question had no proposed treatment and no
  counter-account was written, so the mark alone was not treated as an answer and a clarification was requested.
- Row 21 approves the tax framework and the one-pricing-style rule. No tax treatment or rate was supplied for any
  pilot shop; every shop stays on "no tax" until a specific configuration is separately reviewed.

### 14.1 Clarification for question 23 (ADR-009 A22)

Given by the accountant, Osasu, on 2026-10-15. **Status: APPROVED / RESOLVED.**

When a product that had a value became unvalued during normal trading and is later explicitly valued again, the
difference between the new value and the value already recorded is treated as an **inventory gain or adjustment**,
using the inventory adjustment accounts already approved:

| Situation                                        | Debit              | Credit             |
| ------------------------------------------------ | ------------------ | ------------------ |
| The new value is higher than the recorded value  | Inventory          | Inventory gains    |
| The new value is lower than the recorded value   | Inventory shrinkage | Inventory         |

- "Opening balance equity" is **not** used for this. It stays limited to the first valuation of stock that existed
  before Tali kept accounts (section 7, situation A).
- The valuation is an explicit action by an owner or manager, with a reason, and is recorded in the audit trail.
- It values the quantity on hand at that moment. If stock changes while the owner is entering the value, Tali refuses
  it and asks them to check again.
- It never changes earlier stock movements, sales, cost of goods sold or journal entries. The new total value counts
  from that point on, and no cost of goods sold is filled in for sales made while the product was unvalued.

Example: 20 units with a recorded value of 4,946.67 are valued at 7,000.00. Tali posts Dr Inventory 2,053.33 /
Cr Inventory gains 2,053.33. Valued at 4,500.00 instead, it posts Dr Inventory shrinkage 446.67 / Cr Inventory 446.67.

With this clarification, all 23 review questions are resolved (ADR-009 A1 to A22; ADR-010 T1 to T7).
