# ADR-005. Identity, tenancy and authorization

- Status: ACCEPTED (2026-09-29)
- Date: 2026-09-29
- Deciders: Tali maintainers (human approval given 2026-09-29; drafted by an AI agent, accepted by the human
  maintainer)
- Related: `docs/decisions/ADR-001-aws-infrastructure.md` (accepted), `docs/decisions/ADR-002-application-foundation.md`
  (accepted; sections 7, 11, 13, 15, 18, 20, 21 and 25), `docs/decisions/ADR-004-mutation-protocol.md` (accepted),
  `docs/product/mvp-scope.md` (APPROVED; including the role vocabulary recorded 2026-09-29),
  `docs/plans/001-foundation-plan.md` sections 6 to 9, `docs/architecture/architecture-principles.md` section 11,
  `docs/architecture/data-principles.md` sections 5, 11 and 12, `.cursor/rules/30-multitenancy.mdc`,
  `.cursor/rules/10-database.mdc`, `.cursor/rules/50-api.mdc`, `.cursor/rules/60-testing.mdc`,
  `.cursor/rules/70-security.mdc`, `docs/plans/003-build-1-identity-tenancy.md`

Numbering note: ADR-003 is reserved for AWS foundation topology (referenced by accepted ADR-002). This ADR uses the
next free number after ADR-004.

## 1. Context

Build 1 (identity and tenancy) is step 2 of the approved implementation order. It delivers authentication
integration, users, businesses, their default location, staff membership, roles, permissions, devices and tenant
isolation. ADR-002 section 25 defers the "authorization model: roles, feature permissions, offline permission
attributes" to a separate decision, and plan 001 places that decision before the first mutating use case.

Already decided and not changed here:

- Cognito authenticates, Tali authorizes (ADR-001). The provider subject is an external reference to a Tali UUID
  user (`architecture-principles.md` section 11).
- `BusinessContext` is resolved server-side and passed explicitly to use cases (`30-multitenancy.mdc`, ADR-002
  section 7). It carries `{ businessId, locationId?, actor, permissions, deviceId?, sourceChannel, correlationId,
  currency, timeZone }` and is implemented in `packages/application/src/context/business-context.ts`.
- Permissions are a skeletal, code-defined catalogue (`packages/application/src/authorization/permissions.ts`). No
  feature permissions are defined before their use cases (ADR-002 section 7).
- Local and fake identity adapters cannot be enabled in deployed environments (ADR-002 sections 18 and 20).
- Tenant tables use composite `(business_id, id)` keys and composite foreign keys, and RLS is not enabled (ADR-002
  section 21).
- Location-aware from day one, with exactly one active default location per business in the MVP (`mvp-scope.md`).
- Initial pilot roles are APPROVED in `mvp-scope.md` (OWNER, MANAGER, CASHIER, STOCK_KEEPER, ACCOUNTANT;
  invitations cannot grant OWNER).
- Mutation idempotency, audit and transaction semantics come from ADR-004.

## 2. Decision summary

The following design directions are decided:

1. One Tali user may belong to multiple businesses.
2. Business selection is explicit in the request route `/v1/businesses/:businessId/...`. There is no hidden
   server-side "current business".
3. A client may remember its last-selected business only as a local UX preference.
4. `BusinessLocation` is first-class from Build 1. Creating a business automatically creates one active default
   location.
5. `BusinessMembership` stores the role. There is no dynamic Role table in Build 1.
6. Permissions are code-defined and derived from the membership role.
7. Every business keeps at least one ACTIVE OWNER. Owner-affecting membership changes are serialized
   transactionally, so two concurrent requests cannot remove the final owner.
8. Invitations cannot grant OWNER.
9. Invitation tokens have at least 256 bits of cryptographically secure randomness. Only a cryptographic hash is
   stored. The plaintext is returned once and never logged. The default expiry is 72 hours.
10. Devices are business-scoped registrations. A physical device used for two businesses has two registrations. A
    device does not authenticate a user, and shared devices require separate staff authentication sessions.
11. Device credentials are verified by loading the device by `deviceId` and comparing the presented credential
    against the stored hash in constant time. A device credential never replaces user authentication, and a
    client-supplied device ID is never trusted by itself.
12. User registration is explicit, after successful external authentication. Email and phone number are never the
    Tali user identity.
13. Cognito holds authentication identity only. No authoritative roles, memberships, business IDs or permissions are
    stored in Cognito.

## 3. ExternalIdentity

- Table `external_identities` (global, not tenant-owned):
  - `id`, `user_id` (FK to `users`), `provider`, `provider_subject`, `created_at`;
  - `provider` CHECK in (`COGNITO`, `LOCAL`); `provider_subject` has a length CHECK (1 to 255);
  - **UNIQUE `(provider, provider_subject)`**, and an index on `user_id`.
- The subject is the provider's stable subject identifier (the Cognito `sub`), never a username, email or phone
  number.
- It is part of Build 1: it is needed to map the first authenticated request to a Tali user.
- Build 1 creates exactly one external identity per user, at registration. Linking extra identities (a second sign-in
  method, provider migration) is deferred to ADR-003 and the sign-in UX decision.
- Which providers are allowed per environment is enforced by configuration (ADR-002 section 18), not by the database.
- No provider tokens, refresh tokens or raw claims are stored.
- **Persisted provider values are the real execution modes only:** `COGNITO` (deployed environments) and `LOCAL`
  (the local development issuer, section 16).
  - `FakeIdentityProvider` is a test adapter behind the `IdentityProvider` port, and it gets **no** persisted
    category. When a test persists an external identity, the fake is configured to report `LOCAL` (or `COGNITO`, for
    tests that model Cognito-shaped subjects). No test-only value enters the production CHECK constraint.
  - Adding the fake's current in-memory label (`fake`) to the CHECK would need a written justification. No Build 1
    test needs it.
  - The configuration values `IDENTITY_PROVIDER=cognito|local|fake` select an adapter. They are not persisted
    values. The mapping from adapter to persisted category lives in the composition and repository code.
  - `LOCAL` rows cannot arise in deployed environments, because configuration rejects the local adapter there.

## 4. Tali User

- Table `users` (global): `id` (UUIDv7), `display_name`, `status`, `created_at`, `updated_at`.
- **No `business_id` and no role on User.** Business access comes only from memberships.
- `status` CHECK in (`ACTIVE`, `DISABLED`). A DISABLED user is rejected on every request, whatever token they
  present.
- `display_name` is 1 to 100 characters after trimming and NFC normalization.
- **No email or phone columns in Build 1.** Contact attributes wait for the sign-in UX decision in ADR-003. This
  keeps personal data to a minimum, and it keeps email and phone from ever becoming keys.
- Build 1 **enforces** DISABLED but has **no** disable-user action, public or administrative. No unaudited
  administrative mutation is created just to exercise the state. Tests create disabled fixtures directly through
  controlled test setup in the disposable test database.
- Disabling users in production requires a future authorized, audited operations/support action (`user.disabled` in
  the platform audit stream, ADR-004). That action must be designed before disabling is used in production. Routine
  direct SQL updates are not an acceptable operational workflow.

## 5. Business

- Table `businesses`:
  - `id`, `name`, `currency_code`, `time_zone`, `status`, `created_by_user_id` (FK to `users`), timestamps;
  - `name` is 1 to 120 characters after trimming and NFC normalization;
  - `currency_code` is `VARCHAR(3)` with an FK to `currencies(code)` (ADR-002 section 13);
  - `time_zone` is an IANA zone name, validated by the kernel time-zone parser at the boundary, with a length CHECK in
    the database;
  - `status` CHECK in (`ACTIVE`, `SUSPENDED`). SUSPENDED is honored by context resolution, because the resolver
    model needs a way to stop access to a business without deleting anything. Build 1 exposes **no** user endpoint
    and no other path that sets it. A future authorized, audited operations/support action must be designed before
    suspension is used in production. Routine direct SQL updates are not an acceptable operational workflow.
- **Currency** is set at creation (`mvp-scope.md`: "set when the business is created"), and Build 1 has **no** use
  case that changes it. **Time zone** is set at creation, and Build 1 has no use case that changes it either. Any
  future change is audited and never recomputes existing business dates (ADR-002 section 15). Whether currency or
  time zone may change once financial activity exists is an **open question** for the ledger/accounting ADR. This ADR
  does not invent a policy.
- **Currency reference data** (`currencies`: `code` PK with CHECK `^[A-Z]{3}$`, and `minor_unit_digits` CHECK 0 to
  4) is global and read-only for the application role.
  - Production migrations may contain **only legitimate ISO 4217 currency values**, with their ISO minor-unit
    exponents. No fake or test-only currency is ever added in a production migration.
  - The private-pilot production migration seeds **NGN** as the initial currency reference value.
  - Additional production currencies are added through reviewed migrations when geographic or product scope expands.
  - Tests that need several currencies (for example to prove that NGN is not hardcoded) insert legitimate ISO 4217
    codes as **test-only fixtures** into the disposable test database.
- **Business creation** (CreateBusiness, keyed idempotency with user scope per ADR-004) runs in one transaction:
  1. insert the business;
  2. create the default location through the location module's use case;
  3. create the OWNER membership for the creating user;
  4. write the audit records `business.created`, `location.created` and `membership.created`;
  5. store the idempotency record.

  Any registered ACTIVE user may create a business. No business permission applies, because none exists yet.

## 6. BusinessLocation

- Table `business_locations`:
  - `business_id`, `id`, `name`, `is_default`, `status`, timestamps;
  - `status` CHECK in (`ACTIVE`, `ARCHIVED`);
  - CHECK `(NOT is_default OR status = 'ACTIVE')`;
  - **partial unique index on `(business_id) WHERE is_default AND status = 'ACTIVE'`**, so there is at most one active
    default location per business;
  - "at least one" is guaranteed by the business-creation transaction and verified by tests (`60-testing.mdc`: a new
    business gets exactly one active default location).
- When a business is created, the default location's name **defaults to the business name**.
  - This is an initial value, a snapshot copied at creation time.
  - Renaming the business later does **not** rename the location.
  - Location names become independently manageable when location management is implemented.
  - Build 1 has no location rename.
- There is no per-location time-zone override in the MVP (one location, no justification). It can be added later
  without breaking changes.
- Creating, renaming or archiving further locations is out of scope (no branch management in the MVP).
- Any `locationId` in input is verified to belong to the context business (`30-multitenancy.mdc`). The database
  enforces the same rule through composite foreign keys on location-referencing tables.

## 7. Role vocabulary

APPROVED in `mvp-scope.md`: `OWNER`, `MANAGER`, `CASHIER`, `STOCK_KEEPER`, `ACCOUNTANT`.

- The role is stored on `business_memberships.role`, with a CHECK on these five values.
- There is **no Role table** and no custom-role designer in Build 1. Adding a role is a product decision followed by
  a migration and a code change.
- Invitations may grant `MANAGER`, `CASHIER`, `STOCK_KEEPER` or `ACCOUNTANT`, never `OWNER`.

## 8. Permission catalogue and mapping

**Role versus permission.** A role is the named job a membership holds. A permission (`resource:action`) is the
capability that one use case checks. Use cases check permissions and do not compare role names. The only exceptions
are domain rules that intrinsically depend on OWNER:

- granting or revoking `OWNER` requires an acting OWNER;
- the last-active-owner protection (section 10).

**Mechanism.**

- The Build 1 catalogue is defined with `definePermissionCatalogue` in the application `identity` module.
- A static, code-versioned `rolePermissions` mapping expands a membership's role into the `PermissionSet` during
  context resolution.
- Use cases call `requireContextPermission`, which denies by default.
- Permissions are not stored per membership. They are derived from the role, so changing the mapping takes effect on
  the next request.

**Build 1 catalogue and mapping:**

| Permission | OWNER | MANAGER | CASHIER | STOCK_KEEPER | ACCOUNTANT | Used by |
|---|---|---|---|---|---|---|
| `business:read` | yes | yes | yes | yes | yes | GetBusiness |
| `location:read` | yes | yes | yes | yes | yes | ListLocations |
| `device:register` | yes | yes | yes | yes | yes | RegisterDevice |
| `business:update` | yes | | | | | UpdateBusinessName |
| `member:read` | yes | yes | | | | ListMembers |
| `member:invite` | yes | | | | | CreateInvitation, RevokeInvitation, list invitations |
| `member:manage` | yes | | | | | ChangeMemberRole, SuspendMember, ReactivateMember |
| `device:read` | yes | yes | | | | ListDevices |
| `device:revoke` | yes | | | | | RevokeDevice |

- CASHIER, STOCK_KEEPER and ACCOUNTANT receive no additional Build 1 administrative permissions.
- **No permissions are defined** for sales, inventory, payments, accounting, purchasing or AI. They are introduced
  with their future use cases.
- Offline permission attributes and their defaults stay with the sync ADR and open decision 3.
- Use cases outside any business (RegisterCurrentUser, GetCurrentUser, ListMyBusinesses, CreateBusiness,
  AcceptInvitation) require an authenticated, registered, ACTIVE user and no business permission.

## 9. Membership lifecycle

- Table `business_memberships`:
  - `business_id`, `id`, `user_id` (FK to `users`), `role`, `status`, `version`, timestamps;
  - `status` CHECK in (`ACTIVE`, `SUSPENDED`);
  - **UNIQUE `(business_id, user_id)`**: at most one membership row per user and business, so a duplicate active
    membership is impossible. A returning member is reactivated, never duplicated.
- Memberships are created by business creation (OWNER) or invitation acceptance (the invited role). Invitations are a
  separate model (section 14).
- Transitions (all require `member:manage` and write audit records):
  - **ChangeMemberRole:** a `reason` is required (`data-principles.md` section 12, permission changes). It targets
    ACTIVE memberships only, and changing a SUSPENDED membership's role returns `409 CONFLICT`. Granting or removing
    `OWNER` requires the acting membership to be OWNER. Demoting the last active owner is rejected with
    `409 CONFLICT`.
  - **SuspendMember:** ACTIVE to SUSPENDED, `reason` required. Suspending the last active owner is rejected with
    `409 CONFLICT`.
  - **ReactivateMember:** SUSPENDED to ACTIVE, `reason` required. This authorized owner-management action is the
    **only** way to reactivate a membership. A SUSPENDED member cannot reactivate themselves by accepting an
    invitation (section 14).
- Requesting the current state is a successful no-op with no audit record (ADR-004 section 7).
- An owner may demote or suspend themselves, unless they are the last active owner.
- A SUSPENDED membership gives no access. Context resolution treats it as no membership (section 13).
- Deferred: self-service "leave business", a dedicated ownership-transfer flow (for now: promote another owner, then
  demote), and step-up re-authentication for role changes (`70-security.mdc` says "may require"; `authTime` is
  captured in `VerifiedIdentity` for this later).

## 10. Owner invariant and locking

- **Invariant:** every business has at least one membership with `role = OWNER` and `status = ACTIVE`.
- **Enforcement:** every use case that can reduce the set of active owners (role change, suspension) runs inside
  `UnitOfWork.run` and:
  1. takes `SELECT ... FOR UPDATE` on the `businesses` row (via parameterized `$queryRaw`, accepted in ADR-002
     section 27);
  2. re-reads the **acting** membership under that lock and checks it is still ACTIVE and still holds the
     permission, so authorization cannot change between the check and the commit;
  3. re-reads the target membership and counts the active owners;
  4. applies the pure domain decision (reject when the change would leave zero active owners);
  5. writes the change and the audit record.
- The business row lock serializes all membership changes within one business, which is acceptable at pilot scale.
  Other businesses are unaffected.
- The invariant cannot be expressed as a declarative constraint, and business rules may not live in triggers
  (`00-architecture.mdc`). It is therefore enforced by the application under the lock and proven by tests, including a
  race test in which two concurrent demotions of the two remaining owners allow exactly one to succeed.

## 11. User registration and provisioning

- Registration is **explicit**. After successful external authentication, the client calls
  `POST /v1/me/registration` with a display name.
- In one transaction, the use case creates the `users` row and the `external_identities` row, and writes
  `user.registered` and `identity.linked` to `platform_audit_records` (ADR-004).
- It is naturally idempotent through UNIQUE `(provider, provider_subject)`. A repeat call, or a concurrent duplicate
  that loses the unique race, returns the existing user as a successful no-op with no new audit record.
- A verified identity with no Tali user gets `403 USER_NOT_REGISTERED` on every other route. A DISABLED user gets
  `403 USER_DISABLED`. Both are new `ApplicationError` codes (section 13).
- Users are never created implicitly on first request, and never matched or merged by email or phone.
- How registration fits the Cognito sign-in UX (hosted or custom UI, phone or email) is decided with ADR-003.

## 12. Active-business selection and context resolution

- **Selection:** every business-scoped route is `/v1/businesses/:businessId/...`. The path value is a claim, never a
  fact. There is no server-side "current business" (no session state, no user column, no header default). A client
  may remember the last business it used as a local UX preference only. It still sends the business in every route.
- **User-level context:** `AuthenticatedUserContext { userId, correlationId, sourceChannel }` (new, in
  `packages/application/src/context`) serves use cases that run before or outside a business.
- **Resolution order, once per request** (the API guard, then the resolver; controllers never build contexts):
  1. Verify the bearer token through the `IdentityProvider` port. If it fails, return `401`.
  2. Load the external identity, then the user. If no user exists, return `403 USER_NOT_REGISTERED`. If the user is
     DISABLED, return `403 USER_DISABLED`.
  3. Parse `businessId` as a UUID. If it is malformed, return `404`.
  4. Load the membership for `(businessId, userId)` together with the business. If the membership is missing or
     SUSPENDED, or the business is not ACTIVE, return `404`.
  5. Take `currency` and `timeZone` from the business.
  6. Expand the role into the `PermissionSet`.
  7. Take `correlationId` from a valid `x-correlation-id` header, or generate one.
  8. **Device, when present:** if the request carries device headers, verify them (section 15.3). A verification
     failure rejects the request. `deviceId` is set only after successful verification.
  9. Build the `BusinessContext`. Its `actor` is `{ type: "user", userId, membershipId }`.
- **Location-bound context:** location-bound use cases receive a `LocationBoundContext`, produced by
  `requireLocationBound` or by a resolver step that runs before the use case. When no `locationId` is supplied, the
  server resolves the business's single active default location. A supplied `locationId` must belong to the business
  and be ACTIVE, otherwise the response is `404`. Build 1 builds and tests this resolver, but no Build 1 use case is
  location-bound.
- **Worker:** jobs rebuild the context from the database in the same way (ADR-002 section 7). They re-validate the
  business, and the membership for user-initiated work.

## 13. Cross-business access and error behavior

- A business the caller cannot access (unknown, other tenant, SUSPENDED membership, non-ACTIVE business) returns
  **`404 NOT_FOUND`**, with a body identical to that of a nonexistent business. Responses never reveal whether the
  business exists.
- A related ID in path or body (membership, invitation, device, location) is loaded with the context `businessId`.
  An ID that belongs to another business is indistinguishable from a nonexistent one (`404`).
- A caller who is a member but lacks the permission gets `403 PERMISSION_DENIED`.
- The error envelope is `{ error: { code, message } }`. There are no stack traces, SQL, tokens or internal IDs of
  other tenants.

### 13.1 New `ApplicationError` codes introduced by Build 1

Existing codes (`packages/application/src/errors/application-error.ts`) are reused wherever their meaning fits, and
a new code exists only where the client must react differently. These are **all** the new codes Build 1 introduces:

| Code | HTTP | Returned when | Hides resource existence? | Retryable? | Defined in |
|---|---|---|---|---|---|
| `USER_NOT_REGISTERED` | 403 | The access token is valid, but no Tali user is linked to its `(provider, provider_subject)`. Returned on every route except registration. The client should offer registration. | Not applicable (it concerns the caller only) | No, until the user registers | ADR-005 |
| `USER_DISABLED` | 403 | The authenticated user's status is DISABLED. | Not applicable (the caller's own status) | No | ADR-005 |
| `DEVICE_NOT_TRUSTED` | 403 | Device headers are present but malformed or incomplete, the device is unknown or belongs to another business, the credential does not match, or the device is REVOKED. | Yes: one response for all causes | No (the client must re-register the device) | ADR-005 |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | A keyed operation was called without an `Idempotency-Key`. | Not applicable | No (resend with a key) | ADR-004 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | The same actor reused a key in the same scope with a materially different canonical command. | Yes: the stored result is never revealed, and keys are scoped per actor | No | ADR-004 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | A request with the same key is still executing, and the lock wait exceeded `lock_timeout`. | Not applicable (the caller's own key) | Yes, with the same key | ADR-004 |
| `CONCURRENT_MODIFICATION` | 409 | Serialization failure or deadlock after the final attempt, or a lock timeout. | Not applicable | Yes | ADR-004 |

**Existing codes reused by Build 1 (no new code):**

| Situation | Existing code | HTTP |
|---|---|---|
| Missing, invalid or expired access token | `UNAUTHENTICATED` | 401 |
| Unknown, foreign, suspended-membership or non-ACTIVE business; malformed `businessId`; a foreign or unknown membership, invitation, device or location ID | `NOT_FOUND` (hides existence) | 404 |
| An invitation token that is unknown, expired, revoked, accepted by another user, or whose inviter has lost authority | `NOT_FOUND` (hides existence) | 404 |
| A member without the required permission; granting or removing OWNER without being OWNER | `PERMISSION_DENIED` | 403 |
| Last-active-owner protection; an invalid transition (for example revoking an ACCEPTED invitation, or changing a SUSPENDED membership's role); accepting an invitation while already an ACTIVE or SUSPENDED member | `CONFLICT` | 409 |
| Body, query or path validation failure; a malformed `Idempotency-Key` | `VALIDATION_FAILED` | 400 |
| Database or dependency unavailable | `DEPENDENCY_UNAVAILABLE` | 503 (retryable) |

`CONFLICT` responses carry a human-readable message only. No sub-codes are introduced in Build 1.

## 14. Invitation lifecycle

- Table `business_invitations`:
  - `business_id`, `id`, `token_hash` (32 bytes, UNIQUE), `role`, `status`, `expires_at`;
  - `created_by_membership_id` and `accepted_by_membership_id`, both composite FKs to
    `business_memberships(business_id, id)`;
  - `created_at`, `accepted_at`, `revoked_at`, `revoked_by_membership_id` (composite FK);
  - `role` CHECK in (`MANAGER`, `CASHIER`, `STOCK_KEEPER`, `ACCOUNTANT`), so OWNER is excluded at the database level;
  - `status` CHECK in (`PENDING`, `ACCEPTED`, `REVOKED`), with CHECKs keeping status consistent with the
    `accepted_*`/`revoked_*` columns;
  - "expired" is derived from `expires_at` against the server clock. It is not a stored state, and the device clock
    is never used.
- **Bearer invitations.** Build 1 invitation tokens are **bearer invitations**. Any authenticated, registered, ACTIVE
  Tali user who holds a valid token may attempt acceptance. Acceptance is still subject to:
  - token validity;
  - invitation state;
  - expiry;
  - the inviter-authority re-check;
  - the user's membership state;
  - tenant rules.

  Build 1 invitations are **not** bound to an email address or phone number. Identity-bound invitations may be added
  later, when invitation delivery and user-contact design are approved.
- **Token:**
  - at least 256 bits of secret material from the platform's cryptographically secure random source, encoded as
    base64url;
  - a **fixed, non-secret, recognizable prefix** is prepended so that secret scanners can detect leaked tokens. The
    prefix adds no secrecy and never reduces the random material below 256 bits. Its exact printable form is an
    implementation detail;
  - only its SHA-256 digest is stored. A keyed hash is not needed, because the secret has at least 256 bits of
    entropy. No plaintext is stored;
  - the plaintext is returned once, in the CreateInvitation response. Replays return `tokenAvailable: false`
    (ADR-004 section 12);
  - it is never logged or stored in audit records, the idempotency result, analytics or error reports.
- **Delivery:** there is no delivery provider in Build 1. The inviter shares the link manually. The link carries the
  token in the URL **fragment** (`/invitations/accept#token=...`). Browsers do not send fragments in HTTP requests,
  so the server never receives the token through the initial page request, and it does not appear in server logs or
  `Referer` headers. The client:
  1. reads the fragment locally;
  2. removes it from the visible URL or navigation state as soon as practical (for example by replacing the history
     entry without the fragment);
  3. sends the token to Tali's API only in the body of `POST /v1/invitations/accept`;
  4. never logs it, and never stores it in analytics, crash reports, persisted navigation or history state.
- **Expiry:** default of 72 hours.
- **Create** (`member:invite`): role must be one of the four invitable roles. Keyed idempotency (ADR-004).
- **Revoke** (`member:invite`): PENDING to REVOKED. Revoking a REVOKED invitation is a no-op. Revoking an ACCEPTED
  one returns `409`.
- **Accept** (`POST /v1/invitations/accept`, authenticated, registered, ACTIVE user):
  1. Hash the presented token, then load and `FOR UPDATE`-lock the invitation by `token_hash`.
  2. If the invitation is unknown, expired, revoked, or already accepted by **another** user, return a uniform
     `404 NOT_FOUND`.
  3. If it was already accepted by **this** user, return a successful no-op with the existing membership (replay).
  4. Re-validate that the business is ACTIVE, and that the creating membership is still ACTIVE and still holds
     `member:invite`. If not, the invitation can no longer be used, and the response is `404 NOT_FOUND`.
  5. If the user already has an ACTIVE membership in that business, return `409 CONFLICT`. If they have a SUSPENDED
     membership, also return `409 CONFLICT`: an invitation never reactivates a suspended membership, and only the
     ReactivateMember owner-management action can (section 9). In both cases the invitation stays PENDING.
  6. Otherwise, create the ACTIVE membership with the invited role, and mark the invitation ACCEPTED and bound to
     that membership. Write the audit records `invitation.accepted` and `membership.created`.
- **Scope:** an invitation grants membership in its own business only, and has no effect on any other business.
- **Replay safety:** acceptance is single-use (row lock, status check and UNIQUE membership).
- **Local development:** the token is shown in the API response and the local web UI in exactly the same way as in
  any environment. There is no special delivery path and no logging. Tests read the token from the creation
  response.
- **Retention:** invitations are never hard-deleted by the application. Purging old invitations requires a later
  retention decision.

## 15. Devices

### 15.1 Scope

- A device registration belongs to **one business**. Table `devices`:
  - `business_id`, `id`, `platform`, `label`, `credential_hash` (32 bytes), `status`;
  - `registered_by_membership_id` and `revoked_by_membership_id`, both composite FKs;
  - `registered_at`, `revoked_at`;
  - `platform` CHECK in (`ANDROID`); iOS is added later by migration;
  - `status` CHECK in (`ACTIVE`, `REVOKED`), with a CHECK keeping it consistent with `revoked_at`.
- A physical device used for two businesses has **two** registrations, each with its own credential. This matches the
  per-business partitioning of local stores (`70-security.mdc`).
- A device is **not** a user credential. Every request still carries a user access token. On a shared device, each
  staff member signs in with their own session, and actions are attributed to the signed-in user (`actor`) with the
  verified `deviceId` as additional evidence.
- Every active role may register a device under the Build 1 mapping (`device:register`). OWNER and MANAGER may list
  devices (`device:read`). Only OWNER may revoke (`device:revoke`).
- Device registration is **optional** for ordinary Build 1 authenticated operations, unless a specific use case
  requires it.

### 15.2 Registration

- The server generates the `deviceId` (UUIDv7) and a credential containing at least 256 bits of cryptographically
  secure random material, with the same kind of fixed, non-secret, recognizable prefix as invitation tokens
  (section 14). It stores only the credential's SHA-256 digest (no plaintext), and returns the plaintext once with
  `credentialAvailable: true`. Replays return `credentialAvailable: false`. Recovery is to revoke the registration
  and register again (ADR-004 section 12).
- A client-proposed installation identifier is never used as the device identity. There is no device attestation in
  Build 1.
- The mobile app stores the credential in platform secure storage backed by the Android Keystore. That dependency is
  reviewed when the slice is implemented. The credential is never kept in plain local storage.

### 15.3 Credential verification

On a request that carries either `X-Tali-Device-Id` or `X-Tali-Device-Credential`:

1. Parse the device ID. Load the device **by `deviceId`**, scoped to the business being resolved:
   `(business_id, id)`. The device is **never** looked up by the raw credential, or by its hash.
2. Compute the SHA-256 digest of the presented credential (the derivation defined in section 15.2). Compare it with
   the stored `credential_hash` using a **constant-time** comparison, for example Node `crypto.timingSafeEqual` over
   equal-length digests.
3. Accept only when the device exists in that business, the digests match and the status is ACTIVE. **Fail closed:**
   the request is rejected with `403 DEVICE_NOT_TRUSTED` (section 13.1) if any of these apply:
   - either header is missing while the other is present;
   - a value is malformed;
   - the device is unknown or belongs to another business;
   - the credential does not match;
   - the device is REVOKED.

   The request is **never** silently downgraded to a request without a device.
4. The device credential is **never** user authentication, and never replaces or bypasses it. Steps 1 to 7 of
   section 12 always run.
5. A client-supplied device ID without a matching credential is never trusted, and `deviceId` is never set from a
   header alone.

### 15.4 Not decided here

- Whether device registration becomes **mandatory** for mobile business access, and how devices bind to offline
  commands, is decided in the sync ADR.
- What revocation means for data already on the device and for unsynced commands is open decision 15 in
  `mvp-scope.md`. Build 1 only rejects requests from revoked devices.
- Credential rotation, `last_seen_at` tracking (which would need write-throttling) and attestation are deferred.

## 16. Local identity provider

- `LocalIdentityProvider` lives in `packages/integrations/src/local` (ADR-002 sections 3 and 20).
- It signs short-lived JWTs (lifetime 1 hour) with an **ephemeral** key pair generated at process start and
  never persisted, so all local tokens become invalid when the process restarts. Issuer and audience are fixed local
  values.
- Its dev-only sign-in endpoint is mounted **only** when `TALI_ENV=local` and `IDENTITY_PROVIDER=local`. Server
  configuration already rejects `local` in any other environment (and `fake` outside local and test), and a CI test
  asserts this. Deployed environments cannot enable it.
- It is deterministic and multi-user: callers pick a subject from a constrained pattern (for example
  `local-user-<name>`). Several users can be exercised locally. Disabled-user behavior is exercised in automated
  tests through controlled test setup (section 4).
- Local sign-ins persist `LOCAL` as the external-identity provider (section 3).
- It asserts identity only. It never creates users, memberships, roles or permissions, and it carries no
  authorization claims. Everything after token verification goes through the normal registration, context and
  permission path, so the provider cannot bypass authorization.
- Tests keep using `FakeIdentityProvider` (`packages/application/src/testing`).
- The JWT library is a dependency to review in the implementing slice. No dependency is added by this ADR.

## 17. Cognito boundaries (independent of deployment details)

- Cognito proves identity. The adapter (`packages/integrations/src/aws/cognito`) verifies access tokens:
  - signature, against a cached JWKS that refreshes on an unknown key ID;
  - the allowed algorithm;
  - issuer (the configured user pool), `token_use = access`, `client_id` among the configured client IDs, and expiry,
    with a small clock-skew allowance on the server clock;
  - it maps `sub` to `provider_subject`.
- **Cognito stores no authoritative roles, memberships, business IDs or permissions.** Cognito groups and custom
  attributes are not used for authorization. Cognito triggers contain no business rules (ADR-001).
- Revocation inside Tali is immediate: user status, membership status and device status are checked on every
  request, independent of token lifetime.
- A token for a subject without an external identity leads to `USER_NOT_REGISTERED`.
- Deferred to ADR-003: user pool and client configuration, sign-in methods (phone or email, OTP, SMS delivery in
  Nigeria), hosted or custom UI, token lifetimes, how shared-device sessions map onto Cognito, and how registration
  fits the sign-in flow.
- CI never calls AWS. Adapter tests use locally generated keys and JWKS fixtures.

## 18. Abuse limits and rate limiting

- The local development sign-in endpoint may use a simple in-process limiter. It is a local safeguard only.
- Invitation tokens contain at least 256 bits of secret randomness, so realistic brute force is infeasible.
  Acceptance also requires an authenticated, registered user. Their security comes from that entropy. Rate limiting
  does not make them secure; it is defense in depth only.
- Production distributed rate limiting and abuse protection (edge, WAF, load balancer or API limits) are finalized
  with ADR-003 or the relevant edge/network decision.
- Redis or ElastiCache is **not** introduced for Build 1 rate limiting (ADR-001).
- An in-memory limiter inside one API process is **not** globally effective across several ECS tasks, and must never
  be described or relied on as if it were.

## 19. Tenant-safe relational design

- Global tables: `currencies`, `users`, `external_identities`, `platform_audit_records`, `user_idempotency_records`.
  None of them holds business data.
- Tenant-owned tables: `business_locations`, `business_memberships`, `business_invitations`, `devices`,
  `business_audit_records`, `business_idempotency_records`. Each has `business_id NOT NULL`, an FK to `businesses`,
  UNIQUE `(business_id, id)` and a leading `business_id` index.
- `businesses.id` is the tenant key itself.
- References between tenant tables are **composite foreign keys** `(business_id, x_id) -> parent(business_id, id)`.
  Examples: invitation to its creating and accepting membership, and device to its registering and revoking
  membership. The database therefore rejects any cross-tenant reference, even if application code is wrong.
- Unique constraints on tenant data include `business_id`, except for keys that are globally unique by construction
  (`token_hash`).
- Every repository method on tenant data takes `businessId`. There is no find-by-ID without the tenant, and no Prisma
  types leave `packages/database`.
- CHECK constraints: statuses, roles, platform, provider, lengths, status and timestamp consistency, the
  default-location rule, the currency format and minor units.
- Partial unique index: one active default location per business.
- Every CHECK, partial index and grant is added to the `verify-schema.mjs` expectations in the same migration PR.
- RLS stays off (ADR-002 section 21). The schema remains RLS-ready.

## 20. Destructive-operation policy

- There is no hard delete of `businesses`, `users`, `external_identities`, `business_locations`,
  `business_memberships`, `devices`, `business_invitations` or either audit table.
- The application role receives **no DELETE grant** on any Build 1 table. The ORM `delete`/`deleteMany` lint ban is
  extended to these models, and `verify-schema.mjs` checks the privileges.
- Records leave use through audited status changes: user `DISABLED`, business `SUSPENDED`, location `ARCHIVED`,
  membership `SUSPENDED`, invitation `REVOKED`, device `REVOKED`.
- Personal-data erasure requests are handled later by anonymizing personal fields (for example the display name),
  never by deleting records, according to the future retention and erasure policy.
- Retention and purge of invitations, idempotency records and platform audit records need a later decision (open
  decision 14, sync ADR).

## 21. Deferred and open items

- ADR-003: Cognito configuration and sign-in UX, token lifetimes, production rate limiting and edge protection,
  deployed secrets.
- The sync ADR: mandatory device registration, device binding of offline commands, offline permission attributes
  (open decision 3).
- Open decision 12: WhatsApp business selection for users with several businesses. The route-based selection here
  applies to the API only.
- Open decision 15: what happens to offline data and unsynced commands when a device or user is revoked.
- The ledger/accounting ADR: whether currency and time zone may change after financial activity.
- Later:
  - authorized, audited operations/support actions (disabling users, suspending businesses, support access). These
    are required before either state is used in production;
  - ownership-transfer UX and a leave-business flow;
  - step-up re-authentication;
  - location management (additional locations, renaming);
  - custom roles;
  - invitation delivery by email, SMS or WhatsApp, and identity-bound invitations.

## 22. Alternatives considered

- **A server-side "current business" (session value, user column or default header):** hidden state makes requests
  ambiguous, breaks with multiple tabs or devices, and weakens auditing. Rejected in favor of route selection
  (`50-api.mdc`).
- **Roles and permissions as tables (a dynamic Role table, permissions stored per membership):** flexible, but it is
  a custom-role designer in disguise, and it invites unaudited changes to the permission set. Rejected for Build 1.
  Code-derived permissions change only through reviewed code.
- **Roles or business IDs in Cognito groups or claims:** pool-wide rather than per business, stale until token
  refresh, and changed outside Tali's audited transactions. Rejected (ADR-001, `architecture-principles.md`
  section 11).
- **Just-in-time user creation on first request:** convenient, but it creates records without explicit intent and
  hides provisioning errors. Rejected in favor of explicit registration.
- **Email or phone as the user key:** these are mutable, reusable and not always verified. Rejected.
- **User-scoped devices spanning businesses:** simpler for a single-business user, but it mixes tenants' local data
  and revocation authority. Rejected in favor of business-scoped registrations.
- **Serializable isolation instead of a business row lock for the owner invariant:** it works, but relies on retries
  and is harder to reason about in tests. Rejected. A single explicit lock is simpler.
- **A database trigger for the owner invariant:** business rules may not live in triggers. Rejected.
- **Invitation acceptance by matching the invited email or phone:** contact data is not collected or verified in
  Build 1. Possession of a 256-bit token plus an authenticated user is the binding. Rejected for now, and can be
  added with delivery providers.
- **Tokens in URL paths or query strings:** these leak into logs and `Referer` headers. Rejected in favor of the URL
  fragment plus a POST body.

## 23. Consequences

- Positive:
  - Tenancy is decided once per request from the database.
  - Cross-tenant references are impossible at the database level.
  - Authorization is default-deny and testable per permission.
  - Revocation takes effect on the next request.
  - No authorization state lives in the identity provider.
- Negative / risks:
  - Membership changes serialize per business.
  - Losing the first invitation or device response requires recreating it.
  - Users cannot yet be disabled through a product surface.
  - Permission changes are code deployments.
- Impact:
  - **Financial integrity:** none directly. Future financial permissions follow the same mechanism.
  - **Tenancy:** strengthened (composite FKs, `404` behavior, isolation tests for users A, B and AB).
  - **Audit:** every membership, invitation, device and business change is audited under ADR-004.
  - **Idempotency:** as ADR-004.
  - **AI safety:** a future AI tool resolves the same `BusinessContext` as the invoking user and gets no more
    permissions.
  - **Security:** secrets are hashed, returned once and never logged. Device credentials never replace user
    authentication. Local identity cannot run when deployed.
- Rollout: Build 1 slices 1 to 6 as in `docs/plans/003-build-1-identity-tenancy.md`. The Cognito adapter slice is
  blocked on ADR-003. Rollback
  before acceptance: amend. After acceptance: supersede.

## 24. Compliance with governance rules

- `30-multitenancy.mdc`: a server-resolved `BusinessContext`, never trusting the client `businessId`, `404` for other
  tenants, related IDs verified, composite keys, and isolation tests required.
- `70-security.mdc`: least privilege (minimal Build 1 permissions), device registration and revocation, separate staff
  sessions on shared devices, device clocks never used for authorization, secrets hashed and never logged, local
  identity impossible in deployed environments, and role changes audited. Step-up authentication for role changes is
  deferred ("may require").
- `10-database.mdc`: `business_id` NOT NULL with FKs and indexes, tenant-scoped uniques, CHECKs, and row locks for the
  concurrency invariant.
- `00-architecture.mdc`: logic in application and domain services, no business rules in Cognito or the database,
  providers behind ports.
- `50-api.mdc`: route business selection, thin handlers, Zod validation, the error envelope and pagination.
- `60-testing.mdc`: success, validation, permission, other-tenant, audit, duplicate/idempotent and concurrency tests
  for every Build 1 mutation, plus the default-location test.
- ADR-002 section 7 (skeletal permissions): Build 1 adds only the permissions of Build 1 use cases.
- Plan 001 section 8 says "roles map to permission sets stored per membership". This ADR clarifies that the **role**
  is stored per membership and the permission set is derived in code. Plan 001 is not an ADR, so this is a
  clarification, not a change to an accepted decision.
- This ADR changes no existing rule.

## 25. Human approval record

Accepted by the human maintainer on 2026-09-29. The following decisions were explicitly approved:

- ExternalIdentity / User separation (sections 3 and 4);
- one user may belong to multiple businesses (section 2);
- route-based explicit business selection (section 12);
- BusinessLocation first-class from Build 1, with one active default location for the private pilot (section 6);
- the role stored on BusinessMembership, and a code-defined permission mapping (sections 7 and 8);
- the approved role vocabulary and the Build 1 permission mapping (sections 7 and 8);
- the transactional last-active-owner invariant (section 10);
- the bearer invitation design; invitations cannot grant OWNER; a 72-hour default invitation expiry (section 14);
- invitation token fragment handling (section 14);
- a recognizable non-secret token prefix, with at least 256 random secret bits (sections 14 and 15);
- SHA-256 storage for high-entropy invitation and device bearer secrets (sections 14 and 15);
- the invitation creator's authority re-checked on acceptance (section 14);
- business-scoped device registrations; device credentials supplement but never replace user authentication;
  fail-closed behavior for invalid device credentials; all active roles may register permitted devices (section 15);
- explicit user registration after authentication (section 11);
- the Cognito authentication-only boundary (section 17);
- persisted identity-provider values `COGNITO` and `LOCAL` only (section 3);
- a one-hour local JWT lifetime (section 16);
- the ACTIVE/DISABLED user state (section 4);
- the ACTIVE/SUSPENDED business state, with no Build 1 public suspension action (section 5);
- membership reason requirements and suspended-membership invitation restrictions (sections 9 and 14);
- NGN as the initial production currency reference value (section 5);
- the default location name initially snapshots the business name (section 6);
- no business currency or time-zone mutation use case in Build 1 (section 5);
- the error-code vocabulary in section 13.1.
