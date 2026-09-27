# Reconciliation Principles

Enforced by `.cursor/rules/80-integrations.mdc` and `.cursor/rules/20-financial-integrity.mdc`.
This document is the canonical definition of payment and reconciliation terminology. Other documents use these
terms with exactly these meanings.

Reconciliation is how Tali makes sure its books agree with reality: bank accounts, payment providers,
mobile money wallets, cash counts, supplier statements and customer confirmations.

In the MVP, reconciliation starts with human-confirmed matching and cash counting at daily close; **one
payment-provider integration** is added in the private-pilot completion tier. Bank feed integrations come later.

## 1. External events

Any information arriving from outside Tali's own confirmed transactions is an **external event**: webhooks,
provider API polling results, bank statement lines, uploaded statements, payment notifications, WhatsApp
messages ("I have paid"), photos of transfer screenshots.

External events must be:

- **Authenticated where supported**: verify provider signatures/HMAC, mTLS or tokens, with replay-window checks.
- **Idempotent**: each event has a unique key, `(provider, external_event_id)` or a content hash. Processing the
  same event twice has the same effect as processing it once.
- **Traceable**: the raw payload is stored, and every downstream proposal, transaction and reconciliation links to it.
- **Auditable**: receipt, verification result, processing outcome and every state change are recorded with actor
  and timestamp.

The tenant for an event is resolved from stored connection configuration (e.g. which business connected this
provider account), never from untrusted fields in the payload alone.

## 2. Terminology (canonical)

| Term | Meaning | Applies to |
|------|---------|------------|
| **OBSERVED** | Information/evidence was received and stored as-is. | Evidence |
| **PROPOSED** | Tali (a deterministic rule or AI) suggests what evidence represents or which records match. Not a financial record. | Proposal |
| **CONFIRMED** | An authorized user or an approved deterministic rule has accepted the business event; the domain service recorded it and posted the ledger. | Transaction |
| **EXTERNALLY_VERIFIED** | A trusted external source (supported payment provider or bank) has independently supported the relevant fact. | Transaction / fact |
| **RECONCILED** | Business records and the relevant evidence have been matched and differences resolved. | Transaction / account / statement |
| **DISPUTED** | A previously recorded or matched event is being challenged or investigated. | Transaction / match |
| **CASH_COUNTED** | Physical cash was counted during operational (daily) close. | Cash session |

Related terms:
- **Settled**: a receivable or payable balance is fully covered by allocated **CONFIRMED payment transactions**.
- **Rejected**: a proposal was declined; its evidence is retained and no transaction is recorded.
- **PAYMENT_CLAIM_EVIDENCE**: low-trust evidence that a payment was made, e.g. a customer's claim, a WhatsApp
  message or a payment/transfer screenshot. It is OBSERVED evidence only.

Rules:
- Evidence alone never settles a receivable or payable, posts revenue or changes inventory.
- **Settling a receivable/payable requires a CONFIRMED payment transaction.** Observed evidence, customer claims,
  screenshots and AI proposals alone never settle balances.
- A transaction may be CONFIRMED without external evidence (e.g. a cash sale); it is then not EXTERNALLY_VERIFIED.
- **A customer claim or screenshot is never external verification.** EXTERNALLY_VERIFIED requires a supported,
  authenticated provider or bank source.
- **Cash counting does not externally verify individual cash transactions.** CASH_COUNTED applies to the cash
  session, not to individual sales.
- Transitions happen only through the owning application services, are validated as state machines, and are audited.
- Resolving a dispute never deletes records; it uses reversal or adjustment transactions.

Typical flows:

```
OBSERVED evidence -> PROPOSED match -> CONFIRMED (by a person in the MVP) -> RECONCILED
OBSERVED evidence -> PROPOSED -> rejected (evidence retained, no transaction)
CONFIRMED (e.g. transfer recorded by staff) -> EXTERNALLY_VERIFIED (provider event) -> RECONCILED
CONFIRMED / RECONCILED -> DISPUTED -> resolved by reversal/adjustment, or restored with a note
```

## 3. Payment screenshots (PAYMENT_CLAIM_EVIDENCE)

Payment/transfer screenshots are allowed photo inputs and are **low-trust evidence only**.

A screenshot may:
- create evidence (OBSERVED);
- suggest a payment candidate (PROPOSED);
- help locate an invoice or receivable.

A screenshot may **not**:
- mark an invoice paid or a balance settled;
- mark a payment EXTERNALLY_VERIFIED;
- directly post a settlement.

A person may still record a payment they have independently confirmed (e.g. checked their bank app); that is a
CONFIRMED transaction by that person, not external verification, and the screenshot remains claim evidence.

## 4. Offline records and UI states

The mobile app records business events offline (lifecycle in `architecture-principles.md` section 7). UI states
map to this vocabulary:

| UI state | Sync lifecycle | Reconciliation terminology |
|----------|----------------|----------------------------|
| **Saved locally** | `LOCALLY_RECORDED` (and transient `SYNC_RECEIVED` / `VALIDATED`) | Not yet CONFIRMED in Tali's books |
| **Synced to Tali** | `POSTED` | CONFIRMED |
| **Needs attention** | `CONFLICT` -> `NEEDS_ATTENTION` | Preserved; awaiting authorized review; not yet CONFIRMED |
| **Externally verified** | `POSTED` | CONFIRMED and EXTERNALLY_VERIFIED |

- A locally saved record is never displayed as synced; a synced record is never displayed as externally verified.
- An offline event recorded by an authorized user becomes CONFIRMED in Tali's books when it is POSTED.
- Verification and connected reconciliation require connectivity.

## 5. Daily close

- Daily close is an **operational close**, not an accounting-period close, and does not lock the ledger.
- Physical cash is counted (CASH_COUNTED) and **compared to expected cash** (from CONFIRMED cash transactions).
  Differences are recorded as explicit variance adjustments with reason and actor.
- Daily close lists, for the business date: unsynced items, needs-attention items, PROPOSED (unconfirmed) items,
  CONFIRMED but unreconciled items, and DISPUTED items.
- Closing a day does not require every item to be reconciled; it records the state at close.

## 6. Matching and confirmation

- Matching logic (amount, currency, date window, reference, counterparty, payment method) is deterministic and
  explainable. AI may help interpret free-text references or propose candidate matches, but **AI may never
  confirm or settle**.
- Deterministic matching may **propose** high-confidence or exact matches.
- **Private-pilot MVP: a human confirmation is required** before an external payment match settles or allocates a
  financial balance.
- Automatic deterministic financial confirmation is allowed only later, through an explicitly accepted ADR after
  measured validation, limited in scope/amount, audited with the rule ID, and reversible.
- **Ambiguous** evidence (multiple candidate matches, partial amounts, unknown payer, currency mismatch) always goes
  to a human review queue.
- Partial payments, overpayments and one payment covering multiple invoices are represented explicitly through
  allocations, never by editing invoice amounts.
- Fees withheld by providers are recorded as separate expense postings, not netted silently.

## 7. Outbound money movement (future)

When Tali initiates money movement via a provider or regulated partner:

- Persist an outbound instruction record with an idempotency key *before* calling the provider.
- Send the idempotency key to the provider.
- Treat the synchronous response as provisional; final status comes from authenticated provider confirmation
  (webhook or status query), handled like any other evidence.
- Unknown outcomes (timeouts) go to `pending_confirmation` and are resolved by querying, never by blind retry.
- Requires explicit human authorization with appropriate permission and, where appropriate, step-up authentication.

## 8. Reporting

- Owners can see PROPOSED, needs-attention, unreconciled and DISPUTED items clearly separated from CONFIRMED,
  EXTERNALLY_VERIFIED and RECONCILED ones.
- Balances shown to users state which items are not externally verified or not reconciled.
- Reconciliation reports (e.g. book balance vs provider/bank balance with differences explained) are derived
  from records, not from AI summaries.
