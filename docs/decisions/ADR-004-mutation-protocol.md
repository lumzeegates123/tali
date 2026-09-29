# ADR-004. Mutation protocol: idempotency, audit, transaction boundary, outbox and retries

- Status: ACCEPTED (2026-09-29)
- Date: 2026-09-29
- Deciders: Tali maintainers (human approval given 2026-09-29; drafted by an AI agent, accepted by the human
  maintainer)
- Related: `docs/decisions/ADR-002-application-foundation.md` (accepted; sections 7, 11, 25 and 27),
  `docs/decisions/ADR-005-identity-tenancy-authorization.md` (accepted), `docs/architecture/data-principles.md`
  sections 11 to 13, `docs/architecture/architecture-principles.md` sections 7 and 9, `.cursor/rules/10-database.mdc`,
  `.cursor/rules/20-financial-integrity.mdc`, `.cursor/rules/30-multitenancy.mdc`, `.cursor/rules/50-api.mdc`,
  `.cursor/rules/60-testing.mdc`, `.cursor/rules/70-security.mdc`, `docs/plans/003-build-1-identity-tenancy.md`
  (approved in principle 2026-09-29)

Numbering note: ADR-003 is reserved for AWS foundation topology, which accepted ADR-002 already refers to. This ADR
therefore uses the next free number.

## 1. Context

ADR-002 section 25 requires a mutation-protocol ADR before the first mutating use case. Build 1 (identity and
tenancy) contains the first mutations: user registration, business creation, membership changes, invitations and
device registration. Those mutations are sensitive under `data-principles.md` section 12, because they cover
permission changes and sensitive settings. They need:

- idempotency for retries and duplicate submissions (`data-principles.md` section 13; `50-api.mdc`);
- an append-only audit record written in the same transaction as the change (`10-database.mdc`, `data-principles.md`
  section 12);
- one transaction boundary covering the business change, its audit and its idempotency state;
- a defined outbox for later asynchronous side effects (ADR-002 section 7).

Facts from the foundation:

- The `UnitOfWork` port (`packages/application/src/ports/unit-of-work.ts`) runs a callback in one interactive
  transaction with a chosen isolation level.
- Prisma is accepted with documented limitations (ADR-002 section 27). Row locks use parameterized `$queryRaw`. A
  serialization failure surfaces as the driver adapter error `TransactionWriteConflict`, which must be mapped when a
  retry policy is introduced.
- Custom SQL objects (CHECKs, partial unique indexes, grants) are verified by `verify-schema.mjs` and must be added
  to its expectations in the same change.
- Some Build 1 mutations happen before any business exists (registering a user, creating the first business). The
  existing idempotency principle says keys are "scoped by `business_id`", which does not cover them.

## 2. Decision summary

1. **Two idempotency mechanisms.** A mutation is idempotent through either a **keyed idempotency record**
   (`Idempotency-Key`) or a **natural idempotency rule** (a unique key or a state-setting rule). Every mutation
   declares which one it uses.
2. **Two keyed idempotency scopes.** Business-scoped records carry a non-null `business_id`. User-scoped records exist
   for user-level mutations that run before a business exists. The two scopes use two tables.
3. **Canonical command fingerprint.** The fingerprint is computed over the **validated, normalized application
   command** with a Tali canonical encoding (section 5). It never relies on `JSON.stringify`.
4. **Successful no-op.** A state-setting mutation whose target state already holds returns the current resource as
   a success and writes **no** business-effect audit record (section 7).
5. **Two audit tables, one audit port.** Business events use `business_audit_records` (non-null `business_id`).
   Platform events without a business use `platform_audit_records`. Payloads are bounded, action-specific and
   redacted (section 8).
6. **One transaction.** The business change, its audit records, its idempotency record and any outbox messages
   commit or roll back together (section 9).
7. **Outbox.** The transactional outbox protocol is defined here. Build 1 does not implement it, because Build 1 has
   no asynchronous side effects (section 10).
8. **Retries.** Transactions may be retried inside the unit of work only for serialization failures and deadlocks,
   within a bound. A retried transaction body makes no external calls. Lock timeouts map to a retryable conflict.
   Client retries follow section 11.
9. **One-time secrets.** Plaintext one-time secrets are never stored in a replayable idempotency result. A replay
   returns the resource plus `tokenAvailable: false` (or `credentialAvailable: false` for devices) (section 12).

## 3. Idempotency mechanisms

Every mutation use case declares exactly one mechanism:

| Mechanism | When used | Build 1 examples |
|---|---|---|
| Keyed (`Idempotency-Key` required) | Creates a new resource and has no natural unique key | CreateBusiness, CreateInvitation, RegisterDevice |
| Natural unique key | A unique constraint identifies the single allowed outcome | RegisterCurrentUser (`(provider, provider_subject)`), AcceptInvitation (single-use invitation plus one membership per user and business) |
| State-setting (natural no-op) | The command sets a target state or value | UpdateBusinessName, ChangeMemberRole, SuspendMember, ReactivateMember, RevokeInvitation, RevokeDevice |

State-setting and natural-key endpoints do not require an `Idempotency-Key`. If a client sends one, it is validated
for format and otherwise not stored in Build 1.

Future offline commands use their client-generated command UUID as the idempotency key. The sync ADR defines that
envelope; it reuses the business scope defined here.

## 4. Keyed idempotency

### 4.1 Inputs

| Input | Role |
|---|---|
| `Idempotency-Key` | Client-generated UUID (any RFC 9562 version), one per logical attempt. Other formats are rejected with `400 VALIDATION_FAILED`. A missing key on an endpoint that requires one is rejected with `400 IDEMPOTENCY_KEY_REQUIRED`. |
| Operation name | Stable, versioned use-case name, e.g. `business.create.v1`. Part of the fingerprint. |
| Actor | The authenticated principal (`actor_type`, `actor_id`). Part of the uniqueness scope, so one actor can never replay another actor's result. |
| Business | For business-scoped operations, the `business_id` from the resolved `BusinessContext`, never from the client alone. |
| Command fingerprint | SHA-256 over the canonical encoding of the validated command (section 5). |

### 4.2 Scopes and storage

- **Business scope:** `business_idempotency_records`
  - columns: `business_id` (NOT NULL, FK to `businesses`), `id`, `actor_type`, `actor_id`, `operation`,
    `idempotency_key`, `fingerprint` (32 bytes), `fingerprint_version`, `result` (bounded JSON), `resource_type`,
    `resource_id`, `created_at`, `expires_at`;
  - UNIQUE `(business_id, actor_type, actor_id, idempotency_key)`, plus UNIQUE `(business_id, id)`.
- **User scope:** `user_idempotency_records`
  - the same columns, with `user_id` (NOT NULL, FK to `users`) in place of `business_id`;
  - UNIQUE `(user_id, idempotency_key)`;
  - used only for user-level mutations that run before a business exists (Build 1: CreateBusiness). The actor is
    always that user.
- The app role has SELECT and INSERT on both tables, and no UPDATE or DELETE. Records are immutable once committed
  (section 4.3 explains why no in-progress row is needed).
- The stored `result` is the use case's result DTO, encoded by a per-operation result codec (so `bigint` and dates
  are encoded deterministically). It excludes one-time secrets (section 12) and is capped in size (16 KiB; see
  section 13).
  The API maps a stored result to the same HTTP status as the original response and adds `Idempotent-Replayed: true`.
- **Retention:** Build 1 keeps keyed-idempotency records for at least 30 days (section 13). The purge job, and any
  longer retention needed by offline sync, are decided with the sync ADR. Until a purge job is approved, records are
  retained.

### 4.3 Outcomes

The idempotency record is inserted **inside the same transaction as the mutation**. PostgreSQL makes a concurrent
insert of the same unique key wait until the first transaction commits or rolls back. This gives these outcomes:

| Situation | Result |
|---|---|
| New key | The mutation runs, and the record commits atomically with it. |
| Same key, same actor, same fingerprint, completed | Replay: return the stored result, with no new effect and no new audit record. |
| Same key, same actor, materially different canonical command (a different fingerprint, including a different operation) | `409 IDEMPOTENCY_KEY_REUSED`, with no effect. The stored result is not revealed. |
| Same key while the first request is still in progress | The second request waits on the unique index. If the first commits, the second becomes a replay. If the first rolls back, the second runs as a new request. If the wait exceeds the lock timeout, the response is `409 IDEMPOTENCY_IN_PROGRESS` (retryable). |
| Deterministic rejection (validation, permission, domain rule such as the last-owner rule) | Nothing is committed, including the idempotency record. A retry with the same key is re-evaluated against current state. |
| Transient failure (database unavailable, timeout, exhausted serialization retries) | Nothing is committed. The client may retry with the same key. |
| Commit succeeded but the response was lost | A retry with the same key is a replay. |

Recording deterministic rejections is **not** part of this ADR. A rejected request has no effect, so re-evaluating
it is safe. If a later feature needs stable replays of rejections (for example provider webhooks), it adds that with
its own decision.

Future operations with external side effects (payments, provider calls) cannot finish inside one database
transaction. They need a committed `IN_PROGRESS` state with a lease, plus reconciliation of the outcome. That
extension is defined with the first such feature. It is not needed in Build 1.

## 5. Canonical command serialization and fingerprinting

The fingerprint answers the question "is this the same command?". It is computed by one application-layer encoder
(`canonicalCommandEncoding`, version 1), never by `JSON.stringify`.

**Input:** the command *after* transport validation and application normalization (the object the use case will
execute), not the raw request body. Correlation IDs, headers, the idempotency key itself and transport metadata are
excluded.

**Encoding rules (version 1):**

1. **Operation and schema version** are always encoded first: `operation` and `commandSchemaVersion`.
2. **Objects:** keys sorted by Unicode code point of the key string. Keys whose value is absent are omitted.
3. **Absent, null and defaults:** schema defaults are applied during validation, before encoding, so an omitted field
   and an explicit default produce the same fingerprint. `null` is encoded explicitly and differs from absent. It is
   allowed only where the schema allows null.
4. **Strings:** converted to Unicode NFC **inside the encoder**, then encoded as UTF-8 with explicit length.
   This affects only the fingerprint (see "Canonicalization versus stored data" below).
5. **Integers:** `bigint` and safe integers are encoded as canonical base-10 strings (no leading zeros, `-0` rejected),
   tagged by type. Non-integer JavaScript numbers are rejected by the encoder, and money never appears as a float.
6. **Decimal strings** (for example exact rates) are normalized by their value object before encoding.
7. **Instants:** ISO 8601 UTC with millisecond precision and a `Z` suffix. **Business dates:** `YYYY-MM-DD`.
8. **Booleans and enums:** literal tokens.
9. **Arrays:** order is preserved, because order is significant by default. A field whose schema declares set
   semantics is sorted by the canonical encoding of its elements before encoding.
10. **Identifiers:** UUIDs in lowercase canonical form.
11. **Secrets:** plaintext bearer secrets are never fingerprint input. If a keyed command ever carries a secret, the
    secret is replaced by its SHA-256 digest before encoding. No Build 1 keyed command carries a secret.

**Canonicalization versus stored data.** These are two separate concepts:

- **Fingerprint canonicalization** (this section) exists only to decide whether two requests are the same command.
  NFC normalization, key ordering and the other rules above are applied to a transient encoding. They never change
  the command the use case executes or the values it persists.
- **Persisted-value normalization** is part of a field's own validation or domain contract. A field is normalized
  before persistence (for example trimmed, or converted to NFC) **only when that field's contract explicitly defines
  it**, as ADR-005 does for display names and business names.
- Nothing in this ADR permits silently rewriting arbitrary user-entered text before storage.
- Where a field's contract does normalize, the normalized value is the command value, so both concepts agree for
  that field.

**Fingerprint:** SHA-256 over the canonical byte encoding, stored with `fingerprint_version = 1`. A change to these
rules creates a new version. Records store their version, and a mismatch between versions is treated as a different
fingerprint.

**Tests:** property tests cover key-order independence, NFC equivalence, absent versus null, default application,
`bigint` round trips, array-order sensitivity and version separation.

## 6. Actor, business and operation checks before idempotency

Authentication, `BusinessContext` resolution and the permission check happen **before** the idempotency lookup. An
unauthorized actor therefore gets the same `404`/`403` it would get without a key, and it cannot learn about other
actors' keys or results. The business scope always comes from the resolved context.

## 7. Naturally idempotent state-setting mutations

**Rule (adopted from the maintainers' stated preference):** when a state-setting mutation requests a state or value
that already holds, the use case:

1. still performs authentication, tenant resolution, permission checks and target lookup (a no-op is not a way around
   authorization, and another tenant's target is still `404`);
2. takes the same locks it would take for a real change (for owner-affecting changes, the business row lock of
   ADR-005), so a concurrent change cannot interleave;
3. returns a **successful no-op**: the current resource, with the same success status as a real change;
4. writes **no** business-effect audit record;
5. may emit a structured log event (`mutation.noop`, with the operation and resource ID only). Logs are not audit.

Examples:

| Request | Current state | Result |
|---|---|---|
| Set business name | Name already equal (after NFC and trimming) | No-op success, no audit |
| Change member role | Membership already has that role | No-op success, no audit |
| Suspend member | Already SUSPENDED | No-op success, no audit |
| Reactivate member | Already ACTIVE | No-op success, no audit |
| Revoke invitation | Already REVOKED | No-op success, no audit |
| Revoke device | Already REVOKED | No-op success, no audit |

A **different** terminal state is not a no-op. It is an invalid transition and returns `409 CONFLICT`, with no
effect. Examples: revoking an ACCEPTED invitation, or changing the role of a SUSPENDED membership (ADR-005 section 9).

Consequence: a client retry after a lost success response is a no-op, so exactly one audit record exists for the
change. Any `reason` supplied with a no-op request is discarded.

## 8. Audit record architecture

### 8.1 Storage: two tables, one port

- `business_audit_records`: `business_id` NOT NULL (FK to `businesses`), UNIQUE `(business_id, id)`.
- `platform_audit_records`: events about the platform identity of a user, with no business: `user.registered`,
  `identity.linked`, and later `user.disabled` and support-access events. It carries `subject_user_id` (FK to
  `users`) and no `business_id`.
- One application port, `AuditWriter`, with `recordBusinessEvent(scope, event)` and `recordPlatformEvent(scope,
  event)`. Both write through the current `TransactionScope`, so they commit with the mutation.
- Both tables are insert-only for the application role (INSERT and SELECT granted; UPDATE and DELETE never
  granted), with the `delete`/`deleteMany` lint ban (ADR-002 section 12). `verify-schema.mjs` expectations are added
  in the same change.

**Alternative compared:** one `audit_records` table with a `scope` column (`PLATFORM` or `BUSINESS`), a nullable
`business_id`, and `CHECK ((scope = 'BUSINESS') = (business_id IS NOT NULL))`.

| | One table, nullable `business_id` | Two tables (chosen) |
|---|---|---|
| Tenant safety | A tenant-owned table with nullable `business_id` breaks the "non-null `business_id`" rule in `30-multitenancy.mdc`. Every tenant query must also filter on scope, so one missed filter can expose platform rows. | `business_audit_records` keeps the standard tenant shape (non-null `business_id`). Platform rows are never reachable from tenant queries. |
| Access control | Platform events (identity links, later support access) need stricter visibility than business events. That is harder to express on one table. | Grants and future readers differ per table. |
| Queries and reporting | One place to query a user's full history. | A user timeline needs a union of the two tables. That is acceptable because it is only needed for support tooling, which is deferred. |
| Schema cost | One table. | Two tables with the same envelope, built from one shared envelope definition in code. |

The two-table design costs one extra table and one union query. It keeps the tenant invariant intact, which matters
more. It also matches `data-principles.md` section 12, which lists `business_id` as a required audit field for
business events.

### 8.2 Envelope (both tables)

- `id` (UUIDv7) and `occurred_at` (server `Clock`, UTC).
- `action`, from a code-defined registry (e.g. `business.created`, `membership.role_changed`).
- `entity_type` and `entity_id`.
- Actor: `actor_type` (`user`, `system`, `integration`, later `ai_proposal` with an approving user), `actor_user_id`,
  `actor_membership_id` (business events only).
- `device_id` (only when it was verified in the context) and `location_id` where relevant.
- `source_channel` (`web`, `mobile`, `api`, and later channels).
- `correlation_id`, and `idempotency_key` when keyed.
- `reason`: bounded text (maximum of 500 characters; see section 13). It is required where the action schema
  requires it (reversals, adjustments, voids and permission changes, per `data-principles.md` section 12).
- `payload`: JSON, validated against the action's schema, with `payload_schema_version`. Size is capped (8 KiB; see
  section 13).

### 8.3 Payload safety

- Each action registers a **bounded, purpose-specific Zod schema** (`defineAuditAction(name, payloadSchema)`). The
  writer rejects unregistered actions and invalid payloads. Rejection fails the mutation rather than writing a
  partial record.
- Payloads are built **explicitly** by the use case from the changed fields (for example `{ fromRole, toRole }`).
  Entities, rows and DTOs are never serialized automatically.
- **Never included:** JWTs or other access tokens, invitation bearer tokens or their hashes, device credentials or
  their hashes, passwords and secrets, raw media or document content, full account or card numbers, and full
  external-identity token material. Provider subjects appear only masked (last 4 characters) where needed at all.
- **Enforcement:** a registry test rejects any audit schema field whose name matches a secret pattern (for example
  `token`, `secret`, `credential`, `password`, `hash`, `jwt`). Unit tests assert redaction for every Build 1 action.
- Security denials (failed logins, rejected tokens, cross-tenant probes) are structured **log** events, not audit
  records. Audit records describe committed changes.

## 9. Transaction boundary

One mutation is one `UnitOfWork.run` call containing, where applicable:

1. the locks the use case requires (e.g. the business row lock in ADR-005);
2. re-reading any state the decision depends on;
3. the domain decision (pure);
4. the business record writes;
5. the audit record or records;
6. the keyed idempotency record;
7. outbox messages (when a feature has asynchronous effects).

All of these commit together, or none do.

- **No non-transactional external side effects inside a transaction body.** Section 11 may re-run a body
  automatically after a serialization failure or deadlock, so the body must be safe to run more than once. That holds
  only when it performs nothing but work in this database transaction. A retried body must never call:
  - payment providers;
  - banking providers;
  - messaging or email providers;
  - Cognito mutation APIs;
  - S3 operations;
  - external AI providers;
  - any other remote service.
- External effects happen only after commit, through the transactional outbox (section 10) or through an explicitly
  approved idempotent post-commit mechanism.
- If a decision needs information from a remote service, that information is fetched and validated before the
  transaction starts, never inside it. State in Tali's own database is still re-read inside the transaction (step 2).
- **Default isolation:** `read-committed` with explicit row locks. A use case may declare `repeatable-read` or
  `serializable` where its invariant needs it, and that choice is tested.
- Transactions are short and bounded by the configured transaction timeout (ADR-002 section 27).
- The response is built from the committed result. Nothing is reported as done before commit.

## 10. Transactional outbox (protocol defined; not implemented in Build 1)

- `outbox_messages`: `business_id` NOT NULL, `id` (UUIDv7), `message_type`, `payload_schema_version`, `payload`
  (bounded, same redaction rules as audit), `correlation_id`, `dedupe_key`, `status` (`PENDING`, `PUBLISHED`,
  `FAILED`), `attempts`, `available_at`, `claimed_until`, and timestamps. It is written only inside the business
  transaction.
- **Relay:** the worker claims batches with `FOR UPDATE SKIP LOCKED` using short leases and publishes each message
  through `QueueProvider`. SQS is used when deployed. Locally, the worker polls and dispatches directly (ADR-002
  section 7). Published messages are marked `PUBLISHED`. Failures back off, and after a bounded number of attempts
  a message is marked `FAILED` for operator attention.
- **Delivery is at-least-once.** Consumers are idempotent through
  `processed_messages (consumer, message_id)` UNIQUE, written in the same transaction as the consumer's effects.
- The message envelope carries `businessId`, the actor, `correlationId` and the dedupe key. The worker rebuilds and
  re-validates `BusinessContext` from the database before invoking a use case.
- Purging published messages and processed-message rows needs a later retention decision.
- **Build 1 creates none of these tables**, because Build 1 has no asynchronous side effects (no email, SMS or
  WhatsApp delivery). The first feature with an asynchronous effect implements this section.

## 11. Retries and concurrency

- **Serialization failures and deadlocks** (SQLSTATE `40001` and `40P01`, including the Prisma driver adapter's
  `TransactionWriteConflict`) are mapped by `packages/database` to one internal `TransactionConflict`. The unit of
  work may run the **whole** transaction callback up to **3 attempts in total** (the first attempt plus at most two
  retries), with jittered backoff. This is safe only because callbacks perform database work only (section 9). After
  the last attempt fails, the response is `409 CONCURRENT_MODIFICATION` (retryable).
- **Lock conflicts:** transactions set a bounded `lock_timeout` of up to 5 seconds. A timeout is not retried inside
  the unit of work and maps to `409 CONCURRENT_MODIFICATION`, or `409 IDEMPOTENCY_IN_PROGRESS` when the wait was on an
  idempotency key.
- **Deadline:** the attempt count and lock timeout are initial configurable defaults (section 13). They are always
  bounded by the overall request or operation deadline. No retry starts once that deadline would be exceeded.
- **Safe retry boundary:** retrying is safe only for the whole transaction, never part of it. Code after commit must
  not repeat effects.
- **Client retries:**
  - Keyed operations are retried only with the **same** `Idempotency-Key` and the same command.
  - A new key means a new intent.
  - State-setting and natural-key operations may be retried as they are.
  - Clients retry network errors, `503` and retryable `409` responses with exponential backoff and jitter. They do not
    retry other `4xx` responses.
- **New `ApplicationError` codes** (added with the first implementing slice):
  - `IDEMPOTENCY_KEY_REQUIRED` (400);
  - `IDEMPOTENCY_KEY_REUSED` (409): the same key was used with a materially different canonical command;
  - `IDEMPOTENCY_IN_PROGRESS` (409, retryable);
  - `CONCURRENT_MODIFICATION` (409, retryable).

  `422` is not used for key reuse. `50-api.mdc` allows `409` or `422`, and Tali uses `409` for every idempotency
  conflict. The full Build 1 error vocabulary is in ADR-005 section 13.

## 12. One-time secrets

Invitation tokens and device credentials (ADR-005) are returned in plaintext exactly once, in the response to the
request that created them.

- Plaintext is never stored anywhere: not in the resource table (only a hash is stored), not in the idempotency
  `result`, not in audit, outbox or logs.
- The stored idempotency `result` for such an operation contains the resource with `tokenAvailable: false` (or
  `credentialAvailable: false`). The first response is built separately and adds the plaintext with
  `tokenAvailable: true` (or `credentialAvailable: true`).
- **Lost response after commit.** Suppose a CreateInvitation or RegisterDevice transaction commits, but the client
  loses the response that contained the secret. Retrying with the same idempotency key does **not** reveal the
  secret again. The replay returns the existing resource with `tokenAvailable: false` (or
  `credentialAvailable: false`) and no secret.
- **Recovery flow:** revoke the affected invitation or device registration, then create a replacement (a new
  invitation, or a new device registration).
- Recoverable plaintext one-time secrets are **never** persisted, in any form, merely to make retries more
  convenient. This includes encrypted copies and short-lived caches.
- Responses that carry a one-time secret set `Cache-Control: no-store`.

## 13. What Build 1 implements and what is only defined

| Capability | Build 1 |
|---|---|
| Keyed idempotency, business and user scopes, canonical fingerprint v1 | Implemented |
| Natural-key and state-setting no-op semantics | Implemented |
| `business_audit_records`, `platform_audit_records`, `AuditWriter`, action registry and redaction tests | Implemented |
| Single-transaction boundary, serialization and deadlock retry, lock-timeout mapping | Implemented |
| One-time secret replay contract | Implemented (invitations and devices) |
| Idempotency purge job | Deferred (sync ADR / retention decision) |
| Persisted `IN_PROGRESS` with leases for external side effects | Defined in principle; designed with the first such feature |
| Recorded replays of deterministic rejections | Not adopted; revisited per feature if needed |
| Transactional outbox, relay and `processed_messages` | Protocol defined; implemented with the first asynchronous side effect |
| Offline command idempotency (command UUID as key) | Sync ADR, reusing the business scope |
| Audit viewer and support-access tooling | Deferred |

**Initial protocol values.** These are initial configurable protocol values for Build 1. They are not fixed for all
future Tali products. Future financial or payment operations may set stronger retention, timeout or retry
requirements through a later accepted decision.

| Value | Initial setting |
|---|---|
| Stored idempotency result size limit | 16 KiB |
| Audit payload size limit | 8 KiB |
| Audit `reason` length limit | 500 characters |
| Keyed-idempotency retention | at least 30 days for Build 1 |
| Attempts for serialization failures and deadlocks | up to 3 in total |
| `lock_timeout` | up to 5 seconds |

The attempt count and lock timeout are always bounded by the overall request or operation deadline (section 11).

## 14. Alternatives considered

- **`JSON.stringify` or a hash of the raw request body:** key order, whitespace, Unicode forms and default handling
  would make identical commands look different, and `bigint` cannot be serialized. Rejected (ADR-002 section 25).
- **RFC 8785 (JSON Canonicalization Scheme) over the command:** close to the chosen approach, but its number
  handling targets IEEE-754 doubles, and it does not define NFC normalization, default application or set semantics.
  The Tali encoder adopts JCS-style key ordering and adds those typed rules.
- **One idempotency table with nullable `business_id`:** the same tenant-shape objection as for audit (section 8.1).
  Rejected.
- **A separate committed `IN_PROGRESS` row before running the mutation:** needed only when effects happen outside the
  database. For pure database mutations it adds stale-row cleanup and leases for no benefit. Deferred to section 4.3.
- **Storing deterministic rejections for replay:** gives stable replies, but it needs a second transaction and can
  return stale rejections after the state has changed. Not adopted.
- **Auditing no-ops:** produces duplicate "business effect" records for one real change on every retry. Rejected in
  favor of the section 7 rule (log only).

## 15. Consequences

- Positive:
  - Every mutation has one declared idempotency mechanism, a deterministic fingerprint and atomic audit.
  - Retries cannot double-apply effects or duplicate audit records.
  - One-time secrets cannot leak through replay.
  - The tenant shape of audit and idempotency tables stays uniform.
- Negative / risks:
  - A lost first response for an invitation or device means the secret must be recreated.
  - Two audit and two idempotency tables must be kept in step.
  - The canonical encoder is security-relevant code and needs thorough tests.
- Impact:
  - **Financial integrity:** the same protocol applies to future financial mutations. Their extra requirements
    (reversals, ledger balance) are added by their own ADRs.
  - **Tenancy:** business scope always comes from the resolved context, and business tables keep a non-null
    `business_id`.
  - **Audit:** bounded and redacted, in the same transaction.
  - **Idempotency:** defined for online mutations now and offline sync later.
  - **AI safety:** no change. AI can only create proposals, which use this protocol when confirmed by a person.
  - **Security:** no secrets stored or replayed. Denials go to logs only.
- Rollout: implemented in Build 1 slices 1 to 3 (application ports and encoder, then tables, grants and
  `verify-schema.mjs` expectations in the same migration PR). Rollback before acceptance: amend this ADR. After
  acceptance: a superseding ADR.

## 16. Governance interactions

- `data-principles.md` section 13 says idempotency keys are "scoped by `business_id`". This ADR adds a user scope
  for mutations that run before a business exists. `data-principles.md` section 12 lists `business_id` as an audit
  field. This ADR keeps that for business events and adds a separate platform audit table. Sections 12 and 13 of
  `data-principles.md` were aligned with this ADR when it was accepted (2026-09-29).
- `50-api.mdc` requires `Idempotency-Key` for financial and inventory effects and allows natural dedupe keys. This ADR
  also applies keyed idempotency to non-financial creation endpoints. That is consistent with the rule and changes
  no rule.
- `10-database.mdc`: audit tables are insert-only for the application role, and mutation plus audit happen in one
  transaction.
- `70-security.mdc`: no secrets or tokens in stored results, audit or logs.
- ADR-002 sections 7, 11 and 25: this is the mutation-protocol ADR they defer to. It defines the audit, outbox and
  idempotency ports and states which parts Build 1 implements.
- This ADR changes no existing rule.

## 17. Human approval record

Accepted by the human maintainer on 2026-09-29. The following decisions were explicitly approved:

- separate business-scoped and user-scoped keyed-idempotency tables;
- the actor included in business-scope idempotency uniqueness;
- the canonical command fingerprint rules of section 5, including NFC applied to fingerprint canonicalization only
  (persisted values are normalized only where a field's contract says so);
- the status codes `400 IDEMPOTENCY_KEY_REQUIRED`, `409 IDEMPOTENCY_KEY_REUSED`, `409 IDEMPOTENCY_IN_PROGRESS` and
  `409 CONCURRENT_MODIFICATION`, with `422` not used;
- deterministic rejections are not persisted for replay;
- separate business and platform audit tables;
- the no-op semantics for state-setting mutations (section 7);
- the one-time-secret replay and recovery behavior (section 12);
- the transactional outbox protocol, defined but not implemented in Build 1 (section 10);
- the initial configurable protocol values (section 13);
- the retry and external-side-effect restrictions (sections 9 and 11).
