# Build 1 Slice 6: Cognito identity adapter, web and mobile Cognito clients (COMPLETE)

- Date: 2026-09-30 (started); finalized 2026-10-05
- Status: **COMPLETE (2026-10-05).** The server adapter, the web Cognito client and the mobile Cognito client
  (ADR-007, accepted 2026-09-30) are implemented and verified in automated tests. Every required ADR-007 section 11
  reference-Android hardware gate passed on the repaired debuggable `com.tali.mobile` development APK (see "Reference
  Android device evidence"). The temporary device diagnostics and all of their exemptions are removed. This is not a
  claim of production Android or iOS release readiness (see "Not verified (limits)").
- Scope: Slice 6 of `docs/plans/003-build-1-identity-tenancy.md`, under ADR-001 to ADR-007 (all ACCEPTED): the
  `CognitoIdentityProvider` adapter with JWKS verification, configuration, API composition, and the web and mobile
  sign-up, sign-in, refresh and sign-out flows.
- Not in this step: any AWS resource, CDK, CloudFormation, Terraform, User Pool, deployment workflow, GitHub
  `id-token` permission or AWS credential. Forgot-password, MFA, passkeys and other additional challenges are not
  implemented. No schema change was needed. iOS is exported as JavaScript only and is not native-verified.
- Money: **not touched**. No financial, ledger or inventory code changed. The change touches **authentication,
  tenancy resolution, browser and mobile session handling, on-device credential storage and the client-bundle safety
  check**; see the risk section.
- Dependencies added: `aws-amplify` **6.22.1** in `apps/web`; `aws-amplify` 6.22.1, `@aws-amplify/react-native`
  1.3.3, `react-native-get-random-values` 1.11.0, `@react-native-async-storage/async-storage` 2.2.0 and
  `expo-dev-client` 57.0.19 in `apps/mobile` (all pinned exactly; see "Mobile dependency review"). No existing
  dependency was upgraded. The lockfile
  diff adds entries; its only removals are peer-suffix re-resolutions of already-locked packages at unchanged versions.

## Summary

| Area                                                                                 | Result                         |
| ------------------------------------------------------------------------------------ | ------------------------------ |
| `CognitoIdentityProvider`: RS256, issuer, `client_id` allowlist, `token_use=access`  | PASS (27 unit tests)           |
| JWKS fetch: trusted URL only, timeout, size and key caps, rate-limited refresh       | PASS                           |
| API composition with `IDENTITY_PROVIDER=cognito` against a synthetic JWKS            | PASS (integration)             |
| Groups and custom claims never grant roles or select a business                      | PASS (integration)             |
| Deployed environments refuse incomplete Cognito configuration and any JWKS override  | PASS (integration)             |
| Web SRP sign-in, sign-up, confirm, resend through `aws-amplify` (real library)       | PASS (Vitest, fake Cognito)    |
| Refresh through `GetTokensFromRefreshToken` with rotation, single-flight             | PASS                           |
| Sign-out (`RevokeToken`) and sign-out everywhere (`GlobalSignOut`)                   | PASS                           |
| Tokens memory-only; nothing in localStorage, IndexedDB or cookies; reload signs out  | PASS (Playwright, real build)  |
| Passwords never in requests to Tali, storage, cookies, URLs or console               | PASS (Vitest + Playwright)     |
| Local auth unchanged (local environment only)                                        | PASS (existing suites)         |
| Mobile: complete Amplify session in SecureStore through a Tali opaque chunked adapter | PASS (Jest, 49 adapter tests)  |
| Mobile: storage installed before `Amplify.configure`; nothing ever in AsyncStorage   | PASS (Jest, real Amplify)      |
| Mobile: SRP, restore after restart, rotation, single-flight, revoke, global sign-out | PASS (Jest, fake Cognito)      |
| Mobile: only the access token reaches the Tali API; Device registration kept         | PASS (Jest, full UI)           |
| Mobile: on the reference Android device (repaired debug APK)                         | PASS (every ADR-007 gate)      |
| Client bundles free of server variable names, canaries and secret prefixes           | PASS (after the scanner fixes) |
| `pnpm verify`                                                                        | exit 0                         |
| `pnpm test:integration`                                                              | exit 0                         |
| gitleaks (CI-equivalent `git` scan including all changed files)                      | no leaks                       |

## Server adapter

- Location: `packages/integrations/src/aws/cognito/` (`cognito-jwks.ts`, `cognito-identity-provider.ts`, and
  `testing.ts` for the synthetic pool). It implements the `IdentityProvider` port; no AWS SDK and no Cognito code
  reach `packages/application` or `packages/domain` (lint and dependency-cruiser rules).
- Verification uses `jose` 6.2.12 (already a dependency):
  - algorithm **RS256 only**; a `kid` is required and must match a published key;
  - issuer `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` and the JWKS URL are derived from
    configuration, never from the token;
  - `token_use` must be `access` (ID tokens are refused); `client_id` must be one of the configured web or mobile
    client IDs;
  - `exp`, `iat` and `auth_time` are checked with 30 seconds of clock skew; lifetimes over 24 hours are refused;
  - `sub` must be a UUID. Only the subject is used. `cognito:groups`, `custom:*` attributes, email and every other
    claim are ignored, so roles and business selection still come from Tali's database only (ADR-003).
- JWKS cache: 3 second fetch timeout, 64 KiB body limit, at most 10 keys, at most one refresh per 60 seconds
  however many unknown `kid`s arrive, and 5 seconds of backoff after a failed fetch.
- Every failure becomes `AuthenticationError("Invalid access token")`, so the API gives one identical 401 for a
  bad signature, wrong issuer, wrong client, ID token, expiry or an unpublished key. Logs carry no token, subject,
  email, claim or Authorization header (asserted in the integration test).
- Composition (`apps/api/src/composition/api-runtime.ts`): the `cognitoJwksFetch` replacement exists for tests and
  is accepted only in `local` and `test`; a deployed environment refuses to start with it. Startup also refuses an
  empty pool, empty client IDs or a pool from another region, naming the key.
- Tests use RSA key pairs generated in memory at test time. No private key is committed. Nothing contacts
  `amazonaws.com`, a real JWKS or the AWS metadata service.

## Web Cognito client

### Dependency audit

- `aws-amplify` **6.22.1**, Apache-2.0, published by AWS. It pins `@aws-amplify/auth` 6.21.1 and
  `@aws-amplify/core` 6.19.2. Tali imports only the public entry points `aws-amplify`, `aws-amplify/auth`,
  `aws-amplify/auth/cognito` and `aws-amplify/utils`. `@aws-amplify/*` and `amazon-cognito-identity-js` are never
  imported or declared (ESLint, dependency-cruiser and `client-safety.test.ts`).
- Amplify is imported only under `apps/web/src/lib/auth/cognito/` and is loaded lazily (dynamic import on first
  use), so local-auth builds do not execute it. Mobile, the API, the worker and every package are forbidden from
  importing it.
- Rejected: `amazon-cognito-identity-js` (legacy, refresh via `REFRESH_TOKEN_AUTH`), direct use of
  `@aws-amplify/auth` or `@aws-amplify/core` (internal packages), and hand-written SRP.

### Behaviour

- Sign-in is SRP (`USER_SRP_AUTH`); the password never leaves the browser and is never sent to Tali. Sign-up uses
  email and a confirmation code. `USER_PASSWORD_AUTH` and `REFRESH_TOKEN_AUTH` are not used anywhere; no built
  chunk contains `REFRESH_TOKEN_AUTH`.
- Token storage: `MemoryKeyValueStorage` (a `Map`) is set through `cognitoUserPoolsTokenProvider.setKeyValueStorage`
  after `Amplify.configure`. Access, ID and refresh tokens therefore live only in memory, and a page reload signs
  the user out.
- Tali sends only the **access token** to its API. Refresh uses `GetTokensFromRefreshToken` with refresh-token
  rotation, single-flight (concurrent requests share one refresh), and each refresh uses the latest rotated token.
- Outcomes are bounded: a refused refresh ends the session; a network failure is reported as "unavailable" and the
  session stays signed in for a retry; a 401 from the API ends the session. Error text shown to users comes from a
  fixed list, never from AWS messages.
- Sign-out calls `signOut()` (revokes the refresh token through `RevokeToken`); "Sign out on all devices" calls
  `signOut({ global: true })` (`GlobalSignOut`). Local tokens are cleared even when the network call fails. Ending an
  older session never affects a newer one.

### Amplify's temporary sign-in workflow state (accepted deviation, option A)

The spike found that Amplify keeps its own sign-in workflow state (username, challenge name, challenge session and
expiry) in the browser's sessionStorage while an SRP sign-in or challenge is in progress. This cannot be redirected
through any public API. It contains no token and no password. The user chose option A with conditions; this audit
records them:

- **Temporary Amplify SRP/challenge workflow state may use sessionStorage; authenticated Cognito tokens remain
  memory-only; this is a deviation from the stricter implementation prompt, not from ADR-003; no application code
  depends on Amplify's internal storage keys.**
- Tali does not read, parse, modify or delete Amplify's undocumented storage keys, and writes no authentication
  state of its own to sessionStorage, localStorage, IndexedDB or cookies.
- After an ordinary successful sign-in, Amplify clears that state. The Playwright suite proves sessionStorage is
  empty, and that no token or password is in localStorage, sessionStorage, IndexedDB, cookies, page content, URLs or
  the console. A reload loses the session.
- **Unsupported additional challenge** (for example MFA or a new-password requirement): Tali does not interpret
  Amplify's state. It fails safely with the fixed message "This account needs an extra sign-in step that this
  version of Tali cannot complete. Contact Tali support." The challenge session and AWS internals are never shown.
  **Amplify may retain its temporary sign-in workflow state in sessionStorage until that flow completes or expires**
  (Amplify uses a 3-minute expiry). It holds no token or password.
- After sign-out and after sign-out everywhere, the browser holds no token material (Playwright).
- ADR-007 stays mobile-only; the accepted web token policy (ADR-003) is satisfied.

### Tests

- `apps/web/test/amplify-cognito.test.ts` (13 tests) runs the **real** Amplify library against `FakeCognito`, an
  in-process stand-in for the Cognito endpoint that serves only `cognito-idp.eu-west-1.amazonaws.com` and records
  every request and any other host it is asked for (none). It covers SRP with no password on the wire, the access
  token (not the ID token), no browser storage, wrong password, unconfirmed account, unsupported challenge, sign-up,
  confirm and resend, single-flight rotating refresh, refused and failed refresh, revoke with the latest refresh
  token, global sign-out, offline sign-out and session generations.
- `apps/web/test/cognito-onboarding.test.tsx` (15 tests): the session store with Cognito sessions (per-call tokens,
  ended and unavailable sessions, 401 handling, sign-out everywhere, one session at a time, disabled users) and the
  sign-in UI.
- `apps/web/e2e-cognito/cognito.spec.ts` (5 Playwright tests) runs a production build in Cognito mode (`staging`
  configuration with synthetic public values) and routes Cognito and the API inside the browser, refusing every
  other origin.
- `apps/web/vitest.config.ts` raises `testTimeout` to 15 seconds: the SRP tests are CPU-heavy, and under the
  parallel load of `pnpm verify` some existing invitation UI tests exceeded the default 5 seconds (they pass alone).

## Configuration

- `AUTH_MODE` (`local` or `cognito`) is a public web value. A deployed web build without Cognito configuration is a
  configuration error. Local sign-in is offered only when the environment is `local` and the mode is `local`.
- Mobile: `EXPO_PUBLIC_AUTH_MODE` (`local` or `cognito`) is the same public value, with
  `EXPO_PUBLIC_COGNITO_REGION`, `EXPO_PUBLIC_COGNITO_USER_POOL_ID` and `EXPO_PUBLIC_COGNITO_CLIENT_ID`.
  `loadMobilePublicConfig` and `validateMobileBuildEnvironment` now return a `MobilePublicConfig` with `authMode`,
  and a deployed (`development`, `staging`, `production`) mobile build without complete Cognito configuration is a
  configuration error, as on the web. In `test` without Cognito configuration the mode is `unavailable` and no
  sign-in is offered. Local sign-in is unchanged and still requires `local` environment and `local` mode.

## Client-bundle check finding

The first full run of `tooling/client-bundle-check` failed: a web chunk contained the server variable name
`LOG_LEVEL`. That chunk is Amplify's `ConsoleLogger`, which reads its own static properties
(`ConsoleLogger.LOG_LEVEL`, `window.LOG_LEVEL`, `ConsoleLogger.BIND_ALL_LOG_LEVELS`). It is not Tali's
configuration, and the injected canary value was absent.

Resolution (`tooling/client-bundle-check/src/policy.mjs`, `THIRD_PARTY_IDENTIFIERS`): those two property-access
forms are masked before scanning, and nothing else is. A quoted `"LOG_LEVEL"`, a `LOG_LEVEL:` object key,
`process.env.LOG_LEVEL`, and every canary value are still reported; `scan.test.ts` proves each case. After the
change, the web build (test and Cognito modes), the Expo Android export and the embedded mobile configuration all
scan clean.

### Second finding (mobile Cognito client)

With Amplify in the mobile app, the scan of the Android Hermes bundle reported `LOG_LEVEL` and `SERVICE_NAME`; the
canary values were absent. The strings were Amplify's: Hermes stores its string table with shared bytes, so
`LOG_LEVEL` appeared only inside `BIND_ALL_LOG_LEVELS`, and `SERVICE_NAME` only inside the CommonJS exports
`COGNITO_IDENTITY_SERVICE_NAME` and `COGNITO_IDP_SERVICE_NAME` (React Native resolves Amplify's CommonJS build).

A mask cannot safely apply to bytecode: because bytes are shared, it could hide a Tali name. The fix
(`tooling/client-bundle-check`, **needs human review** as a change to safety tooling):

- the check now exports the Android **and iOS** bundles twice: as JavaScript (`--no-bytecode`), scanned for names and
  values with the masks; and as Hermes bytecode (the shipped form), scanned for **values only** (canaries,
  placeholder secrets, one-time secret prefixes) with **no** masks;
- one new mask, `.COGNITO_IDENTITY_SERVICE_NAME` / `.COGNITO_IDP_SERVICE_NAME` as property accesses only. A quoted
  `"SERVICE_NAME"`, an object key, `process.env.SERVICE_NAME`, `e.SERVICE_NAME`, a longer identifier and any canary are
  still reported (`scan.test.ts`, 8 tests).

After the change, the web output, the mobile JavaScript export (37 files), the mobile Hermes export (37 files) and the
embedded mobile configuration scan clean. A separate Cognito-mode Android and iOS Hermes export with synthetic public
values contains the region, pool ID, client ID and API URL (allowed public values), `USER_SRP_AUTH` and
`GetTokensFromRefreshToken`, and contains no `REFRESH_TOKEN_AUTH`, no `amazon-cognito-identity-js`, no test password
and no forbidden value.

## Boundary guards

- ESLint (`tooling/eslint/index.mjs`):
  - string literals and template text starting with `cognito:` or `custom:` are banned outside tests, so claims
    cannot be read;
  - Amplify is banned everywhere except `apps/web/src/lib/auth/cognito/**` and
    `apps/mobile/src/auth/cognito/amplify-cognito-auth.ts` (plus the single test file that spies on its
    initialization order, `apps/mobile/test/amplify-init-order.test.ts`; no directory-wide exemption), which may import
    only the public `aws-amplify` entry points; `@aws-amplify/*` (including
    `@aws-amplify/react-native`) and `amazon-cognito-identity-js` stay banned there;
  - all mobile code is banned from importing `@react-native-async-storage/*`, `react-native-get-random-values` and
    `@react-native-community/netinfo`.
- dependency-cruiser (`.dependency-cruiser.cjs`): `mobile-amplify-only-in-cognito-module` (replaces
  `mobile-no-cognito-client`), `mobile-no-amplify-runtime-peers`, `web-amplify-only-in-cognito-module`,
  `server-no-cognito-client`, and the client identity-SDK rule extended to `@aws-amplify` and
  `amazon-cognito-identity-js`.
- `apps/mobile/test/client-safety.test.ts` additionally checks: exact pins; `@aws-amplify/auth`, `@aws-amplify/core`
  and `@aws-amplify/ui-react-native` are not resolvable from the app; no mobile source mentions AsyncStorage;
  SecureStore is used only by the Device credential store and the Cognito storage adapter; the two namespaces are
  disjoint; and the storage adapter contains no Amplify key name and no key-content matching (ADR-007 section 9).
- Temporary probe files confirmed each ban fires; they were deleted.

## Mobile

- **ADR-007 ACCEPTED (2026-09-30)** by the human maintainer
  (`docs/decisions/ADR-007-mobile-cognito-session-persistence.md`, mobile only). The accepted design is Option B:
  the complete Amplify-managed Cognito session is stored in Expo SecureStore, through Amplify's public
  `KeyValueStorageInterface` and a Tali adapter that treats keys and values as opaque and uses a versioned
  manifest-and-chunk format. No Cognito data may go to AsyncStorage. The Cognito and Device namespaces stay separate.
  ADR-007 partially supersedes only the mobile persistence wording of ADR-003 section 14.4.
- **Mobile Cognito client: implemented, verified in automated tests, and verified on the reference Android device**
  with the repaired debug APK (2026-10-03 to 2026-10-05; see "Reference Android device evidence"). When this section
  was first written no device was attached. ADR-007 section 11 preconditions 1 to 6 are met. Precondition 7 (iOS) is
  outside Build 1 acceptance.

### Mobile dependency review (ADR-007 section 11.1)

Direct dependencies of `apps/mobile`, pinned exactly. None requests an Android permission (empty library manifests),
except `expo-dev-client` in debug builds only (see "Android development build").

| Package                                     | Version | License    | Native code                                                  | Why required                                                                                                                                         | Tali imports it | Stores data                                                                                   |
| ------------------------------------------- | ------- | ---------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------- |
| `aws-amplify`                               | 6.22.1  | Apache-2.0 | none                                                         | The Cognito client (SRP, `GetTokensFromRefreshToken`, revocation); same version as the web                                                           | yes, only `amplify-cognito-auth.ts`, entry points `aws-amplify`, `aws-amplify/auth`, `aws-amplify/auth/cognito`, `aws-amplify/adapter-core` | through the Tali adapter only (below)                                                          |
| `@aws-amplify/react-native`                 | 1.3.3   | Apache-2.0 | `AmplifyRTNCore` (Android, iOS podspec): native SRP big-integer maths and device name | Amplify's documented React Native support package; `aws-amplify` loads it on React Native for SRP and platform services                             | no (lint, depcruise) | no                                                                                            |
| `react-native-get-random-values`            | 1.11.0  | MIT        | Android and iOS module                                        | Required peer of `@aws-amplify/react-native`: cryptographically secure random values for SRP                                                        | no (lint, depcruise) | no                                                                                            |
| `@react-native-async-storage/async-storage` | 2.2.0   | MIT        | Android and iOS module (`PrivacyInfo.xcprivacy` included)     | Imported by `@aws-amplify/react-native` for Amplify's default storage; must be installed for Amplify to load (ADR-007 section 6.2)                  | no (lint, depcruise, client-safety) | **no Cognito data**: zero calls, not even reads, in every Tali flow (below) |
| `expo-dev-client`                           | 57.0.19 | MIT        | Android debug variant only: dev launcher and dev menu (below) | Development builds load JavaScript from Metro; the version Expo 57.0.25 expects (`~57.0.19`), added with `expo install` and pinned exactly       | no              | no                                                                                            |

Transitive additions (lockfile): `base-64` 1.0.0, `buffer` 5.7.1 and 6.0.3, `react-native-url-polyfill` 3.0.0,
`whatwg-url-without-unicode` 8.0.0-3, `fast-base64-decode` 1.0.0, `merge-options` 3.0.4 and `is-plain-obj` 2.1.0 (all
MIT, no native code), and `webidl-conversions` 5.0.0 (BSD-2-Clause, no native code). Not installed:
`@react-native-community/netinfo`, `@aws-amplify/rtn-passkeys` (optional peer; passkeys are not offered) and
`@aws-amplify/ui-react-native` (Tali has its own UI). `@aws-amplify/auth` and `@aws-amplify/core` are not resolvable
from the app (client-safety test). `expo install --check` reports only pre-existing patch drift, which was not
upgraded.

### Storage installation order (ADR-007 section 6.3)

`apps/mobile/src/auth/cognito/amplify-cognito-auth.ts` is the single boundary. `AmplifyCognitoAuth.configure` runs
once per JavaScript runtime:

1. `cognitoUserPoolsTokenProvider.setAuthConfig(authConfig)`;
2. `cognitoUserPoolsTokenProvider.setKeyValueStorage(inertTaliAdapter)`: a Tali adapter that keeps nothing;
3. `Amplify.configure({ Auth: authConfig }, { Auth: { tokenProvider: cognitoUserPoolsTokenProvider } })`.

No session runs through this process-wide context; it exists so that Amplify never selects its default persistent
store, even for a call that reached it by mistake. Each session (a restoration, a sign-in, or the end of a leftover
session) runs in its own context:

- `createUserPoolsTokenProvider(authConfig, lease)` (`aws-amplify/adapter-core`) builds a token provider and
  orchestrator over that session's lease of the SecureStore adapter;
- `createAmplifyContext({ Auth: authConfig }, { Auth: { tokenProvider } })` (`aws-amplify`) is passed as the first
  argument to `signIn`, `fetchAuthSession` and `signOut`. With a token provider supplied, Amplify injects no
  default provider.

The storage is installed when the provider is created, before any operation of that session. Sign-up, confirmation
and resend store nothing and use the process-wide context. No credentials provider (identity pool) is configured.
The app loads this module only on the first Cognito operation (`lazyCognitoAuth`), so a local-mode build never
executes Amplify. Public Amplify APIs only.

AsyncStorage evidence (`apps/mobile/test/amplify-cognito.test.ts` and `apps/mobile/test/amplify-init-order.test.ts`,
the real Amplify library, a recording AsyncStorage double): after **every** test, AsyncStorage received zero calls,
writes or reads. The flows covered are startup, restoration after restart, sign-up, confirmation, resend, sign-in,
refresh, rotation, refused and unreachable refresh, sign-out, global sign-out, offline and hanging sign-out, staff
switching and every stale-operation race (below). The first storage access of a session goes to the Cognito
SecureStore namespace. Two control tests prove the double would see a leak:

- **detector**: Amplify configured without Tali storage writes the session, refresh token included, to AsyncStorage;
- **reversed-order regression**: `Amplify.configure` first and the Tali storage installed afterwards lets Amplify
  reach AsyncStorage before Tali storage exists.

Amplify's temporary SRP workflow state falls back to memory on React Native (no browser sessionStorage). No Cognito
material was written outside the Cognito SecureStore namespace in any test.

### SecureStore adapter (ADR-007 sections 5, 6 and 9)

`apps/mobile/src/auth/cognito/secure-cognito-storage.ts` implements Amplify's `KeyValueStorageInterface`; it imports
no Amplify code.

- **Opaque**: keys and values are never interpreted, matched or logged. An entry's storage identifier is the first
  128 bits of SHA-256 over the namespaced Amplify key (hex, via `expo-crypto`). It is kept only inside the index and
  manifest, so key text (which may contain a username) never becomes a keystore item name. A client-safety test fails
  if the module contains an Amplify key name or key-content matching.
- **Format v1**, namespace `tali.cognito.v1.` (the Device namespace is `tali.device.v1.`; disjoint, tested). Every
  item name the format can use is fixed in advance (`COGNITO_ITEM_NAMES`, 397 names):
  - an index (`index`) recording, per entry, its storage identifier, its slot (0 to 11), its committed generation
    and chunk count, and at most one pending write. It has at most 12 entries, so it always fits one chunk;
  - per slot, a manifest (`m.<slot>`: version, storage identifier, generation, chunk count, total UTF-8 bytes;
    metadata only);
  - chunks `c.<slot>.<generation>.<i>`, generation 0 or 1, of at most **1024 UTF-8 bytes**, split on code points.
    This is well under the roughly 2 KiB at which some iOS versions rejected SecureStore values;
  - at most 16 chunks (16 KiB) per value, several times the largest Cognito token.
- **Safe replacement**: each write uses the generation the entry does not currently use:
  1. record the pending write in the index;
  2. write the chunks;
  3. switch the manifest;
  4. delete the old generation;
  5. settle the index.

  Interruption at each step is tested: the reader sees the old value or the new one, never a mix, and the next
  operation removes orphans. Operations are serialised in call order.
- **Fails closed**: if anything is inconsistent, the namespace is cleared and the read returns nothing. That covers an
  unknown version, a missing, extra, oversized or malformed chunk, a wrong length, malformed UTF-16, a manifest that
  disagrees with the index (another entry, the other generation, other counts), an unreadable index or manifest, and
  an entry the index does not list. A partial session is never returned.
- **Clearing does not depend on the index.** `clear()` deletes every name of the fixed list: chunks and manifests
  first, the index last. SecureStore cannot list its items, so this layout was redesigned in this slice (it is not
  a released format): the earlier layout named items by digest with unbounded generations, and could not be cleared
  once its index was lost. If any deletion fails, `clear()` fails and keeps the index, so the namespace is not
  reported empty and the next sign-in does not start (ADR-007 section 7.3). A namespace with no index but a manifest
  left counts as not empty, and its next write clears it first. Tested: several entries, a multi-chunk value, an
  interrupted replacement (an orphan generation) and an interrupted first write; then the index deleted, not JSON,
  of an unknown version, valid but empty, or valid but wrong. In every case a fresh runtime's `clear()` removes every
  Cognito item and only Cognito items, and the Device registration is unchanged.
- **Leases**: each session reaches the adapter through its own lease. A frozen lease reads but writes nothing; a
  revoked lease reads nothing and writes nothing. Creating a lease revokes the previous one. The state is checked
  when a queued operation runs, not when it was requested.
- Clearing the Cognito namespace never touches Device registrations, and clearing those never touches it.
- **Options**: every item uses `keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
  - **iOS**: never migrated through backup or to another device. Keychain items **may survive an uninstall and
    reinstall** (ADR-007 section 8); handling that is an iOS production-readiness item.
  - **Android**: Keystore encryption. The existing backup exclusion (`configureAndroidBackup: true`) is unchanged.
- **Largest values**: the largest value in the tested flows is the synthetic refresh token (about 1.8 KB, two chunks).
  The adapter tests also round-trip byte-for-byte:
  - multibyte and emoji text;
  - values one byte below, at and one byte above the chunk boundary;
  - characters straddling a chunk boundary;
  - values above 2 KiB, of 15 KiB and of exactly the 16 KiB bound;
  - realistic synthetic access, ID and refresh tokens.

### Session behaviour

- **Sign-in and sign-up**: `USER_SRP_AUTH`; sign-up, confirmation and resend by email code. The password field is
  masked (`secureTextEntry`, no autocorrect). The password is cleared after every submit and is never stored,
  logged, put in a URL or sent to Tali (asserted on every request in the UI tests).
- **Not offered**: forgot-password, MFA and passkeys. Any further sign-in step is refused with a fixed message, and
  nothing of it is kept.
- **Restore**: the app restores the session at start from SecureStore alone, also after a full JavaScript restart
  (`jest.resetModules`). If Cognito is unreachable during restoration, the user sees a retryable "unavailable" state
  with "Try again" and "Sign out".
- **Tokens**: only the **access token** goes to the Tali API. The ID and refresh tokens never do (asserted per
  request).
- **Refresh**: `GetTokensFromRefreshToken` with rotation, and the new refresh token replaces the old in storage.
  `REFRESH_TOKEN_AUTH` is never sent and is absent from the bundles. Refresh is single-flight: concurrent callers
  share one refresh.
- **Refresh failure**:
  - a **definitive** failure (refused refresh, or nothing stored) clears Cognito memory, the SecureStore namespace
    and the Tali session, and keeps the Device registration;
  - a **transient** failure (network) is a retryable "unavailable"; the session and its stored state are kept.
- **Logout**:
  - "Sign out" sends `RevokeToken`; "Sign out on all devices" sends `GlobalSignOut`;
  - waiting for Cognito is bounded (10 seconds) and the namespace is cleared whatever Cognito answers, offline
    included;
  - the Device registration is kept.
- **Staff switch**: signing in first revokes and clears any leftover stored session. The next staff member's session
  holds nothing of the previous one.
- **Session ownership**: an operation of an ended session never changes a later one. Ending a session:
  1. waits, within the 10-second bound, for an Amplify call still running for it (a refresh may rotate the refresh
     token, and the rotated one is the one to revoke);
  2. freezes its lease;
  3. races `signOut` in the session's own context against the same bound;
  4. revokes the lease;
  5. clears the namespace.

  The next sign-in starts only after this. A late `RevokeToken` or `GlobalSignOut` completion (or rejection) then
  reaches only the ended session's own orchestrator and revoked lease: Amplify's `clearTokens` and any refresh write
  are no-ops. A late refresh or restoration result is discarded ("ended" or "none"), and a late definitive failure
  clears nothing. Tests, deterministic through held fake-Cognito requests:
  - staff A signs in and signs out while `RevokeToken` (or `GlobalSignOut`) is held past the bound. Sign-out returns
    within the bound with the namespace empty, staff B signs in, and A's request is then answered or failed. B's
    stored items are byte-identical, B's token carries B's subject, a restart restores B, and the Device
    registration is unchanged throughout;
  - A's refresh is held at sign-out and later succeeds, fails on the network or is refused, after B signed in: same
    result for B;
  - a restoration is held when the stored session is forgotten, B signs in, and the restoration completes: it
    returns "none" and B is unchanged.

  Before this pass, the four revocation cases failed: B's namespace was emptied by A's late completion. The refresh
  and restoration cases hung, because B's sign-in waited on A's refresh through Amplify's process-wide orchestrator.
- **Auth mode**: comes from public configuration only. Local sign-in is unchanged and is offered only for `local`
  environment and `local` mode.

### Mobile tests

| Suite                                          | Tests | Covers                                                                                                   |
| ---------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `apps/mobile/test/secure-cognito-storage.test.ts` | 65 | round trips, opacity, fixed item names, options, bounds, replacement, concurrency, interruption, every corruption case, clearing after index loss, leases, namespaces |
| `apps/mobile/test/amplify-cognito.test.ts`     | 27    | real Amplify against `FakeCognito`: every flow above, the stale-operation races, AsyncStorage zero calls |
| `apps/mobile/test/amplify-init-order.test.ts`  | 5     | initialization order, inert process-wide adapter, first session storage access, detector and reversed-order regression |
| `apps/mobile/test/cognito-onboarding.test.tsx` | 8     | the full app UI with real Amplify, fake Cognito and the fake Tali API: sign-up to business, restore, sign-out, refused refresh |
| `apps/mobile/test/session-store.test.ts`       | +identity-provider sessions | per-call tokens, ended and unavailable sessions, one session at a time                         |
| `apps/mobile/test/client-safety.test.ts`       | updated | pins, resolvability, AsyncStorage and SecureStore usage, namespaces, key-name blindness, Amplify import surface |

`FakeCognito` serves only `cognito-idp.eu-west-1.amazonaws.com` inside the test process and records any other host
(none). No test contacts AWS. The native `AmplifyRTNCore` SRP maths is replaced in Jest by a BigInt double
(`installNativeSrpDouble`); the native module itself is exercised only on a device.

### Android development build (2026-10-01 and 2026-10-02)

**Mismatch found.** The app installed on the reference device (`RFCW1184L4N`) was a release build, not a
development build:

- `com.tali.mobile`, versionCode 1, versionName 0.0.0, not debuggable (`run-as` refused; no `DEBUGGABLE` flag),
  first installed 2026-10-01 09:26:51, last updated 16:54:48;
- the installed `base.apk` (pulled to a temporary directory outside the repository) is byte-identical to the local
  `android/app/build/outputs/apk/release/app-release.apk` built at 16:33 (SHA-256
  `ae1955321c3f8593c15f419b1f2ef0d48c9d3e75b6383a66919a86b66bc43771`);
- `expo-dev-client` was not a dependency, so no build could load JavaScript from Metro.

Cause: the diagnostic instructions given on 2026-10-01 built `--variant release` with
`EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000`. A release build embeds the JavaScript and the public configuration
present at build time. The device therefore showed API port 3000 and "Cognito not configured", although Metro
answered on port 8081 and `apps/mobile/.env.local` holds the public Cognito configuration. These on-device
observations describe that release APK only; they validate nothing about the development build below.

The native project (`apps/mobile/android/`, generated by prebuild on 2026-09-28, git-ignored) was also older than
`app.config.ts`. Its manifest had `allowBackup="true"` but no SecureStore backup exclusions, so the installed APK
lacks them. No file under `android/app/src` had been edited after generation.

**Repair** (no product, authentication or storage change):

- `expo-dev-client` 57.0.19 added (table above). Lockfile: `expo-dev-client` 57.0.19, `expo-dev-launcher` 57.0.20,
  `expo-dev-menu` 57.0.18, `expo-dev-menu-interface` 57.0.0, `expo-manifests` 57.0.2, `expo-updates-interface` 57.0.2
  and `expo-json-utils` 57.0.2, all MIT. No existing version changed; the peer-resolution keys of `@expo/cli` and
  `@expo/log-box` were rewritten.
- Native sync with `expo prebuild --platform android --no-clean --no-install`. It changed only `AndroidManifest.xml`:
  `android:fullBackupContent="@xml/secure_store_backup_rules"`,
  `android:dataExtractionRules="@xml/secure_store_data_extraction_rules"` (from `expo-secure-store`, which excludes
  the `SecureStore` shared preferences from cloud backup and device transfer) and the dev-client scheme `exp+tali`.
  The Gradle files, the signing configuration and `debug.keystore` are unchanged (compared with a snapshot); the
  release build type stays non-debuggable.
- A first sync run without `--no-clean` tried to delete `android/` (Expo CLI 57 cleans by default) and failed with
  `EBUSY`. Nothing was removed: the source file count, keystore hash and APKs were checked afterwards.
- Debug APK built with `gradlew app:assembleDebug` only (JDK 21 from Android Studio, for that shell only):
  `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`, SHA-256
  `a83c55fa965a47ba8c4537992ee7650eee881791975a6abdbbca46c4ed356823`. `com.tali.mobile`, versionCode 1, versionName
  0.0.0, `debuggable=true`, dev launcher activities present, no embedded JavaScript bundle (it loads from Metro),
  cleartext and the `tali` scheme kept, SecureStore backup rules merged.
- Signing: the installed APK, the local release APK and the new debug APK are all signed by `CN=Android Debug`
  (project `debug.keystore`), certificate SHA-256
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`. An in-place update keeps the app data.
- Debug-only additions, reported and not suppressed: `expo-dev-launcher` adds `CHANGE_WIFI_MULTICAST_STATE`, and its
  QR scanner pulls in Google ML Kit `barcode-scanning` 17.3.0, which brings `ACCESS_NETWORK_STATE` and Google's
  `transport-backend-cct` 2.3.3 (ML Kit usage reporting). Both are `debugOnly` dependencies; they reach release
  builds only if `expo.devlauncher.configureInRelease=true` is set, which it is not. A release build was not rebuilt
  to confirm this.

The debug APK was later installed in place (`adb install -r`, app data kept). The on-device results are recorded in
"Reference Android device evidence".

### Metro development-bundle HTTP 500 (2026-10-02)

**Symptom.** The Metro session started at 12:04 with
`pnpm exec expo start --dev-client --host lan --port 8081 --clear` answered `/status`. But the Android development
bundle request
(`/apps/mobile/node_modules/expo-router/entry.bundle?platform=android&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=app&unstable_transformProfile=hermes-stable`)
returned HTTP 500 in 0.06 s with `Cannot read properties of undefined (reading 'get')` at
`metro@0.84.5/src/node-haste/DependencyGraph.js:28` (`getOrCreateMap`).

**Cause (proven from source and logs).**

- That session's first error was `Failed to construct transformer: Error: Failed to start watch mode.`, from
  `@expo/metro-file-map` 57.0.3 `Watcher.js:163`. That is the 240-second `MAX_WAIT_TIME` for a watcher to start.
- On Windows the file map uses `FallbackWatcher`, because `NativeWatcher` supports only macOS. It opens a watch on
  every directory under each watch root.
- `DependencyGraph` assigns `_resolutionCache` only inside `fileMap.build().then(...)`. When `build()` rejected, the
  graph stayed uninitialised, but the server kept accepting requests. Each bundle request then called
  `getOrCreateMap(undefined, ...)`. The `.get` error is therefore a consequence, not the cause.
- That start-up was abnormally slow. In `.expo/dev/logs/start.log` it took 62 s from `root:init` to `devserver:start`
  and 9 min 12 s more to `metro:instantiate`; other sessions take about 1 to 2 min. The reason for the slowness was
  not identified.
- Under the same configuration, Android bundles built in every earlier session that requested one (2026-10-01 09:26,
  12:37 and 14:14).

**Effective configuration.**

- No `metro.config.*` exists in the repository, and `apps/mobile/package.json` has no `metro` or `expo` key. Expo uses
  `expo/metro-config` defaults (`@expo/metro-config` 57.0.12).
- `projectRoot` is `apps/mobile`, and `server.unstable_serverRoot` is the repository root.
- `watchFolders` are the root `node_modules` and every workspace package (15 roots).
- `nodeModulesPaths` are `apps/mobile/node_modules` and the root `node_modules`; hierarchical lookup is enabled.
- `blockList` is Expo's default.

**Resolved packages.**

- The running Expo CLI is `@expo/cli` 57.0.27, using `@expo/metro` 56.0.2, `metro` 0.84.5 and `@expo/metro-file-map`
  57.0.3.
- `metro` 0.84.6 belongs to `@react-native/community-cli-plugin`, which `@expo/cli` never loads (two source comments
  only). Only 0.84.5 is on the failing path.

**Measurements** (diagnostic scripts outside the repository):

- The watch roots hold 29,637 directories. 9,349 of them are Android Gradle/CMake output, 7,323 inside `node_modules`
  packages.
- All 15 fallback watchers started in parallel in 36 to 54 s, or 29 s with Android build output excluded. Both are
  well under the 240 s limit.
- Excluding that output is therefore not shown to prevent the failure, and no configuration was added.

**Repair.** No repository change. Only the Tali Metro process tree was stopped (pnpm, cmd and Expo CLI on port 8081).
It was cold-restarted with the same command; `DEBUG=Metro:Watcher,Metro:FileMap` only adds log lines.

- The crawl found 83,453 files and started the fallback watcher with no watch-mode error.
- Original request: HTTP 200, `application/javascript`, 9,089,207 bytes, in 62 s (cold transform).
- Repeat request: HTTP 200 in 3.4 s with byte-identical content.
- The API stayed healthy (`/health/live` and `/health/ready` 200).

**Residual risk.** If a future start-up exceeds 240 s again, Metro serves the same 500 until it is restarted.
Restarting Metro is the recovery. Metro surfacing the initialisation error per request would be an upstream
improvement; no patch is proposed. No Metro configuration or version override is justified by the evidence, and the
cause of the slow start-up remains unknown.

**Operational note.** If Metro start-up logs `Failed to start watch mode`, restart Metro before using the session.

Phone verification of the development bundle: **NOT RUN** at the time of the repair (see below for the later run).

### Reference Android device evidence (2026-10-03)

**Device and build provenance** (read with `adb getprop`, `dumpsys package` and `pm path`; no app-private data read):

| Item                         | Value                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Device                       | samsung SM-F936U1 (serial `RFCW1184L4N`)                                                      |
| Android                      | 16, security patch 2026-08-05                                                                 |
| ABI                          | `arm64-v8a`                                                                                   |
| Installed `com.tali.mobile`  | versionCode 1, versionName 0.0.0, `DEBUGGABLE`                                                |
| Install times                | first installed 2026-10-01 09:26:51 (unchanged: in-place update), last updated 2026-10-02 11:51:22 |
| Installed `base.apk` SHA-256 | `a83c55fa965a47ba8c4537992ee7650eee881791975a6abdbbca46c4ed356823`                            |
| Expected (repaired debug APK) | `a83c55fa965a47ba8c4537992ee7650eee881791975a6abdbbca46c4ed356823`: **match**                |

The installed app is the repaired debug APK described in "Android development build", not the earlier release APK.
Its JavaScript comes from Metro: tested Git commit `ceba21cc879933d826deed96bee4cbc9efb391c5` on
`feature/identity-tenancy-slice-6`, plus the uncommitted working tree of this slice (the `expo-dev-client` addition
and, until its removal below, the temporary clear diagnostic).

**SecureStore exhaustive-clear diagnostic** (ADR-007 section 6, `clear()` over the 397 fixed item names). The
temporary local-only diagnostic filled the Cognito namespace with synthetic data while signed out, then timed only
`clear()`. Result line from `adb logcat`:

```text
TALI_COGNITO_CLEAR_DIAGNOSTIC {"status":"complete","passed":true,"items":397,"attempted":397,"elapsedMs":2624,"clearSucceeded":true,"cognitoRemaining":0,"deviceNamespaceUntouched":true}
```

- Exhaustive bounded clear of the Cognito namespace: **PASS**; 397 of 397 known item names attempted.
- Elapsed: **2624 ms** for the full clear on this device.
- No Cognito SecureStore item remained.
- The Tali Device namespace (`tali.device.v1.`) was unchanged: no operation outside the Cognito namespace.

This measurement closed the clear gate only; the remaining gates are recorded below.

**Clear diagnostic removed** after the measurement:

- deleted `apps/mobile/app/cognito-clear-diagnostic.tsx`, `apps/mobile/src/diagnostics/cognito-clear-diagnostic.ts`
  and `apps/mobile/test/cognito-clear-diagnostic.test.tsx`;
- reverted the temporary SecureStore allowlist in `apps/mobile/test/client-safety.test.ts` to the committed version;
- no reference remains in `apps`, `packages` or `tooling`. The Android development bundle served by Metro afterwards
  (HTTP 200) contains no diagnostic route, module, log prefix or synthetic item name, while the permanent
  `./diagnostics.tsx` route is still found by the same search.

### Final reference Android hardware evidence (repaired debug APK, through 2026-10-05)

**Which build this evidence covers.** Every result in this section was observed on the repaired **debuggable**
development APK (SHA-256 `a83c55fa965a47ba8c4537992ee7650eee881791975a6abdbbca46c4ed356823`), loading this slice's
JavaScript from Metro. The observations of 2026-10-01 ("API port 3000", "Cognito not configured") came from the
earlier **release** APK (SHA-256 `ae1955321c3f8593c15f419b1f2ef0d48c9d3e75b6383a66919a86b66bc43771`) built with stale
configuration. They are superseded and are not evidence for or against any gate. No release APK was rebuilt or
tested in this slice.

**Flow gates**, run by the maintainer on the device with a real Cognito user pool:

| Gate                                                                       | Result |
| -------------------------------------------------------------------------- | ------ |
| Real `USER_SRP_AUTH` sign-in (native `AmplifyRTNCore` under React Native 0.86) | PASS   |
| Sign-up confirmation and sign-in flow                                      | PASS   |
| Tali User and profile handoff                                              | PASS   |
| Business and membership resolution                                         | PASS   |
| Device trust survives `adb install -r` (in-place update)                   | PASS   |
| Cognito session survives a process restart                                | PASS   |
| Authenticated API calls after restoration                                  | PASS   |
| Access-token expiry followed by a successful refresh                       | PASS   |
| Rotated refresh session survives another restart                           | PASS   |
| Normal logout clears Cognito and keeps Device trust                        | PASS   |
| Owner, then Cashier, then Owner on the shared device, with no prior-user session bleed | PASS   |
| Device registration survives all staff switching                           | PASS   |

**Instrumented gates** (temporary local-only diagnostic, below). Result lines from `adb logcat`, which contain only
counts, booleans and outcome names:

| Gate                                     | Result line                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SecureStore exhaustive clear (397 names) | `{"status":"complete","passed":true,"items":397,"attempted":397,"elapsedMs":2624,"clearSucceeded":true,"cognitoRemaining":0,"deviceNamespaceUntouched":true}`                                                                 |
| Nothing in AsyncStorage                  | `{"test":"asyncStorage","passed":true,"asyncStorageKeyCount":0}`                                                                                                                                                               |
| Single-flight refresh                    | `{"test":"singleFlight","passed":true,"status":"complete","callers":8,"actualRefreshOperations":1,"callersSucceeded":8,"allCallersSucceeded":true}`                                                                            |
| `GlobalSignOut`                          | `{"test":"globalSignOut","passed":true,"status":"complete","globalSignOutRemoteSucceeded":true,"localSessionCleared":true,"cognitoRemaining":0,"deviceNamespaceUntouched":true,"asyncStorageKeyCount":0}`                     |
| Definitive refresh failure               | `{"test":"definitiveRefreshFailure","passed":true,"status":"complete","refreshOutcome":"definitive_failure","refreshErrorType":"NotAuthorizedException","localSessionCleared":true,"cognitoRemaining":0,"deviceNamespaceUntouched":true,"asyncStorageKeyCount":0}` |

What they show:

- **Single-flight**: 8 concurrent `accessToken()` callers caused exactly 1 `GetTokensFromRefreshToken`, and all 8
  succeeded.
- **`GlobalSignOut`**: Cognito accepted the global sign-out, the local session was cleared, no Cognito item remained,
  the Device namespace was unchanged and AsyncStorage held no key.
- **Definitive refresh failure**: a refused refresh (`NotAuthorizedException`) was classified as definitive and
  cleared the local session completely, leaving the Device namespace unchanged and AsyncStorage empty.
- **AsyncStorage**: zero keys after the Cognito flows, so no Cognito state exists outside the Cognito SecureStore
  namespace.

**The device diagnostic (temporary, local-only, now removed).**

- It was a development-only screen (`apps/mobile/app/cognito-device-diagnostic.tsx`, module
  `apps/mobile/src/diagnostics/cognito-device-diagnostic.tsx`, tests `apps/mobile/test/cognito-device-diagnostic.test.tsx`)
  logging `TALI_COGNITO_DEVICE_DIAGNOSTIC {json}`.
- It drove the production Cognito paths through the public `SessionStore` API. A global `fetch` observer counted
  Cognito operations by operation name and HTTP status only.
- It needed three temporary exemptions so that it could read the AsyncStorage key count: an ESLint exemption, a
  dependency-cruiser exemption and client-safety test exclusions.
- **Removed on 2026-10-05**: the three files above are deleted; `.dependency-cruiser.cjs`, `tooling/eslint/index.mjs`
  and `apps/mobile/test/client-safety.test.ts` are restored to the committed versions, which removes every exemption;
  the fetch observer and its counters went with the module.
- A search of the repository for `TALI_COGNITO_DEVICE_DIAGNOSTIC`, `cognito-device-diagnostic`,
  `TALI_COGNITO_CLEAR_DIAGNOSTIC` and `cognito-clear-diagnostic` finds only this audit's historical record. The
  Android and iOS exports contain none of them; the permanent `diagnostics` route remains.

**Strict boundaries after cleanup.** ESLint, dependency-cruiser and `client-safety.test.ts` again ban AsyncStorage,
`react-native-get-random-values` and NetInfo from all mobile code. Amplify is allowed only in
`amplify-cognito-auth.ts` (plus the initialization-order test), through the public `aws-amplify` entry points.
`@aws-amplify/*` is not imported. The storage adapter contains no Amplify key name and no key-content matching. No
diagnostic exception survives.

### Not verified (limits)

None of these blocks Slice 6.

- **Release readiness**: the gates ran on a debug APK. A release APK with the repaired native project was not
  rebuilt or tested. The release variant stays non-debuggable. That the debug-only `expo-dev-launcher` additions stay
  out of release builds was not confirmed with a release build. Production Android release readiness (signing,
  store distribution) is not claimed.
- **SecureStore**: behaviour after a lock-screen change or Keystore invalidation was not tested. Neither was the
  largest value stored on the device: the automated tests cover the 16 KiB bound. The backup-exclusion rules are
  present in the merged manifest, but no backup and restore was exercised.
- **iOS**: `expo export --platform ios` (JavaScript) only. It is not native-verified and not App Store ready.

## Verification

Finalization (2026-10-05): diagnostics removed, final run. The web `next dev` server was stopped before the build and
the scanner. The API and Metro were left running. Turbo's cache was bypassed (`TURBO_FORCE=true`), so every task
ran.

| Command                                                      | Result                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                                | exit 0. Text integrity (543 files), prettier, build 9 of 9, lint, typecheck 18 of 18, boundaries (483 modules, 1972 dependencies, no violations), unit tests: application 261, domain 157, web 117, integrations 109, api 52, config 37, shared 28, database 13, text integrity 12, worker 11, client-bundle-check 8, mobile 316 (18 suites) |
| `pnpm test:integration`                                      | exit 0, 12 of 12 tasks run (none cached). database 221 (19 files), api 97 (1 skipped on Windows), worker 9 (1 skipped)                                                                                                            |
| `pnpm --filter @tali/web e2e` (Playwright)                   | exit 0. local 10 passed, Cognito 5 passed                                                                                                                                                                                          |
| `node tooling/client-bundle-check/src/cli.mjs`               | exit 0, clean: web (40 files), mobile Android and iOS JavaScript export (37 files), Android and iOS Hermes export (37 files), public app config                                                                                     |
| Diagnostic strings in the exported mobile bundles            | none                                                                                                                                                                                                                               |
| gitleaks 8.30.1 `git` scan (CI command, 17 commits)          | no leaks                                                                                                                                                                                                                           |
| gitleaks 8.30.1 `dir` on every changed working-tree file     | no leaks                                                                                                                                                                                                                           |

Failed attempts, reported and not counted as passes:

- **Overlapping runs (operator error).** Two earlier forced `pnpm verify` runs were still running in the background
  when the next ones started. One ran from 00:53 to 06:22, the other from 05:56 to 06:26. So up to four verify runs
  shared the build outputs, the generated Prisma client and the CPU. Their results:
  - a run stopped at `@tali/web#build` with "Another next build process is already running" (no test ran);
  - a run failed lint with 235 `@typescript-eslint/no-unsafe-*` errors ("type could not be resolved") on Prisma model
    calls in eight `packages/database/src/repositories/*` files. This is consistent with a concurrent run regenerating
    the Prisma client at that moment;
  - the 00:53 run failed `@tali/web#test`: 7 Vitest workers failed to start ("Timeout waiting for worker to respond"),
    and all 13 tests that ran passed;
  - the 05:56 run failed `@tali/mobile#test`: one test in `cognito-onboarding.test.tsx` ("signs up, confirms, signs
    in and continues to registration and the business picker") exceeded its 30-second timeout, and the other 315
    passed. No assertion failed. The same test passed in the single verify run below. It timed out under parallel
    load once before (see the Android development-build pass).
- **Passing run.** The reported `pnpm verify` (06:31 to 06:38) started after both overlapping runs had ended, and it
  passed in full. A separate `pnpm lint` run alone also exited 0. No verify, Turbo, Vitest, Jest, ESLint or
  `next build` process is running now.
- **First Playwright run**: the web server could not start because `http://127.0.0.1:3910/health/live` was reported
  in use; no test ran. When checked, nothing listened on port 3910 and the owning process no longer existed. The
  retry passed.

`apps/mobile/tsconfig.json` (Expo CLI 57): the change removes only the stale `expo-env.d.ts` and
`.expo/types/**/*.ts` include entries. `app.config.ts` does not enable `experiments.typedRoutes`, so every
`expo start` deletes `expo-env.d.ts` and strips both entries; keeping them would only recreate that churn. The change
is kept and Prettier-clean; the generated files were not restored.

Server and web steps (earlier in this slice):

| Command                                                      | Result                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                                                | exit 0. Text integrity, prettier, build, lint, typecheck, boundaries (no violations), unit tests: web 117, api 52, integrations 109, config 37, mobile 201, and the rest |
| `pnpm test:integration`                                      | exit 0. database 221, worker 9 (1 skipped), api 97 (1 skipped on Windows)                                                                                                |
| `pnpm --filter @tali/web e2e`                                | exit 0. local 10, Cognito 5                                                                                                                                              |
| `node tooling/client-bundle-check/src/cli.mjs`               | clean (web, Android export, mobile public configuration)                                                                                                                 |
| `expo export --platform ios`                                 | exit 0; no Cognito or Amplify code                                                                                                                                       |
| gitleaks 8.30.1 `git` scan (CI command) with changes applied | no leaks                                                                                                                                                                 |

Mobile step (2026-09-30):

| Command                                                         | Result                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                                   | exit 0. Text integrity (542 files), prettier, build, lint, typecheck, boundaries (481 modules, no violations), unit tests: mobile 291, web 117, application 261, domain 157, integrations 109, api 52, config 37, and the rest |
| `pnpm test:integration`                                         | exit 0. database 221, worker 9 (1 skipped), api 97 (1 skipped on Windows)                                                                                                                                             |
| `node tooling/client-bundle-check/src/cli.mjs`                  | clean: web, mobile Android and iOS JavaScript export, mobile Android and iOS Hermes export, mobile public configuration                                                                                               |
| `expo export --platform android --platform ios`, Cognito mode   | exit 0; region, pool ID, client ID and API URL present (public); no `REFRESH_TOKEN_AUTH`, no test password, no forbidden value                                                                                        |
| Probe files for each new ESLint and dependency-cruiser ban      | every ban fired; probes deleted                                                                                                                                                                                        |
| gitleaks 8.30.1 `git` scan (CI command) with changes applied    | no leaks                                                                                                                                                                                                               |
| Reference Android device                                        | **not run: no device attached**                                                                                                                                                                                        |

Pre-device hardening pass (2026-10-01): session ownership, index-independent clearing, scanner review.

| Command                                                      | Result                                                                                                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`                                                | exit 0. Text integrity (543 files), prettier, build, lint, typecheck, boundaries (483 modules, no violations), unit tests: mobile 316, web 117, application 261, domain 157, integrations 109, api 52, and the rest |
| `pnpm test:integration`                                      | exit 0. database 221, worker 9 (1 skipped), api 97 (1 skipped on Windows)                                                                                                       |
| `node tooling/client-bundle-check/src/cli.mjs`               | clean: web, mobile Android and iOS JavaScript export, mobile Android and iOS Hermes export, mobile public configuration                                                         |
| Probe test file importing `aws-amplify` and `aws-amplify/adapter-core` | ESLint and dependency-cruiser both fired; probe deleted                                                                                                            |
| gitleaks 8.30.1 `git` scan (CI command) with changes applied | no leaks                                                                                                                                                                         |
| Reference Android device                                     | **not run**                                                                                                                                                                      |

Android development-build repair (2026-10-02): `expo-dev-client`, native sync, debug APK.

| Command                                                         | Result                                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                                                   | stopped at `prettier --check`: only `apps/mobile/tsconfig.json`, an uncommitted change made before this repair (left as found); text integrity 546 files     |
| `pnpm run build`, `lint`, `typecheck`, `boundaries`, `test`     | build, lint, typecheck exit 0; boundaries: no violations (486 modules); tests: mobile 324 of 326 passed, 2 timed out at 30 s under load (run took 2,840 s)   |
| `jest` on the two timed-out files alone                         | 18 of 18 passed in 16 s                                                                                                                                      |
| Mobile part of `client-bundle-check` (same canaries and policy) | clean: Android and iOS JavaScript export, Hermes export, public app config. The web part was not run: its first step deletes `apps/web/.next`, which a running `next dev` held |
| `gradlew app:assembleDebug`                                     | `BUILD SUCCESSFUL`; APK verified above                                                                                                                       |
| gitleaks 8.30.1 `dir` on the changed files                      | no leaks                                                                                                                                                     |
| Reference Android device                                        | **not run**: the development build is not installed                                                                                                          |

The first `pnpm verify` run of this pass failed on load: the first Cognito onboarding UI test exceeded its 30-second
timeout while the suites ran in parallel (it takes about 5 seconds alone, cold module load included). The rerun
passed unchanged. The local test database ran on port 57433 through the existing `TALI_POSTGRES_TEST_PORT`,
`TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` overrides, because Windows had reserved the default port.

The first two `pnpm verify` runs of the mobile step failed on load, not on assertions. In the first, the JWKS
rate-limit test exceeded 5 seconds (see Deviations). In the second, the web Vitest workers timed out while starting
under parallel load ("Timeout waiting for worker to respond"). The third run passed unchanged.

## Risks and residual items

- **Authentication.** A JWKS outage gives 401 for tokens whose key is not cached; there is no fallback by design.
- **Browser session.** A reload signs the user out (accepted policy). Amplify's temporary workflow state may stay in
  sessionStorage for up to 3 minutes after an unsupported challenge; it holds no token or password.
- **Not implemented:** forgot-password, MFA and other challenges, and staff members without an email address.
- **Tenancy.** Unchanged: business membership and roles come from Tali's database. Integration tests prove that
  Cognito groups and custom claims grant nothing.
- **Safety tooling.** The client-bundle scanner now masks exactly three third-party property forms in JavaScript, and
  scans Hermes bytecode for values only. The mobile change needs human review; any further widening needs review.
- **Mobile native module.** `@aws-amplify/react-native` 1.3.3 exposes `AmplifyRTNCore` as a legacy native module.
  React Native 0.86 runs the New Architecture. Through its interop layer, real SRP sign-in with this module worked on
  the reference Android device (debug APK). A future React Native upgrade that drops legacy-module interop would
  break sign-in; it fails closed (nothing is stored).
- **Index loss.** Resolved in the pre-device hardening pass: `clear()` no longer depends on the index (above).
  Remaining limit: chunks whose index and manifest were both lost are not seen by `isEmpty()`. They are never
  returned and are removed by the next `clear()` (sign-out, definitive refresh failure, or the end of a leftover
  session).
- **Late revocation.** Resolved in the pre-device hardening pass: a late completion affects only the ended session
  (above). Remaining limit: if a refresh of the ended session outlasts the bound, the refresh token it rotates to is
  discarded unrevoked. It is never stored, and it expires with the session's refresh lifetime.
- **New Amplify entry point.** `aws-amplify/adapter-core` (same pinned package, public export, no new dependency) is
  used for `createUserPoolsTokenProvider`. It needs human review as part of the dependency audit; the ESLint
  allowlist and the client-safety test were extended by exactly this specifier.
- **iOS Keychain survival after uninstall** (ADR-007 section 8): an iOS production-readiness item, not handled in
  Build 1.

## Deviations

- Amplify's temporary SRP/challenge workflow state in sessionStorage (above): a deviation from the stricter
  implementation prompt, not from ADR-003, accepted by the user (option A).
- In the unit tests the synthetic test password is low-entropy, following the `.gitleaks.toml` convention for
  fixtures.
- `packages/integrations/src/aws/cognito/cognito-identity-provider.test.ts`: the JWKS rate-limit test (250 RS256
  signatures) has a 20-second timeout. Under the added parallel load of the mobile suites in `pnpm verify` it
  exceeded the default 5 seconds once; it passes alone.
- The Android hardware gates ran on a debuggable development APK, not on a release build (see "Not verified
  (limits)").
- Temporary local-only device diagnostics, with lint, dependency-cruiser and client-safety exemptions, existed only
  for the hardware measurement and were removed before finalization.
