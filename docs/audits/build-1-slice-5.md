# Build 1 Slice 5: invitations, member management and devices

- Date: 2026-09-30
- Scope: Slice 5 of `docs/plans/003-build-1-identity-tenancy.md`, under ADR-002, ADR-004, ADR-005 and ADR-006 (all
  ACCEPTED). The P1 use cases of plan 003 section 5: UpdateBusinessName, CreateInvitation, RevokeInvitation,
  AcceptInvitation, ChangeMemberRole, SuspendMember, ReactivateMember, RegisterDevice, ListDevices and RevokeDevice;
  optional device verification on business routes; the web invitation UX; mobile invitation acceptance and Android
  device registration with secure storage.
- Not in this slice: Cognito and AWS authentication (Slice 6, blocked on ADR-003), RLS (stays disabled), AWS
  resources, invitation delivery by email/SMS/WhatsApp, identity-bound invitations, device attestation,
  `last_seen_at`, enforcing device binding on sync commands, and what revocation does to local data (open decision 15).
- Money: **not touched**. No financial, ledger or inventory code changed. The change touches **tenancy,
  authorization, authentication-adjacent device trust and one-time bearer secrets**; see the risk section.
- Dependency added: `expo-secure-store` **57.0.4** in `apps/mobile` (the version `expo install` selects for SDK 57,
  pinned exactly). The lockfile changes only by that package. No other dependency was added or upgraded.

## Summary

| Area | Result |
| --- | --- |
| Business rename (`business:update`, name only, same name is a no-op without audit) | PASS |
| Invitations: create (keyed), revoke (natural), accept (locked, uniform 404, 409 for members, replay) | PASS |
| Member role change, suspend, reactivate (`member:manage`, reason required, last-active-owner protection) | PASS |
| Devices: register (keyed), list (safe fields), revoke, optional header verification failing closed | PASS |
| One-time secrets: `node:crypto`, SHA-256 digest only, shown once, never in replay/audit/logs/errors | PASS |
| `DeviceContextGuard` after `AuthenticationGuard` and `BusinessContextGuard` on every business route | PASS (route-guard test) |
| Concurrency (create, accept, revoke, owner invariant) against PostgreSQL | PASS |
| Web invitation UX (link shown once, fragment stripped, no browser storage) | PASS (Vitest + Playwright) |
| Mobile acceptance and Android registration (SecureStore per business, iOS offers nothing) | PASS (jest-expo) |
| Migration from an empty database, `verify-schema.mjs`, drift | PASS |
| Client bundles free of server secrets and one-time-secret prefixes | PASS |
| `pnpm verify` | exit 0 |
| `pnpm test:integration` | exit 0 |
| gitleaks (history and changed files) | no leaks |

## Domain and application

- **Domain** (`packages/domain/src/modules/business/invitation.ts`, the device module): pure transitions.
  - Invitation: `PENDING -> ACCEPTED | REVOKED`. Revoking a REVOKED invitation is `unchanged`; revoking an ACCEPTED
    one is a rule violation (CONFLICT). The invitable roles are the four non-owner roles. Expiry is 72 hours.
    `isInvitationOpen(invitation, now)` derives expiry from `expiresAt` and the server clock; **EXPIRED is never
    stored**.
  - Device: `ACTIVE -> REVOKED`, with revoking again `unchanged`. Platform `ANDROID` only. Label trimmed, 1 to 60
    characters.
- **Application**
  - `update-business-name.ts`: `business:update`. It trims and validates the name. The same name returns
    `changed: false` and writes no audit record. The audit payload records the change and not the name text.
  - `invitations.ts`:
    - `CreateInvitation` is keyed through `KeyedIdempotency.runBusinessScoped`. The token is generated and hashed
      inside `plan`, and the plaintext is handed back only from the `apply` path of the first execution. The stored
      idempotency result (`invitationResultCodec`) is the invitation metadata only, so a replay returns
      `replayed: true` and no token.
    - `RevokeInvitation` locks the row (`findByIdForUpdate`, scoped by business).
    - `AcceptInvitation` runs for any authenticated, registered, ACTIVE user (ADR-005 section 14):
      - it parses the token (a malformed token is `NOT_FOUND`), digests it, and locks the invitation by digest
        `FOR UPDATE`;
      - an ACCEPTED invitation returns the existing membership only to the user it was accepted by, and is
        `NOT_FOUND` for anyone else;
      - otherwise it requires the invitation to be open, takes the business row lock (which serializes with
        membership changes), and re-checks that the business is ACTIVE and that the inviter is still an ACTIVE
        membership with `member:invite`;
      - an ACTIVE membership is `CONFLICT` ("already a member"), and a SUSPENDED one is `CONFLICT` (only an owner can
        reactivate); in both cases the invitation stays PENDING;
      - it then creates the membership, marks the invitation ACCEPTED, and writes `membership.created` and
        `invitation.accepted` audit records with the new membership as actor.
    - Every failure that could reveal something about a token is the same `NOT_FOUND`: unknown, malformed,
      expired, revoked, accepted by someone else, inactive business, or inviter no longer permitted.
  - `manage-membership.ts`: `ChangeMemberRole`, `SuspendMember` and `ReactivateMember` share the ADR-005 section 10
    owner-invariant protocol. In one transaction it locks the business row, re-reads the acting and target
    memberships, counts active owners, and applies the pure domain decision. A reason is required. Requesting the
    current state is a no-op with no audit record. Granting or removing OWNER needs an ACTIVE OWNER actor, and the
    last active owner cannot be suspended or demoted.
  - `devices.ts`: `RegisterDevice` (keyed; the credential is handled like the invitation token), `ListDevices`
    (`device:read`) and `RevokeDevice` (`device:revoke`, locked, a no-op when already revoked).
  - `device-verification.ts` (`createDeviceVerifier`):
    - with neither header, the context is returned unchanged;
    - with either header, it requires both. It parses the device ID, loads the device by
      `(context.businessId, deviceId)` (never by credential), and requires it to be ACTIVE. It compares the SHA-256
      digest of the presented credential with the stored digest using `timingSafeEqual`;
    - any failure is `DEVICE_NOT_TRUSTED` (403). On success, it returns a context with `deviceId` set, and audit
      envelopes then record the device.
- **BusinessIdempotencyStore** (`packages/database/src/repositories/business-idempotency-store.ts`): the first
  adapter for the business-scoped store of ADR-004 sections 4.2 and 4.3. It is unique on
  `(business_id, actor_type, actor_id, idempotency_key)` and follows the user-scoped protocol: the record is inserted
  inside the mutation's transaction with a parameterized `INSERT ... ON CONFLICT DO NOTHING`, a committed concurrent
  holder makes it a duplicate, and a lock wait beyond `lock_timeout` is `IDEMPOTENCY_IN_PROGRESS`. The same key with a
  different command is `IDEMPOTENCY_KEY_REUSED`. The stored result is the codec's metadata only, never a secret.
- **Audit events** (all business-scoped, in the mutation's transaction, recording the verified device when present):
  `business.renamed`, `invitation.created`, `invitation.revoked`, `invitation.accepted`, `membership.created` (on
  acceptance), `membership.role_changed`, `membership.suspended`, `membership.reactivated` (the membership events
  carry the reason), `device.registered` and `device.revoked`. No-ops write none. No payload contains a token,
  credential, digest, device label or business name text.
- **Ports**: `OneTimeSecretGenerator` and `SecretHasher` in `packages/application/src/ports/one-time-secret.ts`.
  The adapters in `packages/integrations/src/platform/crypto/` use `node:crypto` `randomBytes(32)`, base64url
  encoding with the non-secret prefixes `tali_inv_` and `tali_dev_`, SHA-256, and `timingSafeEqual`. A stored
  digest of the wrong length returns false and does not throw.

## Database

Migration `20260930165547_build1_invitations_devices`:

- It was created with `prisma migrate dev --create-only`, then custom SQL was appended and reviewed. It is
  forward-only, and no merged migration was edited. `db push` was not used.
- Tables:
  - `business_invitations`: `token_hash` bytea, UNIQUE, CHECK 32 bytes; role CHECK limited to the four invitable
    roles; status CHECK limited to `PENDING`/`ACCEPTED`/`REVOKED` (no EXPIRED); `expires_at > created_at`;
    acceptance and revocation columns shape-checked against the status; acceptance inside the validity window.
  - `devices`: `credential_hash` bytea, CHECK 32 bytes; platform CHECK `ANDROID`; label trimmed and 1 to 60
    characters; status CHECK `ACTIVE`/`REVOKED`; revocation columns shape-checked.
- Every membership reference is a composite `(business_id, membership_id)` foreign key. `business_audit_records`
  gains a composite `(business_id, device_id)` foreign key to `devices`, so an audit record's device must belong
  to the audit record's business.
- Indexes: `(business_id, status)` on both tables, and `(business_id, id)` unique on both.
- Grants: `tali_app` gets SELECT, INSERT and UPDATE on both tables, and **no DELETE**. RLS stays disabled. There are
  no triggers or functions.
- `verify-schema.mjs` lists every new object (12 table grant sets, 75 CHECK constraints, 8 tenant foreign keys) and
  fails rather than repairs.
- Repositories: `invitation-repository.ts`, `device-repository.ts` and the business-scoped idempotency store use
  parameterized Prisma queries only.

## API

| Endpoint | Guards | Permission | Idempotency |
| --- | --- | --- | --- |
| `PATCH /v1/businesses/:businessId` | Auth, BusinessContext, DeviceContext | `business:update` | natural |
| `POST /v1/businesses/:businessId/invitations` | Auth, BusinessContext, DeviceContext | `member:invite` | `Idempotency-Key` required |
| `POST .../invitations/:invitationId/revoke` | Auth, BusinessContext, DeviceContext | `member:invite` | natural |
| `POST /v1/invitations/accept` | Auth, RegisteredUser | authenticated | natural (single use) |
| `POST .../members/:membershipId/role`, `/suspend`, `/reactivate` | Auth, BusinessContext, DeviceContext | `member:manage` | natural |
| `POST .../devices` | Auth, BusinessContext, DeviceContext | `device:register` | `Idempotency-Key` required |
| `GET .../devices` | Auth, BusinessContext, DeviceContext | `device:read` | read |
| `POST .../devices/:deviceId/revoke` | Auth, BusinessContext, DeviceContext | `device:revoke` | natural |

- Controllers are thin: they parse strict Zod contracts (`packages/shared/src/contracts/http/team.ts`), call one
  application service, and map the result. Bodies, paths and queries are `.strictObject` with maximum lengths.
- Secret-bearing responses (`tokenAvailable: true` / `credentialAvailable: true`) carry `Cache-Control: no-store`.
  Replays return `Idempotent-Replayed: true` with `tokenAvailable: false` / `credentialAvailable: false` and no
  secret field.
- `POST /v1/invitations/accept` takes the token in the body only. It has an in-process limiter of 10 attempts per
  minute per user (`INVITATION_ACCEPT_LIMITER`), which is defence in depth and **not** globally effective across
  tasks (plan 003 section 5).
- `DeviceContextGuard` (`apps/api/src/auth/device-context.guard.ts`) runs after `AuthenticationGuard` and
  `BusinessContextGuard`. A repeated header becomes an unparseable value and is refused. Header values are never
  logged; a refusal logs only `device.not_trusted` with the business and user IDs.
- The logger redacts `token`, `credential`, `tokenHash`, `credentialDigest` and `label` keys (unit test added).
- Error envelope: `DEVICE_NOT_TRUSTED` maps to 403 (unit test added).

### Slice 3 guard fix

`BusinessContextGuard` parsed the whole `request.params` with the strict `BusinessPathSchema`. On nested routes
(`invitations/:invitationId/revoke`, `members/:membershipId/...`, `devices/:deviceId/revoke`), the extra parameter
made the parse fail, and every such request answered 404 (`business_not_accessible`). The guard now validates only
`businessId`, and the handler validates the remaining parameters with its own strict path schema. No Slice 1 to 4
route has a second parameter, so their behaviour is unchanged. This is a defect fix, not a design change.

### Route-guard test

`apps/api/test/compat/business-route-guards.test.ts` now requires `[AuthenticationGuard, BusinessContextGuard,
DeviceContextGuard]` in that order on all 12 business routes. It also checks that `DeviceContextGuard` is never
used outside a business path and that `/v1/invitations/accept` has exactly `[AuthenticationGuard,
RegisteredUserGuard]`. A rogue controller that omits the device guard is detected; the test expects 6 violations.

## One-time secrets

| Property | Where it is proven |
| --- | --- |
| 256 random bits from `node:crypto`, base64url with a recognizable prefix | integrations unit tests |
| Only the 32-byte SHA-256 digest is stored | database integration (`stores only the 32-byte digest; the token appears in no table`), API integration (digest equals `sha256(token)`) |
| Plaintext returned once | application and API tests |
| Replay never returns the secret | application, database concurrency and API tests |
| Never in idempotency records, audit records, logs or errors | API integration `expectNowhere` scans every table snapshot and captured log line; logger redaction test |
| Constant-time comparison | `timingSafeEqual` in `SecretHasher.matches`; wrong-length digests return false |
| Rejected input is not echoed | API test: a 400 for an oversized token does not contain the input |

## Web

- `invitations-panel.tsx` (shown when the membership role is OWNER; the server remains authoritative):
  - it lets the owner choose one of the four invitable roles, with the "expires after 72 hours" wording;
  - "Create invitation link" shows the link in a read-only field labelled "Invitation link", with "This link is
    shown once." and "Tali cannot show it again";
  - it has "Copy link" and "Done";
  - an "Invitations created here" table offers Revoke.
- The link is `${window.location.origin}/invitations/accept#token=…` (`invitation-link.ts`). There is no list
  endpoint in plan 003, so only invitations created in the current session are listed.
- Idempotency: one key per logical create (business and role), reused on retry. It is cleared after success and
  after `IDEMPOTENCY_KEY_REUSED`. A replay shows "already shown" and never a token.
- `/invitations/accept` (`app/invitations/accept/page.tsx`): `takeInvitationToken` reads `#token=` once and calls
  `history.replaceState(history.state, "", pathname + search)` so the fragment leaves the visible URL and history
  entry. The token is held only in the session store's private field; the snapshot exposes
  `hasPendingInvitation`. After sign-in and registration, `AcceptInvitationPanel` posts `{ token }`.
  `NOT_FOUND`, `VALIDATION_FAILED` and `CONFLICT` are final and drop the token. On success the business list
  reloads with "Invitation accepted. The business is now in your list." Sign-out drops the pending token.
- Test updates: `client-safety` now allows `.hash` only in `invitation-link.ts`. The existing checks still find no
  `localStorage`, `sessionStorage`, `indexedDB` or cookies in `src/`.

## Mobile

- `src/devices/device-credential-store.ts` is the only module that imports `expo-secure-store` (enforced by
  `client-safety`):
  - one entry per business, keyed `tali.device.v1.<businessId>` (lowercase UUID required);
  - the value is JSON `{deviceId, credential}` only, parsed strictly (malformed entries are ignored);
  - `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`;
  - the module never references the access token.
- `app.config.ts`: the `expo-secure-store` plugin uses `configureAndroidBackup: true`, which excludes SecureStore
  data from Android backup, and `faceIDPermission: false`.
- Session store:
  - `registerDevice(label)` uses one idempotency key per attempt. It saves the credential to the keystore
    **before** using it. A replay (`credentialAvailable: false`) reports "credential unavailable" and stores nothing.
  - Business-scoped reads attach `X-Tali-Device-Id` and `X-Tali-Device-Credential` only when the stored
    registration belongs to the selected business.
  - On `DEVICE_NOT_TRUSTED`, the store clears the entry (only if its device ID still matches), sets `untrusted`, and
    shows "This device needs to be registered again." It does not re-register automatically.
  - Sign-out keeps the registration (it is Business-scoped device trust, not user authentication). The access
    token stays in memory only.
- `DevicePanel` appears on Android only. `session-context.tsx` uses the SecureStore-backed store only when
  `Platform.OS === "android"`; iOS gets `noDeviceCredentialStore`, shows no registration and does not crash.
- `AcceptInvitationPanel` ("Join a business") accepts a pasted link or code (`parseInvitationInput`), clears the
  field on submit, and posts `{ token }`.
- Tests mock `expo-secure-store` with an in-memory map. The device store is never exercised against the real
  keystore in CI.

### Secure-storage dependency review

- Package: `expo-secure-store` 57.0.4, the first-party Expo module that `expo install` selects for SDK 57. It is
  pinned exactly like the other Expo modules. The lockfile adds only this package; nothing else moved.
- Why: plan 003 section 6 names secure storage for the device credential as a reviewed Slice 5 dependency. It uses
  the Android Keystore (and the iOS Keychain), so there is no hand-written crypto.
- Scope: only `apps/mobile/src/devices/device-credential-store.ts` may import it (`client-safety` test). It is not in
  `packages/shared` or any other package. It never stores the access token.
- Configuration: excluded from Android backup; no Face ID permission; `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

### Android and iOS boundary

The device platform is `ANDROID` only (domain, contract and database CHECK). iOS runs the same JavaScript: the
device panel is hidden, the keystore is never touched, and invitation acceptance still works. The iOS JavaScript
export succeeds. No iOS native build was made.

## Test results

| Suite | Result |
| --- | --- |
| domain | 157 passed |
| application | 261 passed (new: invitations 21, manage-membership 15, devices 12) |
| integrations | 82 passed |
| shared | 28 passed |
| API unit and compat | 52 passed |
| web (Vitest) | 7 files, 86 passed (new `invitations.test.tsx`, 18) |
| mobile (jest-expo, via `pnpm verify`) | 14 suites, 201 passed (new `devices-invitations.test.tsx`) |
| config 24, worker 11, database 13, text-integrity 12, client-bundle-check 5 | passed |
| database integration | 19 files, 221 passed |
| API integration | 87 passed, 1 skipped (new `team-devices-api.integration.test.ts`, 12) |
| worker integration | 9 passed, 1 skipped |
| Playwright | 10/10 (new `e2e/invitation.spec.ts`) |

### Concurrency (real PostgreSQL)

- Concurrent creates with one key: one invitation and one token; the other call replays without the token.
- The same user accepting one token concurrently: one membership; the other call replays.
- Two users racing for one token: exactly one joins; the other gets `NOT_FOUND`.
- An accept waiting on a revoke that holds the lock re-reads the invitation as REVOKED.
- Concurrent device revokes: one change and one audit record.
- The last active owner cannot be suspended or demoted, and no audit record is written. The Slice 2 two-owner race
  test still passes.

### API security (`team-devices-api.integration.test.ts`, `tenancy-authorization.integration.test.ts`)

- Invitation flow: `no-store`, replay without token, accept, replayed accept, and the picker showing the business.
- A uniform 404 for unknown, malformed, expired, revoked, and other-user-accepted tokens; 409 for existing members
  (invitation stays PENDING); 429 on the 11th accept within a minute.
- Permission denials (403) for non-owners; other-tenant resources are 404; missing `Idempotency-Key` is 400.
- Role change, suspend and reactivate with audit counts; last-owner 409.
- Rename: trimmed; a no-op writes no audit record; the payload has no name text.
- Device headers:
  - trusted headers attribute audit records to the device;
  - five fail-closed variants (wrong credential, ID only, credential only, malformed ID, unknown ID) are 403
    `DEVICE_NOT_TRUSTED`, and the body never contains the credential;
  - business A's device presented by a member of business B on business B is 403; an outsider presenting it on
    business A still gets 404;
  - without authentication the request is 401 (a device never authenticates);
  - `/v1/me` ignores the headers.
- The tenancy matrix covers every new business route: a member of business A never gets anything but 404 on
  business B, and own-business routes never answer 401 or 403.

### Playwright (`e2e/invitation.spec.ts`)

- The owner creates a business and an invitation link: the response is 201 with `no-store`, and the link starts
  with `<web origin>/invitations/accept#token=`.
- The invitee opens the link in a fresh browser context, and the URL becomes exactly `/invitations/accept`.
- Cookies, `localStorage`, `sessionStorage`, IndexedDB, `history.state` and the page content contain no token.
- After sign-in and registration, the accept request body is exactly `{ token }`; the notice appears and the
  business is listed with the role Cashier.

Invalid, expired and revoked invitations are not repeated in Playwright. They are covered against the real API and
PostgreSQL in the API integration suite, and in the web component tests for the messages shown.

## Dependency boundaries

`pnpm run boundaries` reports no violations (449 modules, 1826 dependencies). `packages/domain` and
`packages/application` stay framework-free; the crypto adapters live in `packages/integrations`; Prisma stays in
`packages/database`. Web and mobile still cannot import application, database, integrations, server config,
Node.js built-ins, jose, the AWS SDK or Cognito SDKs. No rule was weakened.

## Verification

| Check | Result |
| --- | --- |
| text integrity, format, build, lint, typecheck, boundaries (449 modules, 1826 dependencies, no violations), all unit tests (`pnpm verify`) | exit 0 |
| `pnpm test:integration` | exit 0 |
| Playwright | 10/10 |
| Expo Android export plus client-bundle check (web 38 files, Android 29 files, app config 1 file; 30 needles each, including `tali_inv_` and `tali_dev_`) | clean |
| Expo iOS JavaScript export | succeeded; the bundle contains no one-time-secret prefix |
| Migration from an empty database (`migrate deploy` of all 5 migrations into a new database, then `db:verify-schema` and `migrate status`) | PASS, up to date; scratch database dropped |
| `db:verify-schema` on the local database; `db:drift` | PASS; no drift |
| gitleaks v8.30.1 (Docker): `git` over history (13 commits) and `dir` over a copy of all 115 changed and untracked files | no leaks |
| New gitleaks rules `tali-invitation-token` and `tali-device-credential` | fire on a random `tali_inv_` token; ignore a low-entropy `tali_dev_` fixture |

### Web Vitest worker-start failure recurred

The first two `pnpm verify` runs failed only in `@tali/web#test`: every web test file failed before running with
`[vitest-pool]: Failed to start forks worker`, while Turbo ran other packages' tests in parallel and the machine
was also running many unrelated Docker containers. No test ran, so no assertion failed. The web suite passed alone
(7 files, 86 tests) and in the third `pnpm verify`, which exited 0. This is the host-saturation failure analysed in
`docs/audits/build-1-slice-3.md`. As instructed, the Vitest config was not changed.

## Deviations from ADR-002/004/005/006 and Plan 003

- **`BusinessContextGuard` validates only `businessId`** (Slice 3 defect fix, described above). No ADR is affected.
- **The web lists only invitations created in the current session.** Plan 003 has no ListInvitations endpoint, and
  adding one would expand the backend beyond the plan.
- **The web invitation panel is shown only to owners** as a convenience; `member:invite` is enforced server-side.
- **SecureStore data is excluded from Android backup** so a device credential is not restored onto another phone.
  This tightens ADR-005 section 15 and does not change it.
- **Owners reach member management through the API only.** Plan 003 section 7 lists invitations as the P1 web
  screen; there is no role or suspension UI yet.
- `last_seen_at` is deferred (ADR-005 section 15.4), as the plan states.
- No deviation from ADR-002, ADR-004, ADR-005 or ADR-006. No material conflict was found.

## Risk

- **Tenancy.** Every new query is scoped by the context business. Invitations are the one lookup that starts
  from a secret rather than a business, and the business comes from the invitation row, never from the client. The
  composite foreign keys make cross-tenant references impossible at the database. Tests prove A-cannot-touch-B
  for every new route.
- **Bearer secrets.** Invitation tokens and device credentials are bearer secrets: anyone holding a token within
  72 hours can join as the invited role, and anyone holding a device credential *and* a valid user session in that
  business can present that device. Mitigations: 256-bit entropy, digest-only storage, single use, revoke, fragment
  links, no-store, redacted logging, secret-scanner rules and prefixes. Delivery is manual, so the owner must share
  the link over a trusted channel.
- **Device trust is supplemental.** A device never authenticates a user, and nothing in Build 1 requires a device.
  Failing closed means a revoked or stale credential blocks business reads on that phone until the user registers
  again; that is the intended behaviour.
- **Persisted client secret.** The device credential is the first secret intentionally kept across restarts. It
  lives in the Android Keystore-backed SecureStore, is excluded from backup, is readable only when unlocked, and
  survives sign-out by design. On a shared phone, a later user of the same business presents the same registration
  alongside their own session. This matches ADR-005 (devices belong to the business, not to a user).
- **Rate limiting** of acceptance is in-process only; distributed limiting waits for ADR-003 or an edge decision.
- **Replay of a lost secret.** If a create or register response is lost, the retry replays without the secret. The
  recovery is to revoke and create or register again. The web and mobile UIs say so.

## Anything blocking Slice 6

Nothing in Slice 5 blocks Slice 6 technically. Slice 6 (Cognito) remains **blocked on ADR-003** and was not started.
