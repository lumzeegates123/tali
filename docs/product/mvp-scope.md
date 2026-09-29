# MVP Scope

Status: **APPROVED** product decisions (approved 2026-09-27; amended 2026-09-27 after the governance audit;
amended 2026-09-27 to record the AWS infrastructure direction; amended 2026-09-29 to record the initial private-pilot
role vocabulary).
Sections below are APPROVED unless marked otherwise. The "Open decisions" section is **not** approved and must
not be treated as decided. Changes to this scope must be recorded here (with date and reason), or in an ADR when
they affect architecture. Precedence between documents is defined in `AGENTS.md` section 4.

## MVP goal

Independent provisions / general-retail businesses in Nigeria can run their daily trading in Tali during a
**private pilot**: record sales, stock, restocking, customer credit, payments, expenses and supplier purchases
quickly (including by text, voice and photo), keep trading through connectivity drops, close each day with
confidence, and get correct, explainable answers to: *What did I sell? What did I earn? What is in stock? Who
owes me? What do I owe? What did I spend? Does my counted cash match what I expected?*

## Approved product decisions

### Initial market and currency

- First private pilot: **independent provisions / general-retail businesses in Nigeria**.
- Initial currency: **NGN**.
- The architecture is **currency-aware from the beginning**:
  - exactly **one currency per business** in the MVP, set when the business is created;
  - currencies are represented by **ISO 4217 codes** (e.g. `NGN`), with minor-unit precision taken from the
    currency definition;
  - **NGN is never hardcoded in domain logic** (it may appear only as configuration/seed data or a default for
    the pilot market);
  - operations involving **different currencies are rejected**. There is **no currency conversion** in the MVP;
    **multi-currency accounting and FX conversion are post-MVP**.

### Product surfaces

- **Primary merchant experience:** Android-first **React Native / Expo** mobile application.
- **Secondary:** **web application** for business configuration, data imports, reporting, reconciliation and
  deeper administrative review.
- **iOS** may later use the same React Native codebase but is **not required** for the private pilot.
- All surfaces (mobile, web, WhatsApp, integrations) use the **same Tali backend and domain services**. Client
  applications contain no authoritative domain logic.

### Locations

Tali is **location-aware from day one** (rules in `docs/architecture/data-principles.md` section 5).
In the private-pilot MVP:

- exactly **one active default location** is created automatically for each business;
- **no branch-management UI**;
- **no multi-location consolidated reporting**;
- **no transfer workflow** (`TRANSFER` is a post-MVP inventory movement type).

### Staff roles

Approved 2026-09-29 (maintainer decision recorded during Build 1 planning).

- Initial private-pilot roles: **`OWNER`**, **`MANAGER`**, **`CASHIER`**, **`STOCK_KEEPER`**, **`ACCOUNTANT`**.
- **No custom-role designer** in Build 1.
- Invitation links may grant **`MANAGER`**, **`CASHIER`**, **`STOCK_KEEPER`** or **`ACCOUNTANT`**. An invitation may
  **not** grant `OWNER`.
- `OWNER` is granted only later, through an existing owner's authorized membership-management action.
- The permissions each role receives are an architecture decision, recorded in
  `docs/decisions/ADR-005-identity-tenancy-authorization.md`. Which roles may operate offline remains open decision 3.

### Offline and intermittent connectivity

Tali is designed for intermittent connectivity. Initial offline goals on the mobile app:

- the product catalog can be viewed offline;
- **permitted** cash sales can be captured offline;
- **permitted** expenses can be captured offline;
- **permitted** inventory operations can be queued offline;
- locally accepted commands **survive app restart**;
- synchronization is **idempotent** (retries and duplicate uploads never double-record).

"Permitted" means the user's role allows the operation offline; offline permissions are configurable and
conservative by default.

**Offline business events are preserved.** A credible business event that actually happened offline (e.g. a
cash sale) must not disappear because current server state now conflicts with it (product archived, stock now
insufficient because another device sold units, stale price, changed catalog configuration). Such events are
preserved and flagged as **needs attention**. Rejection is permitted only for: invalid tenant; revoked or
unauthorized device or user according to approved policy; corrupted or tampered payload; impossible monetary
arithmetic; integrity or security failure. The server preserves what was actually charged/recorded locally when
credible, rather than recalculating history with a new price. Device time is evidence only and is not trusted
for authorization. Lifecycle: `docs/architecture/architecture-principles.md` section 7.

The UI must visibly distinguish these record states:

| UI state | Meaning |
|----------|---------|
| **Saved locally** | Recorded on the device and queued; not yet posted by the Tali backend. |
| **Synced to Tali** | Received, validated and posted by the Tali backend. |
| **Needs attention** | Received and preserved by the backend, but conflicts with current business state; awaiting authorized review. |
| **Externally verified** | A trusted external source (supported payment provider or bank) independently supports the fact. |

Rejected commands (only for the reasons above) are retained with their reason and shown to the user.

Online connectivity is required for: bank/payment-provider verification, cloud AI, WhatsApp, remote
synchronization, and connected reconciliation.

Design/test target: an **8-hour disconnected trading session** on the reference Android device. This is an
initial design and test target, **not a guaranteed SLA**.

Receipts issued offline carry a business/device-scoped human receipt number; the true transaction identifier
is an immutable UUID. The receipt number format is decided in the sync ADR.

### Voice, photo and WhatsApp

- These **are part of the private-pilot MVP** but are **not foundation milestones**; they come after the core.
- **Voice** in the MVP means **explicit push-to-talk or voice-note capture only**. No ambient or always-listening capture.
- **Photo/document capture** scope in the MVP: **receipts, supplier invoices, delivery notes, and payment/transfer
  screenshots**.
  - Payment/transfer screenshots are **low-trust `PAYMENT_CLAIM_EVIDENCE` only**. A screenshot may create evidence,
    suggest a payment candidate and help locate an invoice. It may **not** mark an invoice paid, mark a payment
    externally verified, or post a settlement. External verification requires a supported trusted provider/bank source.
- **WhatsApp** is an **adapter to the same Tali backend and domain services**, not a separate implementation.
- All of these produce **proposals** that users confirm. AI authority is defined canonically in
  `.cursor/rules/40-ai-safety.mdc`.

### Confirmation of payment matches

- In the private-pilot MVP, a **human confirmation** is required before any external payment match settles or
  allocates a financial balance.
- **AI may never automatically confirm or settle.**
- Deterministic matching may **propose** a high-confidence or exact match; a person confirms it.
- Automatic deterministic financial confirmation is allowed only later, through an explicitly accepted ADR after
  measured validation.

### Pricing, discounts and tax

- Products have a **selling price** and a **cost price where known**.
- Transaction lines store **price snapshots** at transaction time (unit price, cost where known, discount, tax
  treatment); later price changes never alter past transactions.
- **Simple discounts** only (e.g. a fixed amount or percentage on a line or a sale, subject to permission).
- **No complex promotion engine** (no bundles, rule-based promotions, loyalty schemes or coupon engines in MVP).
- **Tax:** Tali provides architecture for **configurable tax treatment** (per business and per product/line),
  but **does not invent or hardcode Nigerian tax rules or rates**. Actual pilot accounting and tax configuration
  **requires accounting review before production use**.

### Restocking and purchasing

- **Restock before full purchasing:** core inventory supports recording a stock receipt using the
  `PURCHASE_RECEIPT` movement type, with quantity received, unit/pack, unit cost where known, and source/reference
  where available. A stock purchase is **inventory acquisition, not automatically an operating expense**; its
  accounting treatment follows the approved posting rules.
- **Minimal suppliers/purchasing** is part of the core MVP and is delivered **before reconciliation and before
  photo/document capture**. It extends the same inventory movement model.
- The purchasing model distinguishes: `Supplier`, `PurchaseOrder`, `PurchaseOrderItem`, `GoodsReceipt`,
  `SupplierInvoice`, `SupplierPayment`, `Payable`, `SupplierReturn`.
- **Ordered, received, invoiced and paid quantities remain distinct** and are never collapsed into one field
  (see `docs/architecture/data-principles.md` section 8).

### Ledger from the first sale

- The **ledger posting foundation** (chart of accounts, deterministic posting rules, balanced journal entries)
  exists **before or together with the first sales implementation**, and before any other feature with accounting
  effects (e.g. restock with cost).
- Sales and payments post correct, deterministic accounting entries **from their first production-capable release**.
  Sales never exist for several builds without accounting effects.
- The later **"ledger/reporting completion"** milestone means: ledger reporting, account management, period controls,
  and accountant review capabilities.

### Daily close

- Daily close is an **operational close**: physical cash is counted (`CASH_COUNTED`) and compared to expected cash;
  variances are recorded as explicit adjustments with reason; unsynced, needs-attention, unconfirmed and
  unreconciled items are reviewed; a daily summary is produced.
- Daily close is **not an accounting-period close** and **does not lock the ledger**.
- Cash counting does **not** externally verify individual cash transactions.

### Infrastructure direction

Approved 2026-09-27. Detailed rationale, security direction and deferred items are in
`docs/decisions/ADR-001-aws-infrastructure.md` (status: ACCEPTED 2026-09-27). Infrastructure implementation
(CDK code, AWS accounts or resources) does not begin until both ADR-001 and the foundation infrastructure ADR are accepted.

- Tali **builds and owns its application backend**: **NestJS + TypeScript** (the modular monolith and its worker process).
- Tali runs on **AWS-native infrastructure** and does **not** use Supabase as its infrastructure foundation.
- **AWS provides infrastructure only**; authoritative business logic stays in the NestJS/domain application. Mobile
  and web talk to Tali's API and never directly mutate authoritative financial or inventory records through AWS services.
- Planned services: Amazon RDS for PostgreSQL, Amazon Cognito (authentication), Amazon S3, Amazon ECS on Fargate
  (API and worker), Amazon ECR, Amazon SQS, AWS Secrets Manager, AWS KMS, Amazon CloudWatch, AWS CDK in TypeScript
  (`infrastructure/cdk/`), GitHub Actions with AWS OIDC (no long-lived AWS keys), Amazon Route 53, AWS Certificate
  Manager; AWS Amplify Hosting is the preferred initial candidate for the Next.js web app.
- Not initially: Redis/Amazon ElastiCache (only on a concrete requirement), Amazon SES (when email workflows are
  required), LocalStack (only on a demonstrated requirement).
- Environments: isolated local, development, staging and production; no shared authoritative databases; long-term
  AWS account separation supported. Local development uses a local API, web and Expo app with Docker PostgreSQL and
  development/test adapters, without requiring AWS for every request.

## Scope tiers

### FOUNDATION

Prerequisites for any product feature. Not user-facing features by themselves.

- Governance (this documentation, rules, ADR process)
- Architecture (modular monolith design, module boundaries, offline/sync design)
- Repository (monorepo structure, tooling, CI)
- Authentication (users, sessions, business membership, roles and permissions, device registration)
- Tenant isolation (business-scoped data, server-side authorization, isolation tests)

### CORE MVP

The deterministic business platform. Must be reliable before any AI or channel work.

- **Catalog**: products and variants, selling price, cost price where known, archive (not delete).
- **Inventory**: movement-based stock using the canonical movement types; one default location per business;
  restock via `PURCHASE_RECEIPT`; stock counts via `COUNT_CORRECTION`; low-stock indicator; offline-queued
  permitted operations.
- **Sales**: cash and credit sales, multiple lines, price snapshots, simple discounts, configurable tax treatment,
  receipts, void/cancel via reversal with reason and permission; offline capture of permitted cash sales; ledger
  postings from the first release.
- **Customer balances**: customers, credit sales creating receivables, balances and statements.
- **Payments**: payments received (cash, bank transfer, POS/card, other methods recorded manually), allocation
  to receivables; expenses with categories (offline capture of permitted expenses).
- **Ledger**: posting foundation with the first sales; later completion of reporting (sales summary, simple profit
  and loss, cash/bank balances, stock value, receivables and payables aging), account management, period controls
  and accountant review capabilities. Default chart of accounts subject to accounting review.
- **Daily close**: operational close as defined above.
- **Minimal suppliers/purchasing**: the eight purchasing concepts above, with distinct quantities.
- **Reconciliation**: evidence records and the reconciliation vocabulary (`docs/architecture/reconciliation-principles.md`);
  human-confirmed matching of recorded payments against statements or provider records.

Also in the core: audit trail for all financial and inventory mutations, permission changes and sensitive settings.

Amendment (2026-09-27): minimal suppliers/purchasing moved from PRIVATE PILOT COMPLETION to CORE MVP so that
supplier invoice and delivery note capture has the entities it needs.

### PRIVATE PILOT COMPLETION

Required before the private pilot is considered complete. Built on top of the core, in the order below.

- **Text AI**: in-app text capture producing confirmable proposals; answers to questions from the business's own data.
- **Explicit voice**: push-to-talk / voice-note capture producing proposals (same pipeline as text AI).
- **Photo/document capture**: receipts, supplier invoices, delivery notes and payment/transfer screenshots
  (low-trust evidence only) producing proposals or evidence.
- **One payment-provider integration**: authenticated, idempotent inbound events providing external verification
  and feeding reconciliation (human-confirmed matching).
- **Narrow WhatsApp channel**: a limited set of flows as an adapter to the same backend and domain services.

### POST-MVP / RESEARCH

Explicitly **not** in the MVP. Do not build, scaffold or design detailed implementations for these without a new
product decision and ADR.

- Ambient / always-listening **Store Mode**
- RFID
- Sensor integrations
- Autonomous financial decisions (including any automatic confirmation or settlement)
- Advanced embedded finance (lending, savings, insurance, payouts via regulated partners)
- Multi-country tax engines
- Multi-currency accounting and FX conversion

Also out of scope for the MVP unless a later decision changes it: iOS release, customer-facing ordering,
workflow automation, advanced business intelligence and forecasting, multi-location operations (branch management,
transfers, consolidated reporting), payroll, tax filing and e-invoicing compliance, complex promotions.

## Implementation order

```
1.  Foundation (governance, repository, tooling, CI)
2.  Identity / tenancy (authentication, businesses, staff, roles, devices, tenant isolation)
3.  Product catalog
4.  Inventory (default location, canonical movements, restock via PURCHASE_RECEIPT)
5.  Sales (ledger posting foundation exists before or with this step)
6.  Payments / receivables
7.  Ledger / reporting completion
8.  Daily close
9.  Minimal suppliers / purchasing
10. Reconciliation
11. Text AI
12. Explicit voice
13. Photo / document capture
14. First payment-provider integration
15. WhatsApp
```

Any step with accounting effects (including restock with cost in step 4) posts through the ledger posting foundation;
if restock with cost ships before sales, the posting foundation is built first.

## Open decisions (NOT approved)

1. Reference Android device (model / Android version / RAM) for the 8-hour offline target.
2. Offline needs-attention workflow: who may resolve conflicts, how resolution is recorded, and how
   needs-attention items are reflected in expected cash at daily close.
3. Which roles may operate offline by default, and limits (e.g. maximum offline sale value, maximum offline duration).
4. Whether offline credit sales or offline customer payments are ever permitted (currently: not in initial offline goals).
5. Default chart of accounts, posting rules and tax configuration for the pilot (requires accounting review).
6. Inventory valuation method (requires accounting review and ADR).
7. Discount rules: who may apply discounts, maximums, and how discounts interact with tax.
8. Daily close details: who performs it, whether a day can be reopened, and how late-synced offline records are handled after close.
9. Unit-of-measure and pack model (e.g. carton vs single unit) for restock, purchasing and sale.
10. Which payment provider is integrated first.
11. The narrow WhatsApp flows for the pilot (e.g. record sale, record expense, daily summary, customer balance).
12. How a single WhatsApp identity selects the active Tali business when the same user belongs to multiple businesses.
13. Languages for the pilot (e.g. English, Nigerian Pidgin, Yoruba, Hausa, Igbo) for UI, text AI and voice.
14. Media and data retention (no production retention periods are defined yet; requires legal review, e.g. under
    Nigerian data protection law) for: intentional voice recordings; transcripts; uploaded images and documents
    (including payment screenshots); and future ambient audio buffers.
15. Device and user revocation policy: which offline records from a revoked device or user are accepted, held or rejected.

## Exit criteria for the private pilot

- Pilot businesses operate for at least four weeks using Tali as their primary record of sales, stock, credit,
  payments, expenses and supplier purchases.
- The ledger always balances; stock on hand always equals the sum of movements; daily close is completed each trading day.
- An 8-hour disconnected session on the reference device completes without data loss and synchronizes
  idempotently (no duplicates, no silently dropped business events).
- No cross-tenant access findings.
- Every financial and inventory mutation has the tests required by `.cursor/rules/60-testing.mdc`.
- Pilot tax and accounting configuration has been reviewed by an accountant before production use.
