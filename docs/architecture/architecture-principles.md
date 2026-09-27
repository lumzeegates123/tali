# Architecture Principles

Enforced by `.cursor/rules/00-architecture.mdc`. This document explains the reasoning and the intended shape
of the system. Specific technology choices (framework, database, hosting, queue) are made through ADRs in
`docs/decisions/`.

## 1. Modular monolith first

Tali starts as a single deployable application made of strongly separated modules.

Why:
- The domain is still being discovered. Module boundaries will move; moving code inside one codebase is cheap,
  moving it across services is expensive.
- Financial operations often span modules (a sale touches sales, inventory, receivables and ledger). A monolith
  lets these commit in one database transaction, which is the simplest way to stay correct.
- A small team can operate one deployable reliably.

Rules:
- There is **one deployable backend/domain application** initially.
- **Client applications are separate by nature**: the Android/mobile app and the web app are deployed separately
  from the backend. They are clients, not services, and must not contain authoritative domain logic.
- Creating a **new independent backend or service** (microservice, separately deployed backend) or adding a
  datastore requires an approved ADR.
- An ADR to extract a service must show a concrete need (scaling, isolation, compliance, team ownership) and
  explain how consistency, idempotency, tenancy and audit are preserved across the boundary.
- Separate *processes* of the same backend codebase (e.g. API server and background worker) are acceptable; they
  share modules and the database and are not independent services.

## 2. Modules and boundaries

Expected initial modules (names indicative):

| Module | Responsibility |
|--------|----------------|
| `identity` | Users, authentication, business membership, roles, permissions, devices |
| `business` | Business profile, settings, currency, time zone, locations (one default in MVP) |
| `catalog` | Products, variants, prices |
| `inventory` | Inventory movements (canonical types in `data-principles.md` section 4), stock levels, counts, restock |
| `sales` | Sales, returns, receipts |
| `customers` | Customer records |
| `receivables` | Customer credit, balances, allocations |
| `payments` | Payments received/made, payment methods |
| `expenses` | Expenses and categories |
| `suppliers` / `purchasing` | Suppliers, purchase orders, goods receipts, supplier invoices, supplier payments, payables, supplier returns |
| `tax` | Configurable tax treatments (no hardcoded jurisdiction rules) |
| `ledger` | Chart of accounts, journal entries, periods, financial reports |
| `daily-close` | Operational close: cash sessions, cash count vs expected, variances, review of open items, daily summary |
| `sync` | Offline command intake, idempotent replay, conflict reporting |
| `reconciliation` | External evidence, matching, reconciliation states |
| `ai` | Interpretation, extraction, proposals, assistant, model adapters |
| `integrations` | Provider connections, webhooks, adapters |
| `audit` | Audit records |

Rules:
- Each module owns its tables. Other modules do not read or write them directly; they use the owning module's
  public application API or subscribe to its domain events.
- A module exposes a small public surface (application services, DTOs, events). Everything else is internal.
- Cyclic dependencies between modules are not allowed.

## 3. Layers inside a module

```
interface/       HTTP controllers, route handlers, webhook endpoints, job handlers, UI adapters
application/     use cases (application services), transactions, authorization, idempotency, orchestration
domain/          entities, value objects (Money, Quantity), domain services, invariants; no I/O
infrastructure/  repositories, database mapping, provider adapters, queue/outbox implementations
```

- Dependencies point inward: interface -> application -> domain. Infrastructure implements ports (interfaces)
  declared by application/domain.
- **Controllers and UI components contain no business logic.** They authenticate, resolve tenant context,
  validate input, call an application service and format the result.
- **Domain and application services own business rules**: calculating totals, enforcing stock policy,
  posting balanced ledger entries, validating state transitions, writing audit records.
- The UI may do presentation-only computation (formatting, optimistic display) but the server is always the
  source of truth and re-validates everything.

## 4. Provider interfaces and adapters

Every external dependency is behind a port defined in Tali's terms:

- `PaymentProvider`, `BankFeedProvider`, `MessagingChannel` (WhatsApp, SMS), `LanguageModel`,
  `SpeechToText`, `DocumentExtractor`, `ObjectStorage`, `EmailSender`, etc.
- Adapters live in `infrastructure/`, translate vendor payloads to internal types, and contain all vendor SDK usage.
- This keeps domain code testable, allows switching providers, and contains the blast radius of vendor changes.
- Adding a provider or a regulated financial partner requires an ADR.

## 5. Consistency and side effects

- A use case that changes money or stock commits its records, ledger postings, inventory movements and audit
  records in **one database transaction**.
- Side effects outside the database (messages, provider calls, notifications) are triggered via a
  **transactional outbox** and processed by idempotent workers, so that a crash never leaves the books and the
  outside world disagreeing silently.
- All mutation entry points are idempotent (idempotency keys or natural keys).

## 6. Client surfaces and channels

Approved surfaces (see `docs/product/mvp-scope.md`):

- **Mobile app** (primary): Android-first, React Native / Expo, TypeScript. iOS may later reuse the same codebase.
- **Web app** (secondary): configuration, imports, reporting, reconciliation, administrative review.
- **WhatsApp**: a channel adapter.

Rules:
- All surfaces are **clients of the same backend and domain services**. No surface has its own business rules,
  its own copy of posting logic, or its own data store of record.
- **WhatsApp is an adapter**, not a separate implementation: it authenticates the sender, maps them to a
  business membership, converts messages to the same commands/proposals used by the app, and renders responses.
- Voice and photo capture are input methods that feed the same AI proposal pipeline as text.
- Shared TypeScript contracts (command/DTO schemas) may be shared between backend and clients, but authoritative
  domain logic lives on the backend. Client-side calculations needed offline (e.g. a sale total) use the same
  shared money/tax calculation code; the server checks their arithmetic on sync and records what was actually
  charged (see section 7).

## 7. Offline-first mobile and synchronization

Tali is designed for intermittent connectivity. Initial offline goals: view catalog; capture permitted cash
sales, permitted expenses and permitted inventory operations; commands survive app restart; synchronization is
idempotent. Design/test target: an 8-hour disconnected trading session on the reference Android device (not an SLA).

Principles:
- **Command queue, not local ledger.** The device records *commands* (e.g. `RecordCashSale`, `RecordExpense`,
  `RecordStockAdjustment`) in a durable local store. The **backend remains the system of record** and performs
  authoritative validation, ledger posting, inventory movements and audit when commands sync.
- **Client-generated identity.** Each offline command carries a client-generated unique ID (UUID/ULID) used as its
  idempotency key, plus device ID, actor, business ID, and the business time at which it was captured.
  Re-uploading the same command never creates a duplicate.
- **Durability.** Locally accepted commands are persisted before the UI confirms them and survive app restarts,
  crashes and device reboots. Local data is encrypted at rest where the platform allows.
- **Permitted operations only.** Offline capability is granted per role and operation. Anything requiring
  verification, cloud AI, WhatsApp, provider calls or connected reconciliation is online-only.
- **Server re-validates on sync**: tenancy, device and user authorization (current server authorization is
  rechecked), payload integrity, arithmetic, currency, and business state (product, price, stock policy).
- **Lifecycle.** Each offline command follows:
  - `LOCALLY_RECORDED -> SYNC_RECEIVED -> VALIDATED -> POSTED`, or
  - `LOCALLY_RECORDED -> SYNC_RECEIVED -> CONFLICT -> NEEDS_ATTENTION` (resolved later by an authorized user
    through application services), or
  - `REJECTED` (retained with reason and shown to the user).
- **Credible business events are preserved.** An event that actually happened offline must not disappear because
  current server business state now conflicts with it. Reviewable business-state conflicts include: product archived
  after an offline sale; stock became insufficient because another device sold units; stale price; changed catalog
  configuration. These are preserved and flagged as `NEEDS_ATTENTION`.
- **Rejection is permitted only for**: invalid tenant; revoked or unauthorized device or user according to approved
  policy; corrupted or tampered payload; impossible monetary arithmetic; integrity or security failure.
- **What was charged is preserved.** Price, discount and tax treatment used offline travel with the command as
  snapshots. When credible, the server records what was actually charged/recorded locally rather than silently
  recalculating history with a new price; differences from current configuration are flagged.
- **Device time is evidence only** and is never trusted for authorization.
- **Identity.** The command's UUID is the transaction's permanent identity. Offline receipts use business/device-scoped
  human receipt numbers (format decided in the sync ADR); the receipt number is never the database identity.
- **Visible states** in the UI: *saved locally*, *synced to Tali*, *needs attention*, *externally verified*, plus
  rejected with reason (mapping in `reconciliation-principles.md` section 4).
- **Ordering.** Sync preserves per-device command order; the server tolerates late and out-of-order arrival across
  devices (e.g. after daily close), handled by explicit rules rather than assumptions.
- **Device security** (partitioned local stores, logout cleanup, device registration and revocation, separate staff
  sessions on shared devices, minimal local data) is mandatory: see `.cursor/rules/70-security.mdc`.
- Detailed sync protocol, receipt number format, needs-attention workflow and local storage technology are
  decided by ADR.

## 8. Language and code standards

- TypeScript is the primary application language, `strict` mode enabled.
- Runtime validation of all external input with schemas (e.g. Zod or an equivalent chosen by ADR).
- No `any` in domain/application code. Use `unknown` plus validation.
- Money is represented by an approved `Money` abstraction or integer minor units (`bigint`), never `number` floats.
- Other languages (e.g. Python for ML workloads) require an ADR and must sit behind a port.

## 9. Cross-cutting concerns

- **Tenancy**: every request/job/event has a `BusinessContext` resolved server-side (see `30-multitenancy.mdc`).
- **Authorization**: permission checks happen in application services (and may be duplicated at the edge).
- **Audit**: a shared audit service used by all modules; audit writes are part of the business transaction.
- **Observability**: structured logs with correlation IDs, business ID and actor; no secrets or sensitive personal data in logs.
- **Time**: store UTC; convert using the business's time zone for display and period boundaries.

## 10. Evolving the architecture

- Significant decisions are recorded as ADRs before implementation.
- Architecture and rule changes are authorized by either an **accepted ADR**, or an **explicitly APPROVED product
  decision** (recorded in `docs/product/mvp-scope.md`) where the issue is product scope rather than architecture.
- Document precedence and conflict handling are defined in `AGENTS.md` section 4.
