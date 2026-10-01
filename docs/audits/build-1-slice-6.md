# Build 1 Slice 6: Cognito identity adapter and web Cognito client (IN PROGRESS)

- Date: 2026-09-30
- Status: **IN PROGRESS. Slice 6 is NOT complete.** The server adapter and the web Cognito client are implemented and
  verified. The mobile Cognito client is **unblocked but not started**: ADR-007 was ACCEPTED on 2026-09-30.
- Scope: Slice 6 of `docs/plans/003-build-1-identity-tenancy.md`, under ADR-001 to ADR-006 (all ACCEPTED): the
  `CognitoIdentityProvider` adapter with JWKS verification, configuration, API composition, and the web sign-up,
  sign-in, refresh and sign-out flow.
- Not in this step: the mobile Cognito client (ADR-007, accepted 2026-09-30, not yet implemented), any AWS resource, CDK, CloudFormation, Terraform, User Pool,
  deployment workflow, GitHub `id-token` permission or AWS credential. Forgot-password, MFA and other additional
  challenges are not implemented. No schema change was needed.
- Money: **not touched**. No financial, ledger or inventory code changed. The change touches **authentication,
  tenancy resolution, browser session handling and the client-bundle safety check**; see the risk section.
- Dependency added: `aws-amplify` **6.22.1** in `apps/web` only (pinned exactly). No other dependency was added or
  upgraded. The lockfile diff only adds entries.

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
| Mobile: no Cognito code, no new dependency, Android and iOS exports free of Amplify | PASS                           |
| Client bundles free of server variable names, canaries and secret prefixes           | PASS (after the scanner fix)   |
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
- The mobile public configuration is unchanged.

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

## Boundary guards

- ESLint (`tooling/eslint/index.mjs`):
  - string literals and template text starting with `cognito:` or `custom:` are banned outside tests, so claims
    cannot be read;
  - Amplify is banned everywhere except `apps/web/src/lib/auth/cognito/**`, which may import only the four public
    entry points.
- dependency-cruiser (`.dependency-cruiser.cjs`): `mobile-no-cognito-client`, `web-amplify-only-in-cognito-module`,
  `server-no-cognito-client`, and the client identity-SDK rule extended to `@aws-amplify` and
  `amazon-cognito-identity-js`.
- Temporary probe files confirmed each ban fires; they were deleted.

## Mobile

- **ADR-007 ACCEPTED (2026-09-30)** by the human maintainer
  (`docs/decisions/ADR-007-mobile-cognito-session-persistence.md`, mobile only). The accepted design is Option B:
  the complete Amplify-managed Cognito session is stored in Expo SecureStore, through Amplify's public
  `KeyValueStorageInterface` and a Tali adapter that treats keys and values as opaque and uses a versioned
  manifest-and-chunk format. No Cognito data may go to AsyncStorage. The Cognito and Device namespaces stay separate.
  ADR-007 partially supersedes only the mobile persistence wording of ADR-003 section 14.4.
- **Mobile Cognito implementation: unblocked, not started.** No mobile Cognito code exists. None of the ADR-007
  implementation preconditions has been verified yet, and no mobile Cognito acceptance test has run:
  - dependency review of the React Native Amplify packages;
  - AsyncStorage and initialization-order tests;
  - large-value chunking tests;
  - evidence on the reference Android device.
- `apps/mobile` is unchanged: no Amplify, `@aws-amplify/react-native`, `react-native-get-random-values` or
  AsyncStorage. The accepted Device credential storage is unchanged. Neither the Android nor the iOS export contains
  Cognito or Amplify code.

## Verification

| Command                                                      | Result                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm verify`                                                | exit 0. Text integrity, prettier, build, lint, typecheck, boundaries (no violations), unit tests: web 117, api 52, integrations 109, config 37, mobile 201, and the rest |
| `pnpm test:integration`                                      | exit 0. database 221, worker 9 (1 skipped), api 97 (1 skipped on Windows)                                                                                                |
| `pnpm --filter @tali/web e2e`                                | exit 0. local 10, Cognito 5                                                                                                                                              |
| `node tooling/client-bundle-check/src/cli.mjs`               | clean (web, Android export, mobile public configuration)                                                                                                                 |
| `expo export --platform ios`                                 | exit 0; no Cognito or Amplify code                                                                                                                                       |
| gitleaks 8.30.1 `git` scan (CI command) with changes applied | no leaks                                                                                                                                                                 |

## Risks and residual items

- **Authentication.** A JWKS outage gives 401 for tokens whose key is not cached; there is no fallback by design.
- **Browser session.** A reload signs the user out (accepted policy). Amplify's temporary workflow state may stay in
  sessionStorage for up to 3 minutes after an unsupported challenge; it holds no token or password.
- **Not implemented:** forgot-password, MFA and other challenges, and staff members without an email address.
- **Tenancy.** Unchanged: business membership and roles come from Tali's database. Integration tests prove that
  Cognito groups and custom claims grant nothing.
- **Safety tooling.** The client-bundle scanner now masks exactly two third-party property forms; any widening needs
  review.

## Deviations

- Amplify's temporary SRP/challenge workflow state in sessionStorage (above): a deviation from the stricter
  implementation prompt, not from ADR-003, accepted by the user (option A).
- In the unit tests the synthetic test password is low-entropy, following the `.gitleaks.toml` convention for
  fixtures.
- Slice 6 is not complete: the mobile Cognito client, unblocked by ADR-007 (accepted), is not yet implemented.
