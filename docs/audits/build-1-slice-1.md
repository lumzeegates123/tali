# Build 1 Slice 1: identity and tenancy domain, application services and fakes

- Date: 2026-09-29
- Scope: Slice 1 of `docs/plans/003-build-1-identity-tenancy.md` (guidance in its section 13), under
  ADR-004, ADR-005 and ADR-006 (all ACCEPTED). Domain types and invariants, the Build 1 permission catalogue,
  user and business context resolution, the P0 use cases, audit and idempotency ports with the ADR-006 audit payload
  mechanism, the canonical fingerprint representation and the `FingerprintHasher` port, deterministic fakes and tests.
- Not in this slice: Prisma schema, migrations, PostgreSQL repositories, NestJS endpoints, web or mobile screens,
  Cognito, AWS, CDK, invitations, device registration, the real `FingerprintHasher` adapter.

## Summary

| Area | Result |
| --- | --- |
| Domain model (identity, business, location modules) | PASS, 33 new domain tests |
| Permission catalogue and role mapping (ADR-005 section 8) | PASS, exact per role |
| User and BusinessContext resolution (plan section 13.5) | PASS, full matrix |
| P0 use cases with atomic CreateBusiness | PASS, rollback proven in the fakes for every write and audit step |
| Audit payload mechanism (ADR-006) | PASS, no Zod, no runtime dependency |
| Canonical fingerprint representation and hasher port (plan section 13.2) | PASS, no crypto or UTF-8 encoding in application |
| Business time-zone contract (plan section 13.4) | PASS, tzdata 2026c checked-in dataset |
| Boundaries and probes | PASS, every forbidden import rejected |
| Client-safe kernel | Unchanged, surface test passes |
| Full verification | PASS (two load-related timeouts passed on rerun; see Verification) |

## Domain (`packages/domain/src/modules`)

The domain modules are pure: no I/O, no clock, no runtime lookups. They are exported from the package root, not from
the client-safe `./kernel` entry point.

- **identity**: `UserId`, `ExternalIdentityId`; `ExternalIdentity` with provider `COGNITO` or `LOCAL` only and a
  `ProviderSubject` (1 to 255 code points, well-formed, compared exactly, never normalized); `User` with
  `displayName` (trim, NFC, 1 to 100 code points) and status `ACTIVE` or `DISABLED`. A User has no business, role,
  email or phone. There is no disable operation; DISABLED users only arrive through `restoreUser`.
- **business**: `BusinessId`, `MembershipId`; `Business` (name 1 to 120 after trim and NFC, one ISO 4217 currency,
  a canonical `BusinessTimeZoneId`, status `ACTIVE` or `SUSPENDED`), with no currency or time-zone mutation.
  `BusinessMembership` with roles `OWNER`, `MANAGER`, `CASHIER`, `STOCK_KEEPER`, `ACCOUNTANT` (a closed list; no Role
  entity), status `ACTIVE` or `SUSPENDED`, and a version for optimistic concurrency.
- **location**: `LocationId`; `BusinessLocation`. `createDefaultLocation` produces the single ACTIVE default
  location whose name is a snapshot of the business name; a default location cannot be non-ACTIVE.
- **Errors**: `DomainError` with codes `INVALID_VALUE`, `INVALID_TRANSITION`, `LAST_ACTIVE_OWNER`, `OWNER_REQUIRED`.
  The application maps them to the existing `VALIDATION_FAILED`, `CONFLICT` and `PERMISSION_DENIED` codes.

### Membership invariants (pure logic)

`changeMembershipRole`, `suspendMembership` and `reactivateMembership` take the target, the acting membership, a
required reason (non-blank, at most 500 code points) and the current count of active owners. They check, in order:

1. the actor belongs to the same business and is ACTIVE (so a SUSPENDED member cannot reactivate itself);
2. a change to the current state is a no-op (`unchanged`, no version increment, nothing to audit);
3. a role change on a SUSPENDED membership is `INVALID_TRANSITION` (ADR-005: `CONFLICT`);
4. granting or removing OWNER requires an ACTIVE OWNER actor (`OWNER_REQUIRED`, mapped to `PERMISSION_DENIED`);
5. the result may not leave zero active owners (`LAST_ACTIVE_OWNER`, mapped to `CONFLICT`).

The last-active-owner rule is pure: the caller supplies the owner count. The Slice 2 repositories must read that
count under the ADR-005 lock; no locking is simulated here. No use case in Slice 1 calls these transitions (member
management is Slice 5); they are tested in the domain.

### Time-zone data placement and rationale

- **Location**: `packages/domain/src/modules/business/time-zone-reference.ts`, a generated, checked-in data module
  with `TIME_ZONE_REFERENCE_VERSION = "tzdata-2026c"`, 340 canonical zones and 257 alias mappings.
- **Source**: IANA `tzdata2026c.tar.gz`, SHA-256
  `E4A178A4477F3D0EA77CC31828FF72AA38FEFF8D61AA13E7E99E142E9D902BE4`, recorded in the file header. The generator is
  `tooling/timezone-reference/generate.mjs` (dependency-free Node.js). It reads the Zone and Link lines of the main
  region files plus `backward`, resolves link chains and rejects names that collide when case is folded. `backzone`
  and `factory` are excluded.
- **Why the domain**: the data is pure constants, needed to construct a valid `Business`, and the plan requires
  that Business receive an already validated `BusinessTimeZoneId`. A domain data module needs no port, no I/O and no
  dependency. An application port with checked-in data would add indirection without changing the contract.
- **Behavior** (plan section 13.4): canonical names are accepted as is; wrong case is normalized; aliases map to
  their canonical zone (`UTC` to `Etc/UTC`, `Asia/Calcutta` to `Asia/Kolkata`); raw offsets and unknown names are
  rejected. `restoreBusiness` accepts only an exact canonical name.
- **Runtime consistency check**: a domain test confirms every canonical zone is accepted by the pinned runtime's
  `Intl` through the kernel's `parseTimeZoneId`, so `BusinessDate.fromInstant` works for every storable zone.
- **Note**: tzdata 2026c defines some long-standing zone names as links (for example `Europe/Amsterdam` links to
  `Europe/Brussels`). Such input is stored as the canonical target. This follows the dataset, as the plan requires.

## Application (`packages/application/src`)

### Ports (only those the use cases need)

| Port | Methods |
| --- | --- |
| `UserRepository` | `findByExternalIdentity`, `findById`, `insertRegistration` (returns `"identity-already-linked"` on the unique race) |
| `BusinessRepository` | `findById`, `insert` |
| `MembershipRepository` | `findByBusinessAndUser`, `insert`, `listMembers`, `listAccessibleBusinesses` |
| `LocationRepository` | `insert`, `listForBusiness` |
| `CurrencyReferenceRepository` | `findByCode` |
| `AuditWriter` | `recordBusinessEvent`, `recordPlatformEvent` (ADR-004 section 8.1: two streams, one port) |
| `UserIdempotencyStore` | `find`, `insert` (returns `"duplicate"` when a concurrent request committed the key) |
| `FingerprintHasher` | `fingerprint(CanonicalCommand)` |

No database implementation and no outbox exist. Lists use keyset pagination on the record ID (default 50,
maximum 100); the ID order is a stable listing order only.

### Use cases

| Use case | Authorization | Notes |
| --- | --- | --- |
| RegisterCurrentUser | verified identity | Natural key (provider, subject). Repeat or lost race: returns the existing user, `registered: false`, no audit. A DISABLED user gets `USER_DISABLED`. |
| GetCurrentUser | ACTIVE user | Re-reads the user. |
| CreateBusiness | ACTIVE user | Keyed idempotency in user scope. Creates business, default location and OWNER membership in one unit of work. |
| ListMyBusinesses | ACTIVE user | ACTIVE memberships of ACTIVE businesses only. |
| GetBusiness | `business:read` | Context business only. |
| ListLocations | `location:read` | Context business only. |
| ListMembers | `member:read` | Context business only; includes SUSPENDED members with display names. |

### Context resolution

- `AuthenticatedUserContext {userId, correlationId, sourceChannel}`. `BusinessContext` is unchanged except that its
  ID types now come from the domain. `locationId` stays optional and `LocationBoundContext` requires it.
- `createUserContextResolver`: verified identity to user. No linked user gives `USER_NOT_REGISTERED`, a DISABLED
  user gives `USER_DISABLED`, and an unusable subject fails authentication.
- `createBusinessContextResolver` (framework-free, plan section 13.5). It resolves the user first, then:
  - a malformed business ID, an unknown business, another tenant's business, a SUSPENDED membership and a
    SUSPENDED business all give the same `NOT_FOUND` with the same message;
  - otherwise it builds a frozen context with the user actor and membership ID, the business's currency and time
    zone, and the role's `PermissionSet`.
  - It trusts no role, membership or location claim from the caller. The transport guard, correlation and device
    headers and default-location resolution remain in Slice 3.

### Permissions (ADR-005 section 8)

- Every role: `business:read`, `location:read`, `device:register`.
- OWNER also: `business:update`, `member:read`, `member:invite`, `member:manage`, `device:read`, `device:revoke`.
- MANAGER also: `member:read`, `device:read`.
- The mapping is static code; permissions are never stored per membership.

### Audit

- Events: `user.registered` and `identity.linked` (platform stream); `business.created`, `location.created` and
  `membership.created` (business stream). The registry holds exactly these five.
- Payloads: `user.registered {status}`, `identity.linked {userId, provider}`,
  `business.created {currencyCode, timeZone, status}`, `location.created {isDefault, status}`,
  `membership.created {userId, role, status}`.
- Excluded, and checked by tests: tokens, secrets, credential hashes, provider subjects, raw identity or provider
  payloads, complete entities, and display or business names. A registry test fails if any field name matches the
  sensitive pattern or looks like a name, subject, email or phone field.
- `AuditRecorder` is the only entry point. It accepts only registered actions on the matching stream, validates the
  payload and the reason (non-blank, at most 500 code points), and assigns the record ID and time from the injected
  ID generator and clock. The records are written in the same unit of work as the mutation.

### Audit payload mechanism (ADR-006)

- `auditField` kinds: `id`, `string(maxLength ≤ 1000)`, `boolean`, `enumeration(values)`, `integer(min, max)`,
  `instant`, and `optional(field)`. Payloads are flat.
- **Definition time** (`defineAuditAction`, `defineAuditRegistry`): action names are `entity.event`; the payload
  schema version is a positive integer; field names are camelCase and may not match
  `/token|secret|credential|password|hash|jwt/i`; the worst-case JSON size computed from the declared bounds may not
  exceed 8 KiB; a duplicate action name is rejected.
- **Runtime** (`validateAuditPayload`): the payload must be a plain object; unknown fields, missing required fields,
  `null` and out-of-bounds values are rejected; values are returned unchanged in a frozen copy (no trimming,
  normalization, defaults or coercion). Compile-time payload types are inferred from the definitions.
- No Zod and no runtime dependency.

### Idempotency

- **CreateBusiness** is keyed (`business.create.v1`, command schema version 1). The key is required
  (`IDEMPOTENCY_KEY_REQUIRED`), must be a UUID of any version (`VALIDATION_FAILED`) and is scoped to the user. The
  command is normalized first (`{name, currencyCode, timeZone}`), then canonicalized and fingerprinted. The
  idempotency key and correlation ID are not part of the fingerprint.
- **Order inside the unit of work**: authentication and authorization first (ADR-004 section 6), then:
  1. The key is looked up. A match on operation and fingerprint replays the stored result, with no new effect and
     no audit. A mismatch gives `IDEMPOTENCY_KEY_REUSED`.
  2. The mutation is planned (validation, currency reference data, IDs), and nothing is written yet.
  3. The key is claimed by inserting the idempotency record before any other write. If a concurrent request
     already committed it, the stored record is replayed instead.
  4. The writes and audit records are applied.
- A deterministic rejection or any failure rolls back everything, including the claim, so the same key can be
  retried with a valid command.
- Retention is 30 days at minimum. Results are stored through a per-operation codec (`createBusinessResultCodec`),
  which re-validates records on replay.
- **RegisterCurrentUser** uses the natural key and writes no audit record on a no-op.
- There are no one-time secrets in any stored result.

### Canonical fingerprint representation and hasher status

- `canonicalCommandEncoding` (version 1) produces a typed tree of tagged nodes, headed by the fingerprint version,
  the versioned operation name and the command schema version. Its rules:
  - object keys are ordered by Unicode code point, and absent keys are omitted, which is distinct from `null`;
  - strings and keys are NFC-normalized, and keys that collide after NFC are rejected;
  - integers are tagged `safe-integer` or `bigint`, with canonical digits; `-0`, fractional numbers and unsafe
    integers are rejected;
  - instants are ISO 8601 UTC with milliseconds; business dates are `YYYY-MM-DD`;
  - `canonicalEnum` marks enum literals;
  - arrays keep their order;
  - `canonicalSet` marks declared sets. Duplicate elements are rejected, and set elements are **not** sorted,
    because their order is defined over encoded bytes and belongs to the adapter;
  - lone surrogates, invalid dates and non-plain objects are rejected.
- `canonicalValuesEqual` compares arrays in order and sets regardless of order.
- The application performs no UTF-8 encoding, SHA-256, `node:crypto`, Web Crypto or `TextEncoder`. The application
  tsconfig has no DOM or Node types, so `TextEncoder` and `crypto` do not even resolve (confirmed by a probe).
- `FingerprintHasher` is a port. `FakeFingerprintHasher` returns a 32-byte marker value derived from a structural
  equality lookup and records its inputs. It performs no cryptography.
- **Deferred to the real adapter (Slice 3, `packages/integrations/src/platform/crypto/`)**: UTF-8 byte framing with
  explicit byte lengths, ordering set elements by encoded bytes, SHA-256, the written framing specification, and
  the framing and SHA-256 contract vectors (plan section 13.2).

### Errors

New codes, all required by ADR-004 or ADR-005: `USER_NOT_REGISTERED` (403), `USER_DISABLED` (403),
`IDEMPOTENCY_KEY_REQUIRED` (400), `IDEMPOTENCY_KEY_REUSED` (409). `ApplicationError.retryable` is true only for
`DEPENDENCY_UNAVAILABLE`. The API error filter maps the new codes; there are no new endpoints.
`IDEMPOTENCY_IN_PROGRESS` and `CONCURRENT_MODIFICATION` are not added. They arise from the Slice 2 adapters
(lock-wait timeout, version mismatch), and nothing in Slice 1 can raise them. `DEVICE_NOT_TRUSTED` is not added.

### Fakes (`packages/application/src/testing`)

- `InMemoryUnitOfWork` now captures and restores the state of enlisted participants on failure, and rejects a
  transaction scope used outside its run.
- `InMemoryTenancyStore` implements every repository port. It enforces the uniqueness and ownership constraints the
  Slice 2 schema will enforce (identity key, one membership per user and business, one default location per
  business, referenced business and user exist, currency in reference data). It has test setup helpers and
  failure injection.
- `InMemoryAuditWriter`, `InMemoryUserIdempotencyStore` (with a `beforeInsert` hook that simulates losing a race),
  `FakeFingerprintHasher`, `FailureInjection`, and `createTenancyHarness`, which composes every use case.
- `FakeIdentityProvider` reports `LOCAL` by default, or `COGNITO`, never a provider category of its own.
  `VerifiedIdentity` gains `authTime`.

These tests prove the application logic and the fakes' constraints. **They do not prove database-level tenant
isolation or transactional behavior**; that is Slice 2's integration and concurrency work against PostgreSQL.

## Tests

| Package | Files | Tests | New in Slice 1 |
| --- | --- | --- | --- |
| `@tali/domain` | 10 | 143 | 4 files, 33 tests |
| `@tali/application` | 15 | 201 | 9 files, 161 tests, plus 2 in `fakes.test.ts` |
| `@tali/api` (unit) | 3 | 22 | 4 rows in the error filter test |

New application test files: `audit-payload` (43), `audit-recorder` (10), `canonical-command` (24),
`keyed-idempotency` (11), `identity` (16), `permissions` (8), `business-context-resolver` (7),
`create-business` (26), `queries` (16).

The use-case tests cover:
- success and validation failure;
- an unregistered identity, a disabled user and a suspended membership;
- a suspended business, another tenant's business and permission denied for each role;
- replay, a key reused with a different command, a key scoped to the user, and concurrent-duplicate replay;
- no-op without audit, and the audit records and their payloads;
- rollback when each of the six write and audit steps of CreateBusiness fails, followed by a successful retry with
  the same key.

Integration tests, run against the local Docker PostgreSQL: database 82 passed; worker 9 passed and 1 skipped;
API 24 passed and 1 skipped. The API identity-guard test now expects the provider `LOCAL`.

## Verification

| Check | Result |
| --- | --- |
| Text integrity | PASS (352 files, UTF-8 without BOM) |
| Format (`prettier --check`) | PASS |
| Build (all packages) | PASS |
| Lint (`--max-warnings=0`) | PASS |
| Typecheck (all packages) | PASS |
| Boundaries (dependency-cruiser) | PASS (293 modules, 933 dependencies) |
| Unit tests | PASS |
| Integration tests | PASS |
| Secret scan | gitleaks is not installed locally, so it was not run. A targeted search of the new code found no key or credential patterns. `.gitleaks.toml` is unchanged and there is no `.gitleaksignore`. CI runs gitleaks. |

In the full parallel runs, two existing tests in untouched packages hit timeouts. They passed on rerun, both alone
and as the whole suite:
- `@tali/database` `containment.test.ts` timed out at 5 s on a dynamic import;
- the `@tali/api` startup integration test "starts and listens with valid configuration" failed once.

### Temporary probes (created, confirmed rejected, deleted)

| Probe | Rejected by |
| --- | --- |
| domain imports `@tali/application` | dependency-cruiser `domain-depends-on-nothing-internal`; ESLint |
| application imports `@tali/database`, `@tali/shared` | dependency-cruiser `application-depends-only-on-domain`; ESLint |
| application imports `zod` | dependency-cruiser (unresolvable: not a dependency of application) |
| domain or application imports `@nestjs/common`, `@prisma/client`, `@aws-sdk/client-s3` | dependency-cruiser; ESLint restricted imports |
| domain or application imports `node:crypto` | dependency-cruiser `domain-no-runtime-dependencies` / `application-framework-free`; ESLint |
| application uses `TextEncoder`, `crypto.subtle` | TypeScript (`Cannot find name`) and ESLint |

After deletion, boundaries report no violations. At that point Zod was blocked in `packages/application` only
because it was not declared there. The permanent enforcement below closes that gap.

### Permanent ADR-006 enforcement (boundary hardening, 2026-09-29)

`packages/application` may depend at runtime only on approved workspace packages (currently `@tali/domain`) and may
not declare or import any external npm package. Three parts enforce this, and `pnpm boundaries`
(`tooling/dependency-boundaries.mjs`, also run in `pnpm verify` and CI) runs all three.

1. **Manifest policy** (`tooling/dependency-cruiser/application-policy.mjs`). `packages/application/package.json`
   must follow these rules, or the check fails before anything imports the package:
   - `dependencies` holds only approved workspace packages, using the `workspace:` protocol;
   - `optionalDependencies` and bundled dependencies are empty;
   - the only peer dependency is `vitest`, which must be marked optional because the exported port contract suites
     import it.

   `devDependencies` follow the normal repository conventions.
2. **Import rule** (`application-no-external-runtime-dependencies` in `.dependency-cruiser.cjs`). No application
   source file except `*.test.ts` may import an npm package of any dependency type, whatever `package.json`
   declares. This includes the port contract suites, which the existing `application-framework-free` rule
   exempts. The only exception is that contract suites may import `vitest`; `application-framework-free` still
   keeps `vitest` out of all other production source. `@tali/domain` is allowed.
3. **Regression suite** (`tooling/dependency-cruiser/application-boundary-self-test.mjs`). It builds a throwaway
   fixture repository whose application manifest declares `zod` and `some-runtime-lib`, then runs the real rule set
   against it. Each fixture import must resolve, so the check cannot pass vacuously, and each must get the expected
   verdict:

   | Edge | Expected |
   | --- | --- |
   | application → `@tali/domain` | allowed |
   | contract suite → `vitest` | allowed |
   | application → `zod` (declared) | `application-no-external-runtime-dependencies` |
   | application → arbitrary external package (declared) | `application-no-external-runtime-dependencies` |
   | contract suite → `zod` | `application-no-external-runtime-dependencies` |
   | production source → `vitest` | `application-framework-free` |
   | application → `@tali/database` | `application-depends-only-on-domain` |
   | application → `@tali/shared` | `application-depends-only-on-domain` |

   The suite also checks that the manifest policy rejects `zod` and the external package and accepts
   `@tali/domain`.

Two fixes to the existing configuration were needed for the import rule to work:

- **`exclude` was hiding npm edges.** The repository `exclude` pattern for build output (`(^|/)dist/`, and so on)
  also matched `node_modules/.pnpm/<package>/.../dist/...`. Any npm package whose entry point is in `dist/` (such as
  `vitest`) therefore vanished from the graph, and no rule could see the import. The pattern now applies only
  outside `node_modules`. The cruise now covers 303 modules and 1,010 dependencies, up from 293 and 933, with no
  violations. The fixture packages ship their entry points in `dist/`, so reintroducing the broad pattern fails the
  suite.
- **`no-undeclared-npm-dependency` false positive.** dependency-cruiser also reports `npm-no-pkg` for a package
  named in `peerDependenciesMeta`. The rule now ignores edges that are also declared in a real dependency field, and
  still catches genuinely undeclared imports.

Mutation checks were run temporarily and then reverted. Each failed `pnpm boundaries` as expected:
- declaring `zod` and `left-pad` in the real application manifest;
- restoring the old `exclude` pattern (five fixture imports then stop resolving);
- disabling the new rule (`zod` from a contract suite then passes unnoticed).

### Dependencies and kernel

- No dependency was added to any package, and `pnpm-lock.yaml` is unchanged. The time-zone generator uses only
  Node.js built-ins and lives in `tooling/`.
- The client-safe kernel (`packages/domain/src/kernel`, entry point `./kernel`) is unchanged, and
  `surface.test.ts` passes. The identity, business and location modules are exported from the package root only.

## Deviations and decisions to note

1. **Claim-first keyed idempotency.** The idempotency record is inserted before the business writes, so a
   concurrent duplicate waits on the key and replays, instead of racing the business insert. This is the ordering
   the Slice 2 adapter must support (`INSERT ... ON CONFLICT DO NOTHING`, then re-read). The effects are the same as
   ADR-004 section 4: one effect per key, atomic with the record.
2. **Result size cap.** The 16 KiB limit is enforced on the encoded result by the Slice 2 store adapter. Slice 1
   results are small and bounded by construction.
3. **Deferred error codes.** `IDEMPOTENCY_IN_PROGRESS` and `CONCURRENT_MODIFICATION` are deferred to Slice 2, where
   the adapters that raise them are built.
4. **Framing specification and vectors.** These are deferred to the real `FingerprintHasher` adapter in Slice 3.
   Plan section 13.2 places them next to the port. Writing them without the adapter would fix a byte layout that
   nothing yet exercises.
5. **Default-location resolution.** This stays in Slice 3 (plan section 13.5). The resolver returns a context
   without a location.
6. **Provider type.** `VerifiedIdentity.provider` is typed as the persisted category (`COGNITO` or `LOCAL`), so no
   mapping layer is needed.
7. **Linked zone names.** tzdata links such as `Europe/Amsterdam` are stored as their canonical target (see
   the time-zone section).
8. **Module grouping.** Memberships live in the `business` module, and locations in their own module. The
   dependencies run business to identity and location to business, with no cycles.

None of these conflicts with an accepted ADR.

## Before Slice 2

Nothing blocks Slice 2. It must provide:
- PostgreSQL implementations of the ports above;
- the constraints the fakes enforce (unique identity key, one membership per user and business, one default
  location per business, composite foreign keys, currency reference data);
- the claim-first behavior of `UserIdempotencyStore.insert`, including a lock-wait timeout raising
  `IDEMPOTENCY_IN_PROGRESS`;
- the 16 KiB result cap;
- reading the active-owner count under the ADR-005 lock before calling the membership transitions;
- integration tests that prove tenant isolation at the database.
