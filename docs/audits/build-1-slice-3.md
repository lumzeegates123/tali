# Build 1 Slice 3: API authentication, tenancy context and P0 endpoints

- Date: 2026-09-29
- Scope: Slice 3 of `docs/plans/003-build-1-identity-tenancy.md`, under ADR-002, ADR-004, ADR-005 and ADR-006 (all
  ACCEPTED). The Slice 1 use cases and Slice 2 PostgreSQL adapters are connected to the NestJS API: request
  authentication and context resolution, the P0 endpoints with strict wire contracts, `LocalIdentityProvider` and
  local sign-in, the real `FingerprintHasher`, the default-location resolver, and end-to-end security tests on real
  PostgreSQL.
- Not in this slice: P1 endpoints (business rename, invitations, membership changes, devices, extra locations, user
  disable, currency or time-zone changes), web and mobile flows (Slice 4), devices (Slice 5), Cognito, AWS SDKs and
  CDK (Slice 6, blocked on ADR-003), RLS.

## Summary

| Area | Result |
| --- | --- |
| P0 endpoints with strict Zod contracts in `@tali/shared` | PASS |
| Authentication guard, registered-user guard, business-context guard | PASS |
| Existence hiding (ADR-005): unknown, foreign, suspended, malformed business IDs | PASS, one identical 404 body |
| `member:read` matrix (OWNER, MANAGER allowed; CASHIER, STOCK_KEEPER, ACCOUNTANT denied) | PASS |
| Registration: natural idempotency, USER_NOT_REGISTERED, USER_DISABLED | PASS |
| CreateBusiness on PostgreSQL: Idempotency-Key, replay, 409 reuse, audit, idempotency record | PASS |
| `LocalIdentityProvider` (jose, ES256, ephemeral key) and `POST /__local/sign-in` | PASS |
| Non-local safety (route not mounted; local and fake providers refused by config and by composition) | PASS |
| `Sha256FingerprintHasher` and framing v1 against hard-coded vectors | PASS |
| Correlation ID in responses, audit records and logs; `sourceChannel` server-side | PASS |
| Log redaction and error serialization (no tokens, subjects, names or error messages in logs) | PASS |
| Boundaries (ESLint and dependency-cruiser), kernel surface test | PASS |
| `pnpm verify`, `pnpm test:integration`, schema checks, web smoke, bundle scan, gitleaks | PASS (see Verification) |

No material conflict with an accepted ADR was found. No new public error code was introduced.

## Dependency

| Package | Version | Where | Reason |
| --- | --- | --- | --- |
| `jose` | 6.2.12 (exact) | `packages/integrations` only | JWT signing and verification for `LocalIdentityProvider`, as the plan and `70-security.mdc` require a vetted library. MIT, zero dependencies. Integrity `sha512-9NiFmJEex0sy2Dk58j2UGBSHgUs2ypF9eZSu4L6vjOX3Dp96Sw1F3uL+H+D1sx02jZZdzUT0HgvCy59CuvXcWw==`. |

`jose` is the only package added to the lockfile. `uuid` 14.0.2 (the UUIDv7 implementation selected by the
cross-runtime spike) was already locked and is now also declared by `packages/integrations`. No version of Node,
pnpm, Turborepo, Prisma, PostgreSQL, NestJS, Next.js, Expo, Vitest or any other dependency changed. ESLint and
dependency-cruiser now forbid `jose` outside `packages/integrations`.

## Endpoints

| Method and path | Guards | Success | Notes |
| --- | --- | --- | --- |
| `POST /v1/me/registration` | Authentication | 201 new, 200 existing | Body `{ displayName }` only. No Idempotency-Key; the identity's unique key makes it idempotent, and a repeat writes nothing. |
| `GET /v1/me` | Authentication, RegisteredUser | 200 | `{ id, displayName }` |
| `POST /v1/businesses` | Authentication, RegisteredUser | 201 (replay 201 with `Idempotent-Replayed: true`) | Requires `Idempotency-Key` (RFC 9562 UUID). Body `{ name, currencyCode, timeZone }`. |
| `GET /v1/me/businesses` | Authentication, RegisteredUser | 200 | Keyset page `{ items: [{ business, membership: { id, role } }], nextCursor }` |
| `GET /v1/businesses/:businessId` | Authentication, BusinessContext | 200 | `business:read` (every role) |
| `GET /v1/businesses/:businessId/locations` | Authentication, BusinessContext | 200 | `location:read` (every role), keyset page |
| `GET /v1/businesses/:businessId/members` | Authentication, BusinessContext | 200 | `member:read` (OWNER, MANAGER), keyset page `{ id, displayName, role, status }` |
| `POST /__local/sign-in` | none; mounted only when `TALI_ENV=local` and the local provider is composed | 200 | Body `{ subject }`; returns `{ accessToken, tokenType: "Bearer", expiresAt }` with `Cache-Control: no-store`. |

### Business-route guard enforcement

Every route under `/v1/businesses/:businessId` lives in one controller, `BusinessScopedController`
(`apps/api/src/business/business-scoped.controller.ts`, path `BUSINESS_SCOPED_PATH`). Its guards are declared once
at class level: `@UseGuards(AuthenticationGuard, BusinessContextGuard)`. Class guards run before method guards,
so the order is always authentication, then business context, then the handler. `BusinessesController` keeps only
`POST /v1/businesses`, with `AuthenticationGuard, RegisteredUserGuard` at class level. The guards themselves and
the NOT_FOUND hiding are unchanged; no authorization logic or data access moved into controllers.

`apps/api/test/compat/business-route-guards.test.ts` (unit suite) makes this permanent. It boots the real
`AppModule` for the `test` and `local` compositions. It needs no database; the connection is lazy and never opened.
It takes the route inventory from Nest metadata: every controller in `ModulesContainer`, with `PATH_METADATA`,
`METHOD_METADATA` and `GUARDS_METADATA` (class guards then method guards). The helpers are in
`apps/api/test/support/route-inventory.ts`. The test then asserts the following:

- The metadata inventory equals the routes Express actually serves (the Express 5 router stack), so no route
  escapes the check.
- Every route with a `:businessId` parameter lives under the business prefix.
- Every route under the prefix has exactly `[AuthenticationGuard, BusinessContextGuard]`, in that order.
- `BusinessContextGuard` appears nowhere else.
- `AuthenticationGuard` is the first guard on every guarded route.
- A self-test mounts deliberately rogue controllers next to the real application and expects each violation to be
  reported: an unguarded business route, reversed guard order, a user-only guard, and a business guard outside the
  prefix.

Removing the class-level guard from `BusinessScopedController` makes the test fail and name every affected route
(checked, then restored). The integration suite adds a behavioural sweep in `tenancy-authorization`. For every
business route in the metadata inventory, it expects 401 without a token and 404 `NOT_FOUND` for a foreign,
unknown or malformed business ID. It also expects success for the member.

Lists take `limit` (1 to 100, digits only) and `after` (opaque cursor, 1 to 256 characters); any other query
parameter is VALIDATION_FAILED. Every request and response schema is a strict object with maximum lengths. Responses
never contain provider subjects, fingerprints, membership versions, audit data, database fields or actor metadata;
the tests assert this on every endpoint.

## Request pipeline

1. Correlation middleware: a well-formed `x-correlation-id` is kept, otherwise a UUID is generated; it is echoed on
   every response (errors included), stored on the request, and stamped on every log line.
2. CORS, then `express.json` (strict, 16 KiB). Body-parser failures go to a pre-routing handler that uses the same
   central mapping: malformed JSON is VALIDATION_FAILED, an oversized body 413, an unsupported encoding 415. None of
   the body is quoted back.
3. `AuthenticationGuard`: `Authorization: Bearer <token>` (bounded character set, at most 4096 characters), verified
   through the `IdentityProvider` port. Missing, malformed, badly signed, expired, revoked or unverifiable tokens are
   all UNAUTHENTICATED with one message. The log event `auth.token_rejected` carries a reason (`missing_token`,
   `malformed_authorization` or `verification_failed`) and nothing else. Only `AuthenticationError` from the adapter
   becomes 401; any other failure keeps its own mapping (for example 500 or 503).
4. `RegisteredUserGuard` (user-level routes) resolves the `AuthenticatedUserContext` from the database:
   USER_NOT_REGISTERED or USER_DISABLED otherwise.
5. `BusinessContextGuard` (business routes) resolves the user as above, then the `BusinessContext` for the route's
   `:businessId` (ADR-005 section 12): an ACTIVE membership of an ACTIVE business, with permissions from Tali's role
   mapping. A malformed, unknown, foreign or SUSPENDED business, or a SUSPENDED membership, is NOT_FOUND with the same
   body, and this check runs before any query or body validation, so validation never reveals existence. Denials are
   logged as `context.denied` with a reason (`user_not_registered`, `user_disabled` or `business_not_accessible`) and
   the user ID only.
6. The controller validates the remaining request parts with the shared schemas, maps DTO to command, calls one use
   case and maps the result through a strict response schema. Controllers never construct contexts, never import
   `@tali/database` or `@tali/integrations` (lint and dependency-cruiser enforce this), and hold no business logic.

Contexts carry `sourceChannel = "api"` (set by the server) and the request's correlation ID, which reach every audit
record. Client headers such as `x-source-channel`, `x-business-id`, `x-user-id`, `x-location-id` and device headers are
ignored; tests prove each grants nothing. `deviceId` is never set: device verification is step 8 of the resolution
order and arrives with the device workflow in Slice 5, as documented in `business-context.guard.ts`. There is no
"current business": the business always comes from the route.

## Default-location resolver

`createDefaultLocationResolver({ unitOfWork, locations }).resolveDefaultLocation(ctx)` returns a `LocationBoundContext`
for the ACTIVE default location of `ctx.businessId`, read from the database (`findActiveDefault`, scoped by business
ID). A `locationId` already on the context is replaced, never trusted. A business without an ACTIVE default location
breaks a Slice 2 invariant (CHECK constraint and partial unique index), so the resolver throws
`DefaultLocationMissingError`, a plain error that surfaces as 500 INTERNAL_ERROR; no public error code was needed. It
has no endpoint and no Slice 3 use case calls it yet. Tests cover the in-memory store and real PostgreSQL (including
an archived default and a foreign business).

## LocalIdentityProvider and local sign-in

- `packages/integrations/src/local/local-identity-provider.ts`: `LocalIdentityProvider.create({ clock })` generates
  a non-extractable ES256 key pair with `jose` at process start. The key is never exported, persisted or loaded;
  ESLint and dependency-cruiser forbid any filesystem import in `src/local`.
- Tokens: header `alg ES256`, `typ at+jwt`; claims `iss tali-local`, `aud tali-api-local`, `sub`, `iat`, `exp = iat +
  3600`, `auth_time`. No roles, businesses or other claims; no refresh tokens or sessions.
- Verification: `jwtVerify` with the fixed algorithm, type, issuer, audience, `currentDate` from the clock, maximum
  age 3600 seconds and required claims, then integer claims, the subject pattern, `auth_time <= iat` and
  `exp - iat = 3600`. Every failure (tampered, expired, future, malformed, unsigned, `HS256`, another instance's key)
  becomes `AuthenticationError` without a cause. The verified identity is exactly `{ provider: "LOCAL", subject,
  issuedAt, expiresAt, authTime }`, with `authTime` from `auth_time`.
- Subject: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` in both the adapter and `LocalSignInRequestSchema`. ADR-005 section 16
  gives `local-user-<name>` as an example, not a required format, so the pattern stays general.
- Local sign-in creates no user, business or membership and writes no audit record (it is not a business mutation).
  The caller still registers through `POST /v1/me/registration` and is authorized from the database.
- Gating: server configuration refuses `IDENTITY_PROVIDER=local` unless `TALI_ENV=local`. Composition checks again
  (local only in `local`, fake only in `local` or `test`), so a forged or altered config cannot compose a development
  provider in `development`, `staging` or `production`. `AppModule` does not mount the controller unless both
  `TALI_ENV=local` and the local provider was composed.
- Rate limit: an in-process fixed window of 20 requests per minute per client address, at most 256 tracked addresses
  (pruned). Over the limit it answers 429 with the existing `RATE_LIMITED` code. This is a local safeguard only
  (ADR-005 section 18).
- Cognito remains unimplemented: `IDENTITY_PROVIDER=cognito` fails at startup with "not implemented yet (blocked on
  ADR-003)".

## FingerprintHasher and framing v1

- `packages/integrations/src/platform/crypto/`: `frameCanonicalCommandV1` builds the frame and
  `Sha256FingerprintHasher` hashes it with `node:crypto` SHA-256. There is no `JSON.stringify` and no handwritten
  hash.
- The specification is `packages/application/src/idempotency/fingerprint-framing-v1.md`: header `TFP 0x01`, the
  operation and schema version, then tagged values with 32-bit big-endian lengths and counts; object keys strictly
  increasing by UTF-8 bytes; set elements sorted by the bytes of their encodings; NFC text, no lone surrogates, depth
  at most 32. The framing reads its input as untrusted and refuses anything it does not define.
- 14 versioned vectors (`FINGERPRINT_V1_VECTORS`) cover the empty object, key order, null versus absent, integers,
  NFC, multibyte text and keys, ordered arrays, sets, nesting and a real `business.create.v1` command. Frames were
  written by hand and digests computed independently (.NET SHA-256). The application-owned contract
  (`describeFingerprintHasherContract`) runs against the real adapter, with FIPS 180-2 vectors for SHA-256 itself.

## Composition

- `createApiRuntime` (now async) composes one `Database` (one Prisma client), the clock, the identity provider,
  `uuidV7IdGenerator`, `Sha256FingerprintHasher` and `composeApiServices`, which builds the resolvers and use cases
  over the Slice 2 adapters (unit of work, repositories, PostgreSQL audit writer, user idempotency store).
  Controllers and guards receive only `ApiServices`; they never see repositories, the unit of work or Prisma.
- Graceful shutdown is unchanged (`RuntimeShutdown` closes the pool; the SIGTERM test passes on Linux).
- Slice 2 transaction semantics are unchanged. One addition: the unit of work reports connection-class failures
  (SQLSTATE class 08, 57P01 to 57P03, 53300, Prisma P1001, P1002, P1017, P2024, adapter and socket connection errors) as
  `DependencyUnavailableError`, which maps to 503 DEPENDENCY_UNAVAILABLE (ADR-005 section 13.1). Retry rules are as
  before.

## Error mapping

One place, `apps/api/src/errors/error-envelope.filter.ts` (`mapError`), is used by the Nest filter and by the
pre-routing body-parser handler. The envelope is `{ error: { code, message, details? } }`.

| Code | Status |
| --- | --- |
| VALIDATION_FAILED, IDEMPOTENCY_KEY_REQUIRED | 400 |
| UNAUTHENTICATED | 401 |
| USER_NOT_REGISTERED, USER_DISABLED, PERMISSION_DENIED | 403 |
| NOT_FOUND | 404 |
| IDEMPOTENCY_KEY_REUSED, IDEMPOTENCY_IN_PROGRESS, CONCURRENT_MODIFICATION, CONFLICT | 409 |
| DEPENDENCY_UNAVAILABLE | 503 |
| Any other error | 500 INTERNAL_ERROR, generic message |

Framework 4xx responses keep the codes that already existed in the map (`PAYLOAD_TOO_LARGE`,
`UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED`, `METHOD_NOT_ALLOWED`, `BAD_REQUEST`). Tests prove no Nest, Prisma, jose,
SQL or body text reaches a client.

## Logging and observability

- Events: `auth.token_rejected {reason}`, `user.registered {userId}`, `context.denied {reason, userId?}`,
  `business.created {businessId, userId}`, each with the correlation ID.
- Redaction now also covers `jwt`, `bearer`, `privateKey`, `signature`, `claims`, `subject`, `displayName`, `email`
  and `phone` field names, in addition to the existing secret-like names.
- Errors are logged by name, a bounded `code`, stack frames and cause chain only, never the message. Prisma validation
  errors, for example, quote the full query with argument values (such as display names) in their message whatever
  `errorFormat` is set to, and parser errors can quote the raw body. Tests assert that tokens, subjects, display names
  and thrown messages never appear in the logs.

## Tests

| Suite | Result |
| --- | --- |
| `@tali/application` unit | 213 passed (resolver, fingerprint contract, identity-provider contract additions) |
| `@tali/integrations` unit (new) | 76 passed |
| `@tali/shared` unit | 18 passed |
| `@tali/api` unit | 48 passed (error mapping, body-parser errors, rate limiter, logger redaction and error serialization, business-route guard enforcement) |
| `@tali/database` unit | 13 passed |
| `@tali/database` integration | 17 files, 194 passed (default location on PostgreSQL, unreachable unit of work) |
| `@tali/api` integration | 6 files, 74 passed, 1 skipped (Linux-only SIGTERM test) |
| `@tali/worker` integration | 9 passed, 1 skipped (Linux-only) |

The new API integration files are `tenancy-api`, `tenancy-authorization` and `local-identity`. They cover:

- Registration: exactly one user, one `LOCAL` external identity and the `user.registered` and `identity.linked`
  platform audit records with `sourceChannel "api"` and the request's correlation ID. A repeat writes nothing.
- CreateBusiness: the business, one ACTIVE default location, one OWNER membership (version 1), business audit
  records, and one completed user idempotency record (32-byte fingerprint, version 1). Replay returns the stored
  result with `Idempotent-Replayed`. A reused key with another body is 409 with no writes. Keys are scoped per user.
  Missing and malformed keys are rejected. KES, JPY, BHD and NGN all work, and an unknown currency leaks no database
  detail.
- Authentication on every route: no header, empty bearer, other schemes, unknown, expired and revoked tokens.
- Fixtures: userA, userB, userAB (MANAGER in A, CASHIER in B), a disabled user and an unregistered identity.
- Tenant hiding: foreign, unknown and malformed IDs (including an uppercase foreign ID) return byte-identical 404
  bodies. Suspended businesses and memberships are hidden, and client tenant or actor headers are ignored.
- The `member:read` matrix for all five roles. A check that the wire role list equals the roles the database
  accepts.
- Strict validation: unknown fields, over-length values, bad pagination, unexpected query parameters, malformed JSON
  and oversized bodies.
- Local sign-in: sign in, get USER_NOT_REGISTERED, register, then read `/v1/me`. Sign-in itself creates no rows. The
  tests also cover a tampered local token, strict subjects, 429 after the limit, and no token, subject or name in the
  logs.
- Non-local safety: the route is 404 in the test and production configurations. Configuration and composition both
  refuse local and fake providers in deployed environments.
- DEPENDENCY_UNAVAILABLE end to end, with an unreachable database.

## Verification

| Check | Result |
| --- | --- |
| Text integrity, `prettier --check`, build, lint (`--max-warnings=0`), typecheck | PASS |
| Boundaries (dependency-cruiser) | PASS (368 modules, 1,329 dependencies) |
| Business-route guard test | PASS (9 tests); fails naming each route when the class guard is removed |
| Uncached unit test phase (`turbo run test --force`, all 18 tasks) | PASS (exit 0) |
| `pnpm verify` | PASS (exit 0) |
| `pnpm test:integration` | PASS (exit 0, 12 of 12 tasks) |
| `pnpm install --frozen-lockfile` | PASS |
| `verify-schema.mjs` on the local and test databases; `migrate status`; drift check | PASS, up to date, no drift (no schema change in this slice) |
| Web Playwright smoke (`@tali/web e2e`) | PASS (6 tests) |
| Client bundle scan | PASS (clean) |
| gitleaks v8.30.1 (Docker): `git` over history, and `dir` over a copy of every changed and untracked file | No leaks (11 commits; 79 files) |

New rules were each checked with a deliberate violation (a `jose` import in `apps/api` and a `node:fs` import in
`packages/integrations/src/local`): ESLint and dependency-cruiser both reported them, and the probes were removed.

### Web Vitest worker-start failure (root cause, measurements, decision)

**Symptom.** Some `pnpm verify` runs failed in `@tali/web` with "[vitest-pool]: Failed to start forks worker for test
files ... Timeout waiting for worker to respond". All four web test files failed at 60.19 s. The same failure is
recorded in the Slice 2 audit. It recurs and is not treated as noise.

**Mechanism** (Vitest 5.0.2 source):

- The forks pool waits for each worker's "started" message with a hard-coded `START_TIMEOUT` of 60,000 ms. It is
  not configurable.
- A worker sends "started" only after `setupBaseEnvironment`, which loads the jsdom environment and runs
  `environment.setup()`. Loading jsdom is therefore inside the 60 s handshake.
- Node-environment packages load no such environment, which is why only `@tali/web` fails.

**Measurements.** A temporary probe, since removed, recorded in each web worker the time from process start
(`performance.timeOrigin`) to setup-file execution. That interval covers the fork, the jsdom load and the
environment setup. Host: 8 logical CPUs, 16 GB RAM, 2.4–3.2 GB free, 26 Docker containers running.

| Condition | Worker start per worker (3 rounds each) |
| --- | --- |
| Web alone, quiet host, default workers | 5.1–6.6 s |
| Web alone, quiet host, `maxWorkers: 2` | 3.6–5.9 s |
| Concurrent with `turbo run test --force` (other packages) and API integration, default workers | 14.9–19.5 s |
| Same load, web `maxWorkers: 2` | 11.2–24.4 s |
| Concurrent with `turbo run test --force` (other packages), Turbo default concurrency | 12.7–17.9 s |
| Same, Turbo `--concurrency=4` | 12.8–17.0 s |
| Web alone, after all other packages finished (serialized) | 13.9 s, 35.8 s, and one run **timed out at 60 s** |

**Root cause.** Worker start time follows how saturated the host is. Neither the web package's own worker count
nor the repository's orchestration changes it measurably:

- Capping web workers did not shorten startup.
- Lowering Turbo concurrency did not shorten it.
- Serializing the web tests after every other package still reproduced the 60 s timeout with no repository
  process running. Host CPU was then at 55–97%, mostly outside the repository (the WSL/Docker VM, the browser
  and the editor), and the same non-web phase varied from about 100 s to 424 s between rounds.

When host starvation pushes jsdom's load past 60 s, the fixed handshake fails.

**Decision: no configuration change.** The three candidate changes were each measured and none addresses the
cause; a trial serialization of the root `test` script was reverted. The remaining options were rejected:

- Moving web tests to the Node environment would change what `ids.test.ts` deliberately tests (browser-like
  `crypto` under jsdom).
- The start timeout cannot be raised without patching Vitest.

No assertion, test, timeout or coverage setting changed.

**Results on the final (unchanged) configuration:**

- Web alone: 5 of 5 runs passed (20 of 20 tests, 10.3–20.0 s).
- Web concurrent with API integration and every other package's forced unit tests: 6 of 6 passed.
- Forced full test phase with API integration: 3 of 3 passed.
- Final `turbo run test --force`: passed (web in 53 s).
- One deliberately doubled run, the forced full unit phase and the full `pnpm test:integration` at once on the
  starved host, failed with timeouts: a web render test hit the 5 s test timeout, and two worker-process tests
  hit their 20 s process waits. Both suites passed when rerun the way `verify` and CI run them.

See Residual risks.

## Deviations and decisions to note

- **Server ID generator.** The API needs an `IdGenerator`. `uuidV7IdGenerator` in `packages/integrations/platform`
  wraps `uuid@14` `v7()`, the implementation the UUIDv7 spike selected, and refuses to run without
  `crypto.getRandomValues`.
- **Unit of work maps connection failures to DEPENDENCY_UNAVAILABLE** (see Composition). Previously they surfaced as
  500.
- **Test fixtures moved.** The tenancy fixtures (reset, test currencies, status changes, snapshots) moved from the
  database package's test support into `@tali/database/testing`, so the API suite can use them. They refuse any
  target but the loopback `*_test` database with `TALI_ENV=test`. `pg` stays internal: `withFixtureSession` is not
  exported, and the containment test passes.
- **API integration global setup.** It resets the Build 1 tables and adds the test currencies, and removes them
  again afterwards. It never migrates; CI migrates first.
- **401 message.** The uniform message is now "A valid bearer access token is required" (one existing test updated).
- **Startup test.** The "not implemented" provider is now `cognito`, because `local` is implemented.
- **Default location missing** is 500 INTERNAL_ERROR (a broken invariant), not a new public code.
- **Log serialization drops error messages** for all API logs (see Logging). Debugging relies on the error name,
  code and stack frames.
- **Registration by a disabled user** returns USER_DISABLED, as required.
- **UUID case.** Business IDs are parsed case-insensitively (RFC 9562), so the owner's own ID in uppercase resolves
  to the same business. A foreign ID in any case is hidden.

## Residual risks

- **Tenancy and authorization.** Business-scoped routes get their guards from the class-level declaration on
  `BusinessScopedController`. The route-guard test fails if any served route with `:businessId` lacks
  `AuthenticationGuard, BusinessContextGuard` in that order, or lives outside the business prefix (see Business-route
  guard enforcement). It checks the `test` and `local` compositions; a future composition-specific controller must
  be covered by adding its environment to the test.
- **Web tests on a starved host.** The `@tali/web` jsdom workers can miss Vitest's fixed 60 s start handshake when
  the host is CPU-starved by load outside the repository. No repository configuration was measured to prevent this
  (see Verification). If it recurs in CI, the next steps are more CI runner capacity or an upstream-configurable
  start timeout, not skipping or weakening tests.
- **Rate limiting** is per process and keyed by `request.ip`, which is correct for a local process only. It is not a
  production control, and local sign-in never runs in production.
- **Worker logs.** `apps/worker` has its own logger and does not yet use the new error serialization. It logs no
  identity data in Build 1.
- **Cognito.** Production authentication is still unavailable until ADR-003 and Slice 6.
