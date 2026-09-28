# ADR-002. Application foundation

- Status: ACCEPTED (2026-09-27)
- Date: 2026-09-27
- Amended: 2026-09-27, section 27 (implementation validation of the Prisma foundation spike; no decision changed)
- Deciders: Tali maintainers (human approval given 2026-09-27, subject to four clarifications incorporated before
  acceptance: local asynchronous development, UTF-8 enforcement, currency storage and rate precision, mobile
  compatibility spikes)
- Related: `docs/plans/001-foundation-plan.md` (approved in principle), `docs/decisions/ADR-001-aws-infrastructure.md`
  (accepted), `docs/architecture/architecture-principles.md`, `docs/architecture/data-principles.md`,
  `.cursor/rules/00-architecture.mdc`, `.cursor/rules/10-database.mdc`, `.cursor/rules/20-financial-integrity.mdc`,
  `.cursor/rules/30-multitenancy.mdc`, `.cursor/rules/50-api.mdc`, `.cursor/rules/60-testing.mdc`

## 1. Context

The repository contains governance only. Before any code is written, Tali needs one set of application-level
decisions: repository layout, runtime, frameworks, package boundaries, data access, money, identifiers, time,
validation, testing, configuration and local development.

Constraints already in force:
- one deployable backend/domain application (modular monolith) with a separate worker process from the same codebase;
- business logic only in application/domain services; clients hold no authoritative logic;
- providers behind ports; AWS SDK only in infrastructure adapters (ADR-001);
- PostgreSQL as the relational, ACID system of record (ADR-001);
- no floating-point money, one ISO 4217 currency per business, mixed currencies rejected;
- tenant scoping, audit and idempotency on every sensitive mutation;
- local development and automated tests must not require AWS; no LocalStack.

The foundation plan (`docs/plans/001-foundation-plan.md`) was approved in principle on 2026-09-27. This ADR proposes
the decisions from that plan that need formal acceptance before the scaffold starts. AWS topology is out of scope
(ADR-003).

## 2. Decision

Tali is built as one TypeScript monorepo:
- **Apps:** a NestJS API, a NestJS worker, a Next.js web app and an Expo (React Native) mobile app.
- **Backend core:** a framework-free domain layer and a shared application (use-case) layer. The API and worker are
  two composition roots over the same application layer. PostgreSQL persistence goes through conditionally approved
  Prisma inside `packages/database`, and AWS/vendor adapters live in `packages/integrations`.
- **Money:** `bigint` integer minor units.
- **Identifiers:** UUIDv7.
- **Boundaries:** enforced by workspace dependencies, package exports, dependency-cruiser and ESLint.

Sections 3 to 20 state each decision.

## 3. Monorepo structure

```
apps/
  api/            NestJS HTTP composition root (transport only)
  worker/         NestJS standalone composition root (async transport only)
  web/            Next.js web client
  mobile/         Expo / React Native client (Android first)
packages/
  domain/         pure domain; ./kernel is the client-safe subpath
  application/    shared use-case layer, authorization policies, ports
  database/       Prisma schema/migrations, PostgreSQL adapters
  integrations/   AWS, vendor and local adapters implementing ports
  shared/         wire contracts only (Zod schemas for HTTP/sync DTOs, error envelope)
  config/         validated configuration (./server, ./public)
  ai/             created at the AI milestone
  ui/             created only when a second consumer needs shared UI
tooling/
  typescript/     tsconfig presets
  eslint/         shared lint rules incl. restricted imports
infrastructure/
  cdk/            not created until ADR-001 and ADR-003 are accepted
```

Module folders (`modules/<module>/`) are mirrored in `domain`, `application` and `database`. Each module exposes its
public surface through `modules/<module>/index.ts`. The detailed tree is in the foundation plan, section 2.

## 4. Node.js / runtime strategy

- Node.js **24 LTS** for API, worker, tooling and CI, pinned in `.nvmrc` and the `engines` field.
- TypeScript in `strict` mode everywhere, plus `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch` and `verbatimModuleSyntax`. `exactOptionalPropertyTypes` is evaluated during the scaffold.
- The web runtime follows the Next.js-supported Node version. The mobile runtime follows the Expo SDK.
- Runtime upgrades are ordinary maintenance (no ADR) unless they change the major Node line or a framework.

## 5. pnpm / Turborepo

- **pnpm workspaces** with strict dependency resolution. A package can import only what it declares. The pnpm version
  is pinned via `packageManager` (corepack).
- **Turborepo** orchestrates `build`, `lint`, `typecheck`, `test` and `dev` with caching. The local and GitHub Actions
  cache comes first; a remote cache is optional later.
- Turborepo is not used as a boundary-enforcement mechanism (section 19).

## 6. Package boundaries

| Package | Responsibility | May depend on | Must not depend on | Authoritative logic |
|---------|----------------|---------------|--------------------|---------------------|
| `domain` | Entities, value objects, invariants, state machines, deterministic rules | nothing internal | NestJS, Prisma, AWS SDK, HTTP, queues, clocks/randomness | Yes (no I/O) |
| `application` | Use cases, authorization policies, unit of work, idempotency/audit/outbox calls, ports, query and proposal services | `domain` | NestJS, Prisma types, AWS SDK, HTTP, `shared`, `config` | Yes |
| `database` | Prisma, migrations, repository and infrastructure-port implementations | `application`, `domain` | `integrations`, apps, NestJS, AWS SDK, `shared` | No |
| `integrations` | Cognito/S3/SQS, future provider adapters, local/dev adapters | `application`, `domain` | `database`, apps, NestJS, Prisma | No |
| `shared` | HTTP/sync wire contracts only | Zod | all internal packages; no logic or utils | No |
| `config` | Config schemas and loaders (`./server`, `./public`) | Zod | internal packages | No |
| `ai` (later) | Prompts, extraction schemas, AI orchestration producing proposals | `application/queries`, `application/proposals`, `domain` | `database`, `integrations`, commit use cases | No |
| `ui` (later) | Design tokens and same-platform components | framework libraries | `application`, `database`, `integrations`, `config/server` | No |
| `apps/api` | HTTP transport, auth guard, context resolution, composition | `application`, `domain`, `database`, `integrations`, `config/server`, `shared`, `ai` | other apps | No |
| `apps/worker` | Async transport, handlers, composition | same as api (no HTTP controllers) | `apps/api`; calling the API over HTTP | No |
| `apps/web` | Web client | `shared`, `config/public`, `ui`, `domain/kernel` | `application`, `database`, `integrations`, `config/server`, `ai`, Prisma, AWS service SDKs | No |
| `apps/mobile` | Mobile client | same as web | same as web | No |

**Client-safe kernel.** Web and mobile may import only `@tali/domain/kernel`. It contains pure value objects (Money,
CurrencyCode, Quantity, identifiers, BusinessDate) and deterministic arithmetic, rounding, allocation and formatting
primitives. It must not expose authorization rules, posting logic, commit-capable state transitions or other
authoritative business operations, and it may not import from `domain/modules/**`. Client results are provisional;
the server recomputes and validates every authoritative effect.

**Client authentication library.** Clients may use a Cognito client sign-in library, isolated in `src/lib/auth`. They
never use AWS service SDKs and never hold AWS credentials.

**Shared package discipline.** `shared` holds wire contracts only. A shared export needs at least two consumers. Pure
business primitives belong in `domain/kernel`, not `shared`.

## 7. apps/api and apps/worker composition model

- `packages/application` is the single implementation of every use case. The API and worker **compose the same
  application services**, possibly with different adapters (for example HTTP-driven versus queue-driven entry, or
  different queue adapters).
- `apps/api` handles authentication, `BusinessContext` resolution, input validation with `shared` schemas, mapping to
  application commands, invoking one use case, and mapping results and errors.
- `apps/worker` handles queue and job intake, rebuilds `BusinessContext` from the database (re-validating the business,
  and the membership for user-initiated work), invokes the same use cases, and dedupes deliveries.
- The worker never calls the API over HTTP and never imports `apps/api`. Worker handlers may not import
  `packages/database`; only the worker's composition root wires adapters.
- **Location-bound use cases.** The generic `BusinessContext` may carry an optional `locationId`. Location-bound use
  cases (sales, inventory, receiving, cash sessions and cash close) require a resolved, non-null location. Default-
  location resolution happens before the use case is invoked.
- **Permissions.** The foundation provides a skeletal permission model: permission type, catalogue mechanism and
  evaluation. No feature permissions are predefined before their use cases exist.
- **Worker scaffold.** The foundation worker is a composition/config/queue smoke shell only. The transactional outbox,
  processed-message and idempotency tables are created only after the mutation-protocol ADR.
- **Separate processes.** `apps/api` and `apps/worker` always run as separate processes, locally and when deployed. An
  in-memory/in-process `QueueProvider` is suitable only for unit tests, port contract tests and worker smoke testing
  within one process. It is **not** a cross-process channel between the local API and the local worker.
- **Local asynchronous path** (once the mutation/outbox implementation exists; not implemented now):
  API/application mutation -> PostgreSQL transactional outbox (same transaction) -> local worker polls and claims
  outbox rows -> worker invokes the appropriate application handler/use case. No SQS or LocalStack is required
  locally. SQS remains the deployed asynchronous transport per ADR-001 and ADR-003.

## 8. NestJS

- NestJS is the framework for `apps/api` (HTTP) and `apps/worker` (standalone application context, no HTTP server).
- NestJS is confined to the two apps. Application services are plain TypeScript classes wired with factory providers,
  and no NestJS decorators appear in `domain`, `application`, `database` or `integrations`.
- Rationale: mature dependency injection and module system, guards and filters for the thin-transport pattern, and
  first-class TypeScript support.

## 9. Next.js

- Next.js (App Router) for `apps/web`: merchant configuration, imports, reconciliation, reporting and admin review.
- Next.js server features (server components, route handlers, server actions) may only render or proxy API data. They
  must never hold business rules, database access or server secrets beyond what the web deployment needs, so the web
  app cannot become a second backend.
- Hosting is decided in ADR-003 (AWS Amplify Hosting is the preferred candidate per ADR-001).

## 10. Expo

- Expo with React Native and Expo Router for `apps/mobile`, Android first; iOS later from the same codebase.
- Offline storage (SQLite) and sync are designed in the future sync ADR and are not part of the foundation.
- Monorepo compatibility (Metro resolution under pnpm) is verified during the scaffold. If required, a documented pnpm
  configuration change (e.g. hoisting for the mobile app) is an implementation detail, not an ADR matter.
- **Mobile compatibility acceptance checks** (foundation scaffold):
  1. `bigint` arithmetic used by the client-safe Money kernel (construction, addition, subtraction, multiplication,
     comparison, rounding, allocation, string parsing and formatting) runs correctly in the selected Expo/Hermes
     environment, verified by tests executing on that engine, not only in Node.js;
  2. the selected UUIDv7 implementation works correctly in Node.js, Next.js/browser and Expo/React Native (section 14).
  If a check fails, the failure is resolved (for example a different engine setting or library) before Build 1.

## 11. Framework-free domain/application layers

- `packages/domain` and `packages/application` import no framework, ORM, cloud SDK, HTTP or queue library.
- Time and identifiers are injected (`Clock`, `IdGenerator` ports), so domain logic stays deterministic and testable.
- Ports are declared in `application` (cross-cutting in `ports/`, module-specific in `modules/<module>/ports/`) using
  Tali vocabulary. Initial infrastructure ports are `IdentityProvider`, `ObjectStorageProvider`, `QueueProvider`,
  `Clock`, `IdGenerator` and `UnitOfWork`. Audit, outbox and idempotency ports are defined with the mutation-protocol ADR.
- Future provider ports: `PaymentProvider`, `BankingProvider`, `MessagingProvider`, `SpeechProvider`,
  `DocumentProvider`, `AIProvider`.
- In-memory fakes of ports live in `application` under the `./testing` subpath, importable only by tests and local
  composition.

## 12. Prisma: conditional approval and spike criteria

**Decision:** Prisma is approved **conditionally** as the data-access layer, under these conditions:
- Prisma is used only in `packages/database`.
- Repository adapters map rows to domain/application types.
- Raw SQL is used only as parameterized tagged templates (`$queryRaw`) inside `packages/database`; `$queryRawUnsafe` is
  banned.
- Constraints, grants and other features Prisma cannot express are written as SQL in the same migration.
- Protected (financial, audit, append-only) models have `delete`/`deleteMany` banned by lint, and DELETE/UPDATE are
  revoked at the database level for the application role.

**Spike criteria.** The foundation database spike (scaffold) must prove all of:
1. interactive transactions (multi-statement, rollback on error, configurable isolation level);
2. row locking with `SELECT ... FOR UPDATE` inside an interactive transaction;
3. `FOR UPDATE SKIP LOCKED` batch claiming with concurrent workers;
4. `BigInt` round trip between PostgreSQL `BIGINT` and TypeScript `bigint` without precision loss or `number` coercion;
5. custom SQL migrations (CHECK constraints, partial unique indexes, GRANT/REVOKE) applied by `migrate deploy` without
   drift errors;
6. multi-file schema organized per module;
7. repository mapping with no Prisma types escaping `packages/database`, verified by dependency-cruiser and checks on
   exported signatures.

If any criterion fails materially, Kysely or Drizzle may be reconsidered **before Build 1**. The outcome is recorded as
an amendment to this ADR (if still proposed) or a superseding ADR (if accepted).

**Migration workflow:**
- Locally, `prisma migrate dev` generates SQL, which is reviewed and extended with custom SQL.
- Migrations are forward-only and never edited after reaching a shared environment.
- CI applies all migrations to an empty database and checks for drift.
- Deployed environments run `prisma migrate deploy` with a migration role separate from the application role
  (execution mechanism in ADR-003).
- `db push` and `migrate reset` are never used outside local.

## 13. Money representation

- Authoritative monetary amounts are **integer minor units**: `bigint` in TypeScript, `BIGINT` in PostgreSQL, always
  paired with an ISO 4217 currency code stored as `VARCHAR(3)`. When that schema is implemented, the code is
  constrained or validated against the approved currency reference data (e.g. a foreign key to the currency table).
- The domain `Money { amountMinor: bigint; currency: CurrencyCode }` lives in `domain/kernel`.
- The minor-unit exponent comes from global, read-only currency reference data, never a hard-coded `100`. NGN appears
  only as pilot configuration or seed data.
- Operations across different currencies are rejected; there is no FX conversion (post-MVP).
- Integer basis points are used for current simple percentage calculations (e.g. simple discounts and configurable
  tax rates) where their precision is sufficient. Basis points are **not** the universal rate representation: future
  lending, interest, APR or other advanced financial products may introduce a separately approved higher-precision
  `Rate` type. Rounding uses explicit named modes (e.g. `HALF_EVEN`, `HALF_UP`) chosen at the call site. Allocation distributes remainders (largest remainder), so parts always sum to the whole.
- **Wire format:** `{ "amountMinor": "125050", "currency": "NGN" }`, with the amount as a base-10 integer string. Money
  is never a JSON number, which avoids precision loss and `bigint` serialization issues. This is the interpretation of
  `50-api.mdc` ("integer minor units or a decimal string") adopted by this ADR.
- **Alternative rejected:** PostgreSQL `NUMERIC` with Prisma `Decimal` for authoritative amounts (see section 22).
- **Exception path:** if the inventory valuation ADR needs sub-minor precision for derived unit costs, exact
  fixed-scale `NUMERIC` may be approved there for those values only (allowed by `10-database.mdc` via ADR).
- No tax logic is decided here.

## 14. UUID strategy

- Every record's identity is an immutable **UUIDv7**, generated by the server or, for offline capture, by the device.
- UUIDv7 is time-ordered, which makes it index-friendly for PostgreSQL B-trees and helps with insert locality and
  approximate ordering. Timestamps embedded in IDs are never used as business time or for authorization.
- IDs are stored as PostgreSQL `uuid` and generated through the `IdGenerator` port (deterministic in tests).
- The UUIDv7 implementation (library or platform API) is selected during the scaffold spike, not in governance. It
  must pass acceptance checks in Node.js, Next.js/browser and Expo/React Native: correct version and variant bits,
  monotonic time ordering, uniqueness under bulk generation, and random bits from a cryptographically secure source
  (e.g. Web Crypto `getRandomValues`, Node `crypto`, or the Expo crypto module). UUID generation must never fall back
  to insecure randomness such as `Math.random`. If no secure source is available, generation fails loudly.
- Human document numbers (e.g. receipts) are separate display columns and never primary keys. The offline receipt
  format is decided in the sync ADR.

## 15. Time model

- All instants are `timestamptz` in UTC. The server clock (the `Clock` port) is the only clock used for security and
  authorization decisions.
- Each business has an IANA time zone (configuration). Changing it is audited and never recomputes existing business
  dates.
- `occurred_at` is when the business event happened, as recorded: server receipt time online; device-reported time
  (evidence) offline. Plausibility handling is a sync-ADR policy.
- `device_reported_at` is the raw device clock claim. It is evidence only and never drives authorization.
- `received_at` is when the server first received an offline command.
- `recorded_at` is when Tali durably recorded or posted the record.
- `business_date` is the `DATE` in the business time zone for the occurrence. For offline commands it is computed with
  the business's synced time zone (not the device zone), validated server-side, and immutable once posted.
- Late synchronization keeps `occurred_at` and `business_date` and never rewrites them into the current day. How late
  records interact with daily close and accounting periods is decided later (open decision 8; accounting ADR).

## 16. Validation strategy

- **Zod** validates all external input at the transport boundary (HTTP, webhooks, queue messages, files metadata,
  configuration, AI output) using `shared` contract schemas.
- Mutation endpoints reject unknown fields and enforce sizes and bounds.
- Use cases validate command invariants again (defense in depth). Domain constructors enforce value-object invariants.
- Validation schemas never carry business decisions. They check shape and bounds; rules live in domain/application.

## 17. Testing tools

- **Vitest** for domain, application, database and integration packages, API integration tests (with SWC for NestJS
  decorator metadata) and web component tests with React Testing Library.
- **Jest** (`jest-expo`) with React Native Testing Library for mobile, because of React Native ecosystem support.
- **Supertest** for API HTTP integration tests against a real PostgreSQL (Docker locally, a service container in CI).
- **Playwright** for web end-to-end tests.
- If Vitest with NestJS proves impractical during the scaffold, API tests may use Jest. This is recorded as an
  implementation note and does not need a new ADR.
- The mobile end-to-end tool is deferred until offline sync.
- No automated test requires AWS credentials. Ports use fakes or local adapters, and port contract test suites run
  against them.

## 18. Configuration approach

- `TALI_ENV` = `local | test | development | staging | production`.
- `@tali/config/server` holds Zod-validated, fail-fast configuration for the API and worker: database, identity,
  object storage, queue, API, observability and future providers.
- `@tali/config/public` holds web (`NEXT_PUBLIC_*`) and mobile (`EXPO_PUBLIC_*`) public configuration.
- Server-only secrets never appear in public schemas. Clients cannot import `./server` (enforced by boundaries), and CI
  checks client bundles for server variable names.
- Forbidden combinations are rejected at startup (e.g. `production` with a local/fake identity adapter or in-memory
  storage).
- Local development uses gitignored `.env` files, with `.env.example` committed using placeholders only. Deployed
  environments use Secrets Manager (injection mechanism in ADR-003).

## 19. Dependency enforcement

Four layers:
1. pnpm strict workspace dependencies (undeclared imports fail);
2. `package.json` `exports` (limits reachable subpaths, e.g. `domain/kernel`, `application/testing`);
3. **dependency-cruiser** in CI, the single source of truth for package direction, module public-surface rules,
   worker-handler and controller restrictions, and `no-circular`;
4. ESLint restricted imports for fast feedback: `@aws-sdk/*` only in `integrations`, `@prisma/client` only in
   `database`, `@nestjs/*` only in apps, bans on `$queryRawUnsafe` and on `delete`/`deleteMany` for protected models.

Boundary rules are written before package code exists and are enforced from the first CI run.

**Repository text integrity.** The scaffold includes a CI text-integrity check that verifies repository text files are
UTF-8 according to governance (`AGENTS.md` section 6). At minimum it detects and rejects UTF-16 text (including
UTF-16 byte-order marks), a UTF-8 BOM where governance prohibits it, and null bytes in ordinary text files. Binary
assets are excluded by an explicit list. `.gitattributes` handles line endings only and is not treated as encoding
enforcement.

## 20. Local development

- Prerequisites: Node.js 24 LTS, pnpm (corepack), Docker, and an Android emulator or device for Expo.
- PostgreSQL runs in Docker (`docker-compose.yml`, PostgreSQL only), with separate local and test databases.
- Locally, the NestJS API, NestJS worker (a separate process), Next.js web and Expo mobile app all run against local
  adapters:
  - local identity (dev-only JWT issuer and sign-in endpoint, active only when `TALI_ENV=local`);
  - local filesystem object storage with short-lived HMAC-signed URLs;
  - asynchronous work between API and worker via the PostgreSQL transactional outbox, polled and claimed by the local
    worker, once the mutation-protocol implementation exists (section 7). The in-memory queue is only for tests and
    single-process worker smoke tests.
- No AWS account, credentials or network calls are needed for development or tests.
- LocalStack is not used.
- Seeds are synthetic only.

## 21. RLS posture

- Application authorization and `business_id` scoping remain mandatory (`30-multitenancy.mdc`).
- PostgreSQL Row-Level Security is **not enabled in the foundation**. The schema is RLS-ready:
  - `business_id` on every tenant-owned table;
  - composite `(business_id, id)` keys and composite foreign keys to block cross-tenant references;
  - a non-owner application role without `BYPASSRLS`.
- RLS may be added later as defense in depth for high-risk tables after a spike covering Prisma transaction-scoped
  settings, pooling behavior and the cross-tenant worker relay. That decision will be recorded when made.

## 22. Known tradeoffs

- **Framework-free application layer:** more wiring boilerplate in NestJS (factory providers) in exchange for sharing
  use cases between the API and worker and keeping the core portable and testable.
- **Module ownership spans three packages** (`domain`, `application`, `database`): cohesion relies on mirrored folders
  and dependency-cruiser module rules rather than a single package per module.
- **Prisma:** strong types and migrations, but constraints, locks and RLS settings need raw SQL. Interactive
  transactions hold connections, and `delete` APIs need guarding. Mitigated by the conditions and spike.
- **`bigint` money:** exact and simple, but `bigint` is not JSON-serializable. The string wire format requires client
  discipline (never convert money to `number`).
- **UUIDv7:** embeds creation time (low sensitivity), accepted for index locality.
- **Two test runners** (Vitest and Jest for mobile).
- **Expo/Metro in a pnpm monorepo** may need resolution configuration.
- **Node 24:** compatibility with every tool must be verified during the scaffold.

## 23. Alternatives considered

- **Nx instead of Turborepo:** richer generators and built-in boundary rules, but heavier and more opinionated. Not
  chosen; dependency-cruiser provides boundaries.
- **npm or Yarn workspaces:** pnpm's strict resolution directly supports boundary enforcement. Not chosen.
- **Express or Fastify without NestJS:** lighter, but dependency injection, guards and module structure would be
  hand-built. Not chosen.
- **Application services inside `apps/api`, with the worker as a second entry point of the api app:** simpler wiring,
  but couples worker and HTTP app packaging and invites importing app internals. Not chosen, in favor of
  `packages/application`.
- **A generic `packages/backend`:** rejected in planning as a catch-all that blurs domain, application and
  infrastructure.
- **Kysely or Drizzle instead of Prisma:** closer to SQL, with easier locks and constraints and lighter runtimes, but
  weaker migration tooling (Kysely) or a younger ecosystem (Drizzle). They remain the fallback if the Prisma spike fails.
- **TypeORM or MikroORM:** decorator-heavy entities risk leaking ORM concerns into the domain. Not chosen.
- **`NUMERIC`/`Decimal` for authoritative money:** exact, but introduces object types across layers, scale mismatches
  and serialization friction, and diverges from the governance default of minor units. Not chosen.
- **UUIDv4:** random, with poorer index locality. **ULID:** similar ordering benefits but no native PostgreSQL type
  convention. Neither chosen.
- **Yup, Valibot or class-validator:** Zod has the broadest TypeScript ecosystem and is shareable between clients and
  server. Not chosen.
- **Jest everywhere:** viable. Vitest is faster and closer to ESM for non-React-Native code.
- **LocalStack for local AWS parity:** excluded by ADR-001 unless a concrete requirement appears.

## 24. Consequences

- Positive:
  - One place for every use case (`packages/application`), reused by the API and worker; clients structurally cannot
    reach authoritative code.
  - Boundaries are machine-checked from the first commit.
  - Money, identity and time semantics are fixed before any financial table exists.
  - Development and tests run fully offline from AWS.
- Negative / risks:
  - More packages and wiring than a single app.
  - Prisma risk is carried until the spike completes.
  - Tooling compatibility (Node 24, Expo/pnpm, Vitest/NestJS) must be verified during the scaffold.
- Impact on financial integrity, tenancy, audit, idempotency, AI safety and security:
  - Financial integrity: integer minor-unit money, a unit of work around every mutation, DB-level revocation of
    DELETE/UPDATE on protected tables.
  - Tenancy: composite tenant keys, a server-resolved `BusinessContext`, resolved non-null locations for
    location-bound use cases.
  - Audit and idempotency: implemented after the mutation-protocol ADR. The worker scaffold creates no such tables.
  - AI safety: the `ai` package can reach only query and proposal services.
  - Security: server/public configuration split, no AWS credentials in clients or tests.
- Rollout: after acceptance, the scaffold follows `docs/plans/001-foundation-plan.md` section 28. No business features,
  AWS adapters against real AWS, CDK or deployments are part of it.
- Rollback: before Build 1, any decision here may be amended while proposed, or superseded after acceptance.

## 25. Deferred decisions

- **ADR-003 (AWS foundation topology):** region, accounts, network, RDS, ECS, Cognito configuration and sign-in UX,
  S3 upload architecture (direct-to-S3 signed URLs versus upload through the API), SQS configuration, scheduler,
  KMS, observability, CI/CD deployment, web hosting, backup/RPO/RTO, cost controls.
- **Mutation-protocol ADR** (before the first mutating use case):
  - idempotency records and scopes;
  - **canonical command serialization and fingerprinting**: key ordering, Unicode normalization,
    `bigint`/decimal-string representation, date formats, absent vs `null` vs default, array ordering and schema
    version. `JSON.stringify` is not assumed sufficient;
  - replay and mismatch responses (including the API status code for key reuse with a different payload);
  - audit record schema, with bounded, purpose-specific, redacted before/after payloads and no automatic entity
    serialization, secrets, tokens, raw media or unnecessary sensitive attributes;
  - transactional outbox, processed-message tables and relay.
- **Authorization model:** roles, feature permissions (added with their use cases), offline permission attributes.
- **Sync ADR:**
  - SQLite library and encryption, command envelope, device binding, receipt numbering, plausibility rules;
  - evaluation of configuration/catalog context on offline commands (e.g. `catalogVersion`, `pricingVersion`,
    `businessConfigVersion`), not implemented in the foundation;
  - dependencies on open decisions 1, 2, 3, 4, 8, 9 and 15.
- **Provider ADRs:** event deduplication uses provider-issued stable event/transaction identifiers by preference. A
  content hash is only a provider-specific fallback after explicit review, never a universal rule.
- **Other feature ADRs:** ledger and chart of accounts (before sales); inventory valuation, including any sub-minor
  unit-cost precision (before restock with cost).
- **Implementation-level choices (no ADR needed):** mobile end-to-end tool, PostgreSQL schemas per module (optional),
  exact lint rule set, remote build cache.
- **RLS enablement** (section 21).

## 26. Compliance with governance rules

- `00-architecture.mdc`: one backend/domain application (API and worker share `packages/application`); no business
  logic in controllers, handlers or UI; vendor SDKs only in adapters; TypeScript strict.
- `10-database.mdc`: PostgreSQL; `BIGINT` money with currency; append-only protections via lint and DB grants;
  forward-only migrations; UUID identities.
- `20-financial-integrity.mdc`: integer minor units, explicit rounding and allocation, mixed currencies rejected,
  no hardcoded currency.
- `30-multitenancy.mdc`: server-resolved `BusinessContext`, composite tenant keys, RLS only as defense in depth.
- `50-api.mdc`: Zod validation, string money wire format, idempotency protocol deferred to its ADR.
- `60-testing.mdc`: four test levels, tests without AWS or real credentials.
- `70-security.mdc`: server/public config split, no secrets in source, no AWS credentials in clients.
- ADR-001: AWS SDK only in `packages/integrations`; local development without AWS; no LocalStack; no provisioning.
- This ADR changes no existing rule.

## 27. Amendment: implementation validation of the Prisma foundation spike (2026-09-27)

This amendment records the outcome that section 12 requires. It records evidence only: it changes no decision in
this ADR and relaxes no rule, so no superseding ADR is needed. It was added at the maintainers' direction during the
Wave B closeout.

**Outcome: GO.** The Wave B Prisma foundation spike completed with a GO result. Evidence, versions and test details are
in `docs/audits/prisma-foundation-spike.md`. Kysely and Drizzle were not evaluated because no criterion failed
materially.

| Section 12 criterion | Spike criterion | Result |
| --- | --- | --- |
| 1. Interactive transactions | A | PASS WITH LIMITATION |
| 2. `SELECT ... FOR UPDATE` | B | PASS WITH LIMITATION |
| 3. `FOR UPDATE SKIP LOCKED` batch claiming | C | PASS WITH LIMITATION |
| 4. `BIGINT` <-> `bigint` | D | PASS |
| 5. Custom SQL migrations via `migrate deploy` | E | PASS WITH LIMITATION |
| 6. Multi-file schema | F | PASS |
| 7. Type containment | G | PASS |

**Material limitation (E).** Prisma's own drift representation does not fully represent certain custom SQL
constructs, including CHECK constraints, partial indexes and grants. In the spike, Prisma's migration and drift
checks (`migrate status`, `migrate diff --exit-code`) applied such migrations without error, but reported no
difference after a CHECK constraint or partial index was dropped manually, and they do not compare grants at all.
Prisma therefore does **not** validate these constructs natively.

The accepted mitigation is explicit database verification with `packages/database/scripts/verify-schema.mjs`,
in addition to Prisma's migration and drift checks. It runs after `migrate deploy` in CI and checks the PostgreSQL
catalog directly for:

- applied versus committed migrations;
- each expected CHECK constraint and partial unique index;
- the application role's exact table privileges, attributes, ownership, `CREATE` rights and default privileges;
- destructive statements in committed migrations.

Every future custom SQL object must be added to its expectations in the same change as the migration that creates it.

**Other limitations (A, B, C).** These are accepted as documented in the audit:

- Row-locking and `SKIP LOCKED` queries use parameterized `$queryRaw` inside `packages/database`, as section 12
  permits.
- A serialization failure surfaces as the driver adapter error `TransactionWriteConflict` rather than a SQLSTATE,
  and must be mapped when a retry policy is introduced.
- Interactive transactions hold a pooled connection and are bounded by configured timeouts.

**Status of the conditional acceptance.** The conditional acceptance of Prisma in section 12 is now satisfied for
the foundation. This is subject to:

- the limitations documented above and in the audit;
- continued verification. The criteria stay under regression test in CI (`packages/database/test/integration`).
  `verify-schema.mjs` and the drift checks run on every change. A Prisma major-version upgrade requires the spike
  criteria to be re-run before adoption.

All other section 12 conditions remain in force.

**Spike cleanup.** The temporary `foundation_spike` PostgreSQL schema was removed by the forward migration
`20260928025500_remove_foundation_spike`, which records the maintainers' explicit approval. The original spike
migration was not edited. The criteria's regression tests now run against test-only fixture tables that the
integration-test setup creates in the disposable test database. These tables are not part of the migration chain.
Because no Prisma model exists yet, Prisma's generated model API for `BigInt` fields is not currently exercised. The
first repository built on a real model must cover it again.
