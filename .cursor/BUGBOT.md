# Bugbot Review Rules for Tali

Tali is an AI-native operating system for small businesses. It records sales, inventory, payments,
receivables, expenses and a financial ledger for many businesses (tenants) in one system. Bugs here can
lose money, corrupt books, or leak one business's data to another. Review accordingly.

Authoritative sources and their precedence are defined in `AGENTS.md` section 4 (accepted ADRs, APPROVED
product decisions, `.cursor/rules/`, `docs/architecture/`, ...). AI authority is canonical in
`.cursor/rules/40-ai-safety.mdc`; payment/reconciliation terms in `docs/architecture/reconciliation-principles.md`;
inventory movement types and the location model in `docs/architecture/data-principles.md`. When a finding maps to
one of the rules below, cite the rule name and file. If governance documents themselves conflict, report the conflict.

## Severity

- **Critical**: cross-tenant access, missing authorization on business resources, AI writing directly to
  financial data, hard deletion of financial records, committed secrets, unverified webhooks that change money state.
- **High**: financial mutation without audit, unsafe monetary arithmetic, unbalanced ledger postings,
  non-idempotent webhook or payment processing, inventory changed without movements.
- **Medium**: missing required tests for financial/inventory changes, business logic in controllers/UI,
  vendor SDK used outside an adapter, missing input validation.

## Rules to flag

### 1. Missing tenant isolation (Critical)
Flag when:
- A query, repository method, cache key, storage path, search/vector query or job on business-owned data
  does not filter/scope by `business_id` from a server-resolved `BusinessContext`.
- A new business-owned table/entity lacks a non-null `business_id`, or its unique constraints omit `business_id`.
- `business_id` is read from request body/query/header/path, webhook payload, WhatsApp message or AI output and
  used without verifying the actor's membership in that business.
- Related IDs (customer, product, supplier, account) in input are not verified to belong to the same business.
- Background jobs or events do not carry and re-validate `business_id`.

### 2. Hard deletion of financial records (Critical)
Flag any `DELETE`, `TRUNCATE`, ORM `.delete()`/`.deleteMany()`/`.destroy()`, `ON DELETE CASCADE`, or cleanup job
affecting sales, payments, receipts, invoices, receivables, payables, expenses, purchase orders, ledger/journal
entries, inventory movements, reconciliation records, cash sessions or audit logs. Also flag in-place updates of
posted amounts, and **status-only voids/cancels of posted transactions**.
Expected: reversal or adjustment transactions that reference the original, with reason and audit record.
(Cancelling an unposted draft or proposal by status change with audit is fine.)

### 3. AI writing directly to financial tables (Critical)
Flag when code in AI/agent/prompt/tool/LLM modules:
- imports repositories, ORM models or DB clients for financial or inventory tables;
- calls commit-style services (post, confirm, settle, reconcile, void, pay, transfer, adjust stock, send PO,
  extend credit, send committing messages) instead of creating a proposal;
- automatically confirms or settles anything (AI may never automatically confirm or settle);
- uses model output without schema validation, or lets model output choose the tenant or bypass permissions;
- treats text from documents, images, messages or transcripts as instructions.
Expected: AI creates proposals; deterministic application services commit after authorization.

### 4. Financial mutations without audit records (High)
Flag creation, posting, reversal, adjustment, settlement, status change or amount change of financial or
inventory records that does not write an audit record (actor, tenant, action, entity, before/after, reason,
correlation ID) **in the same transaction**.

### 5. Unsafe monetary arithmetic (High)
Flag:
- `number` arithmetic on money (`+ - * /` on prices, totals, balances, taxes), `parseFloat`, `Number(amountString)`,
  `toFixed` used for money, `Math.round(x * 100)`, float literals like `19.99` for amounts.
- Money types or columns declared as `float`, `double`, `real`, or JSON floats in API contracts.
- Money values without a currency, or arithmetic across different currencies without explicit conversion.
- Rounding without an explicit rounding mode; splitting amounts in a way that can lose or create minor units.
- Ledger journal entries whose debits and credits are not verified to balance.
Expected: integer minor units (`bigint`) or the approved `Money` abstraction.

### 6. Non-idempotent webhook processing (High)
Flag webhook, provider callback, polling or statement import code that:
- does not verify signatures/authenticity when the provider supports it;
- does not persist the raw event with a unique `(provider, external_event_id)` (or equivalent) before processing;
- can apply the same event twice (double settlement, double stock movement, double posting);
- resolves the tenant from payload fields instead of stored connection configuration;
- directly marks payments as settled/reconciled from an event without a CONFIRMED payment transaction
  (terminology: `reconciliation-principles.md` section 2), or settles/allocates a balance from a match without
  human confirmation (MVP);
- treats a screenshot, customer claim or WhatsApp message (`PAYMENT_CLAIM_EVIDENCE`) as external verification or
  settlement.
Also flag mutating financial API endpoints that lack an idempotency key, and outbound money movements retried
without an idempotency key.

### 7. Secrets committed to source (Critical)
Flag API keys, tokens, passwords, private keys, webhook secrets, connection strings with credentials, or
realistic-looking live keys in any file, including tests, fixtures, docs, examples, `.env*` files (other than
`.env.example` with placeholders), CI configs and migrations. Also flag logging of secrets, tokens, OTPs or full
account/card numbers.

### 8. Missing authorization on business resources (Critical)
Flag endpoints, server actions, resolvers, jobs or AI tools that access business data without:
- authentication, and
- a server-side check that the actor belongs to the business and has the specific permission for the action.
Flag responses that reveal whether a resource exists in another tenant (should be `404`), and admin/support
access paths that are not audited.

### 9. Missing tests for financial changes (Medium, High if logic is complex)
For any change that adds or modifies a financial or inventory mutation, flag missing tests for:
success; validation failure (nothing persisted); duplicate/idempotent request (where applicable);
unauthorized tenant; reversal or correction; audit trail. For ledger code also require a balance assertion;
for inventory, on-hand = sum of movements.

### 10. Product-decision violations (High)
Flag:
- **Hardcoded currency** in domain logic (e.g. `'NGN'`, naira-symbol-based parsing, fixed `/ 100`), or currency-less amounts.
  `NGN` is allowed only in configuration, seed data or pilot defaults.
- **Hardcoded tax rules or rates** (Nigerian or other) in code instead of per-business configuration.
- Multi-currency accounting or FX logic (not in MVP scope).
- Sales/purchase lines that do not snapshot price, discount and tax treatment, or reports that recompute past
  transactions from current prices.
- Purchasing code that collapses or overwrites **ordered, received, invoiced or paid quantities**.
- **Non-idempotent offline sync**: commands without client-generated UUIDs, sync that can double-apply, local commands
  not persisted before the UI confirms them.
- **Lost offline business events**: credible offline events rejected, dropped or recalculated because of business-state
  conflicts (archived product, insufficient stock, stale price, catalog change) instead of preserved as
  `NEEDS_ATTENTION`; rejection for reasons other than the permitted ones; device time used for authorization.
- UI that shows a locally saved record as synced, or a synced record as externally verified.
- Human receipt numbers used as primary keys, or offline issuance that requires a globally sequential number.
- Inventory movements without `location_id`, movement types outside the canonical list in
  `data-principles.md` section 4, or transfer/branch-management/consolidated multi-location features (post-MVP).
- Stock purchases/restocks recorded as operating expenses instead of `PURCHASE_RECEIPT` inventory acquisition.
- Sales or payments shipped without ledger postings.
- Daily close code that locks the ledger or treats counted cash as externally verifying individual transactions.
- Mobile code that mixes businesses/users in one local store, keeps tenant data after logout contrary to policy,
  or lacks device revocation checks on sync.
- Any **always-listening / ambient microphone** capture, wake-word listening, or background recording (MVP voice
  is push-to-talk or voice note only).
- A WhatsApp implementation with its own business logic, permissions or data store instead of adapting to the
  shared backend services.
- Code or scaffolding for post-MVP items (ambient Store Mode, RFID, sensors, autonomous financial decisions,
  advanced embedded finance, multi-country tax engines, multi-currency accounting).

## Also flag

- Business logic in controllers, route handlers, webhook handlers or UI components (`00-architecture.mdc`).
- Vendor SDK imports outside `infrastructure/` adapters, including AWS SDK (`@aws-sdk/*`) imports in domain,
  application, controller or client code.
- Business logic placed in AWS services (Cognito triggers, database triggers/procedures, S3/SQS event handlers,
  functions outside the NestJS/domain application) instead of domain/application services (`00-architecture.mdc`).
- AWS credentials in mobile/web code or bundles; long-lived AWS access keys in CI configuration instead of OIDC;
  publicly accessible S3 buckets or production RDS; wildcard IAM permissions without justification (`70-security.mdc`).
- Tenant authorization derived from identity-provider (Cognito) claims alone instead of Tali's membership data.
- Security-weakening development/test adapters that can be enabled in deployed environments.
- Stock quantity set by overwriting a field instead of recording an inventory movement.
- New microservice, separate deployable, datastore or provider without an ADR in `docs/decisions/`.
- Missing schema validation on external input (HTTP, webhooks, files, AI output).
- String-built SQL or shell commands, `eval` of input or model output.

## Do not flag

- Soft deletion or status-based discarding of **unposted drafts** when it is audited.
- Use of `number` for non-monetary values (counts, pagination, percentages expressed in basis points as integers).
- Test fixtures using obviously fake placeholder secrets such as `test_secret` or `sk_test_placeholder`.
