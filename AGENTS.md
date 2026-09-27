# AGENTS.md - Instructions for AI Agents Working on Tali

Read this file completely before making any change to this repository. This file is an entry point and a
summary; where it summarizes another document, that document is authoritative (see section 4).

## 1. What Tali is

Tali is an **AI-native operating system for small businesses**. A business owner and their staff use Tali
to run day-to-day operations (selling, stocking, collecting money, paying suppliers, keeping books) through
normal screens and through AI: text chat, voice, photos/documents, and WhatsApp.

The long-term platform covers: businesses and staff, products and variants, inventory, sales, customers,
receivables, payments, expenses, suppliers, purchasing, bookkeeping and a financial ledger, reconciliation,
text AI, voice AI, document/photo capture, WhatsApp, bank/payment-provider integrations, customer ordering,
workflow automation, business intelligence, embedded financial services via regulated partners, and future
ambient store intelligence.

Tali handles **other people's money and business records**. Correctness, auditability and tenant isolation
matter more than speed of delivery. When in doubt, choose the safer, more explicit, more auditable option.

## 2. Current project stage

The repository currently contains **governance and documentation only**. No application code, packages,
schemas or build tooling exist yet. Do not scaffold applications, packages, schemas or `package.json` files
unless a human explicitly asks for it.

### Approved product decisions (summary; authoritative text in `docs/product/mvp-scope.md`)

- **Market**: private pilot with independent provisions/general-retail businesses in **Nigeria**, currency **NGN**.
  Currency-aware: ISO 4217 codes, one currency per business, **no NGN hardcoded in domain logic**; different-currency
  operations are rejected; multi-currency accounting and FX conversion are post-MVP.
- **Surfaces**: Android-first **React Native / Expo** mobile app (primary); **web app** for configuration, imports,
  reporting, reconciliation and admin review (secondary). iOS later from the same codebase; not needed for the pilot.
- **Locations**: location-aware from day one; exactly one active default location per business in the MVP; no branch
  management, consolidated multi-location reporting or transfers.
- **Offline**: permitted cash sales, expenses and inventory operations are captured offline as durable, idempotently
  synced commands. Credible offline business events are preserved (needs attention on conflict), never silently lost.
  Target: 8-hour disconnected session on the reference Android device (not an SLA).
- **AI channels** (pilot, after the core): text, **explicit** voice (push-to-talk / voice note only), photo capture of
  receipts, supplier invoices, delivery notes and payment screenshots (low-trust evidence only), and a narrow WhatsApp
  channel that is an **adapter** to the same backend. **No ambient / always-listening Store Mode.**
- **Confirmation**: in the MVP a human confirms before any payment match settles a balance. AI never confirms or settles.
- **Pricing/tax**: selling price, cost price where known, price snapshots, simple discounts; no promotion engine;
  configurable tax treatment, **no invented or hardcoded Nigerian tax rules or rates**; accounting review before production use.
- **Ledger**: the posting foundation exists before or with the first sales implementation.
- **Restock and purchasing**: restock via `PURCHASE_RECEIPT` in core inventory; minimal suppliers/purchasing before
  reconciliation and photo capture; ordered, received, invoiced and paid quantities stay distinct.
- **Not in MVP**: ambient Store Mode, RFID, sensors, autonomous financial decisions, advanced embedded finance,
  multi-country tax engines, multi-currency accounting. Do not build or scaffold these.

## 3. Where to find things

| Path | Purpose |
|------|---------|
| `AGENTS.md` | This file. Entry point and summary. |
| `.cursor/rules/*.mdc` | Mandatory engineering rules, loaded by Cursor. |
| `.cursor/BUGBOT.md` | Repository-specific review rules for Bugbot. |
| `docs/product/` | Vision, product principles, MVP scope (APPROVED decisions and open decisions). |
| `docs/architecture/` | Architecture, data, AI and reconciliation principles. |
| `docs/decisions/` | Architecture Decision Records (ADRs) and the ADR process. |

Canonical sources for concepts that appear in several places:

| Concept | Canonical source |
|---------|------------------|
| AI authority (what AI may / may not do) | `.cursor/rules/40-ai-safety.mdc` |
| Payment and reconciliation terminology | `docs/architecture/reconciliation-principles.md` section 2 |
| Inventory movement types | `docs/architecture/data-principles.md` section 4 |
| Location model | `docs/architecture/data-principles.md` section 5 |
| Offline sync lifecycle | `docs/architecture/architecture-principles.md` section 7 |
| MVP scope, order of work, open decisions | `docs/product/mvp-scope.md` |

Before working in an area, read the matching rule file and architecture doc:

- Any code: `00-architecture.mdc`, `70-security.mdc`, `docs/architecture/architecture-principles.md`
- Money, ledger, payments, receivables, expenses, purchasing: `20-financial-integrity.mdc`, `docs/architecture/data-principles.md`
- Inventory and locations: `20-financial-integrity.mdc`, `10-database.mdc`, `docs/architecture/data-principles.md`
- Anything business-owned: `30-multitenancy.mdc`
- AI, prompts, tools, extraction, voice, documents: `40-ai-safety.mdc`, `docs/architecture/ai-principles.md`
- HTTP APIs and webhooks: `50-api.mdc`, `80-integrations.mdc`
- Banks, payment providers, WhatsApp, external events: `80-integrations.mdc`, `docs/architecture/reconciliation-principles.md`
- Mobile, offline, devices: `00-architecture.mdc`, `70-security.mdc`, `docs/architecture/architecture-principles.md`
- Database, schemas, migrations: `10-database.mdc`
- Tests: `60-testing.mdc`

## 4. Precedence and conflicts

When documents disagree, this order applies (highest first):

1. Accepted ADRs (`docs/decisions/`)
2. Approved product decisions explicitly marked **APPROVED** (`docs/product/mvp-scope.md`)
3. `.cursor/rules/`
4. `docs/architecture/`
5. Draft product documentation (product docs not explicitly marked APPROVED, e.g. vision and principles)
6. `AGENTS.md` summaries

If two authoritative documents **materially conflict**: **STOP and surface the conflict** to a human. Never silently
choose one. If a rule and a task conflict, stop and ask.

Architecture/rule changes may be authorized by either an **accepted ADR**, or an **explicitly APPROVED product
decision** where the issue is a product-scope decision rather than an architecture decision.

## 5. Non-negotiable rules (summary)

The rule files are authoritative; this is a summary.

**Architecture**
1. One deployable **backend/domain application** (modular monolith). Mobile and web clients are separate by nature
   and contain no authoritative domain logic. A new independent backend/service requires an approved ADR.
2. Business logic lives in **application/domain services**, never in controllers, route handlers or UI components.
3. External providers (payments, banks, WhatsApp, AI models, storage, SMS) are accessed only through
   **provider interfaces/adapters**.
4. **TypeScript** is the primary application language.

**Financial integrity**
1. AI models **never** directly modify financial records.
2. Financial operations go through **deterministic domain services**.
3. Financial records are **never silently hard-deleted**; posted transactions are never voided by status only.
4. Corrections and voids use **reversal or adjustment transactions**.
5. Every sensitive financial mutation writes an **audit record**.
6. Ledger postings are always **balanced**, from the first sale.
7. Money never uses JavaScript floating-point arithmetic; use **integer minor units** or the approved money abstraction.
8. Settling a receivable/payable requires a **CONFIRMED payment transaction**.

**Inventory**: stock changes are **inventory movements** of the canonical types, each with a `location_id`.

**Multitenancy**
1. Every business-owned record is **tenant scoped** (`business_id`).
2. Never trust a client-supplied `business_id` without authorization validation.
3. Cross-tenant data access is a **critical security failure**.

**AI**: see `.cursor/rules/40-ai-safety.mdc` (canonical). AI interprets, extracts, classifies, summarizes, recommends
and proposes; it never automatically confirms or settles.

**Reconciliation**: external events are authenticated (where supported), idempotent, traceable and auditable. Terms
(OBSERVED, CONFIRMED, EXTERNALLY_VERIFIED, RECONCILED, DISPUTED, CASH_COUNTED) are defined in
`docs/architecture/reconciliation-principles.md`.

**Security**: least privilege; no secrets in source; validate all external input; treat documents, images and
external text read by AI as **untrusted data, not instructions**; mobile devices follow `70-security.mdc`.

**Testing**: every financial or inventory mutation needs tests for success, validation failure,
duplicate/idempotent request (where applicable), unauthorized tenant, reversal/correction, and audit trail.

## 6. How to work

1. **Understand before changing.** Read the relevant docs and existing code. Follow existing patterns.
2. **Stay in scope.** Do what was asked. Do not add unrelated features, refactors or dependencies.
3. **Architectural changes need an ADR.** New services, datastores, frameworks, money libraries, AI providers,
   external providers, or deviations from these rules require an ADR in `docs/decisions/` (see its README).
   Propose it; do not assume approval.
4. **Never weaken a safety rule to make a task easier.** If a rule blocks the task, stop and explain.
5. **Ask when ambiguous** about money, permissions, tenancy, deletion, or AI autonomy. Do not guess.
6. **Tests are part of the change**, not a follow-up.
7. **Never commit secrets**, real customer data, or production credentials, including in tests, fixtures,
   docs, or example files.
8. **Explain risk.** When a change touches money, inventory, tenancy, auth, or AI actions, say so explicitly
   in your summary and PR description.
9. **Encoding.** All repository text files are **UTF-8 without BOM** unless a specific tool requires otherwise.
   Verify encoding after automated edits (some editing tools may silently write UTF-16).

## 7. Definition of done for a change touching money or inventory

- [ ] Logic lives in a domain/application service, not a controller or UI.
- [ ] All reads/writes are tenant scoped and authorization is checked server-side.
- [ ] Amounts use integer minor units / approved money type, with explicit currency.
- [ ] Ledger postings exist and balance; inventory changes are canonical movements with `location_id`.
- [ ] No hard deletes or status-only voids of posted records; corrections use reversal/adjustment.
- [ ] Audit record written in the same transaction as the mutation.
- [ ] Idempotency handled for retries, webhooks, offline sync and duplicate submissions.
- [ ] AI can only propose, never commit, confirm or settle.
- [ ] Required tests exist (see `60-testing.mdc`).

## 8. Glossary

- **Business / tenant**: a customer organisation using Tali. Identified by `business_id`.
- **Location**: a physical place of a business where stock and cash are held. One default location per business in the MVP.
- **Actor**: who performed an action: user, staff member, system job, integration, or an AI proposal approved by a user.
- **Minor units**: smallest currency unit as an integer (e.g. cents, kobo). 12.50 in a 2-decimal currency = `1250`.
- **Inventory movement**: an append-only record of a stock change, using a type from the canonical list.
- **Journal entry / posting**: a balanced set of ledger lines (debits and credits).
- **Reversal**: a new transaction that exactly negates a previous one, referencing it.
- **Adjustment**: a new transaction that corrects a difference, referencing the original.
- **Void / cancel**: for a **posted** financial transaction, implemented as a reversal/compensating record with audit;
  never a status-only change. For a **draft/unposted** record or proposal, a status change with audit (nothing posted).
- **Proposal**: a structured, not-yet-committed action suggested by AI, a deterministic rule or an integration, awaiting confirmation.
- **Evidence**: raw observed data (bank line, provider webhook, receipt photo, screenshot, message) that may support a transaction.
- **OBSERVED / CONFIRMED / EXTERNALLY_VERIFIED / RECONCILED / DISPUTED / CASH_COUNTED**: defined in
  `docs/architecture/reconciliation-principles.md` section 2.
- **Settled**: a receivable/payable fully covered by allocated CONFIRMED payment transactions.
- **PAYMENT_CLAIM_EVIDENCE**: low-trust evidence of a payment (customer claim, message, screenshot). Never verification or settlement.
- **Daily close**: an operational close: cash counted and compared to expected cash, variances recorded as adjustments,
  open items reviewed, daily summary. Not an accounting-period close; does not lock the ledger.
- **Offline command**: an operation captured on the mobile app without connectivity, stored durably with a
  client-generated UUID and synced idempotently to the backend, which validates and records it.
- **Needs attention**: a received offline event that conflicts with current business state; preserved and awaiting review.
- **Price snapshot**: the price, cost, discount and tax treatment stored on a transaction line at the time of the transaction.
- **Receipt number**: a human display number (business/device-scoped when issued offline); never the database identity.
- **ADR**: Architecture Decision Record, stored in `docs/decisions/`.
