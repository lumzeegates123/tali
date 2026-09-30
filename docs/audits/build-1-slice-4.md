# Build 1 Slice 4: web and mobile onboarding

- Date: 2026-09-30
- Scope: Slice 4 of `docs/plans/003-build-1-identity-tenancy.md`, under ADR-002, ADR-004, ADR-005 and ADR-006 (all
  ACCEPTED). The web app (`apps/web`) and the Android app (`apps/mobile`) now run the P0 onboarding journey against
  the Slice 3 API: local sign-in, registration, the business list or first-business creation, the business picker
  and the business overview. The web app also shows a read-only members list.
- Not in this slice: invitations, member management and devices (Slice 5), Cognito and AWS authentication (Slice 6,
  blocked on ADR-003), offline features, SQLite, camera, voice and push notifications.
- Backend: **unchanged**. No endpoint, Prisma schema, migration, repository, authorization rule, `BusinessContext`,
  `LocalIdentityProvider`, fingerprint framing or idempotency semantics changed. No Slice 3 defect was found.
- Dependencies: **none added**. No `package.json` or lockfile changed.

## Summary

| Area | Result |
| --- | --- |
| Web onboarding (sign-in, registration, create, picker, overview, members) | PASS (Vitest + Playwright on the real API) |
| Mobile onboarding (sign-in, registration, create, picker, overview; no members) | PASS (jest-expo) |
| Token, user, businesses and selected business in memory only | PASS (persistence-negative tests, reload test) |
| Local sign-in shown only when the public config says `local` | PASS |
| One Idempotency-Key per logical CreateBusiness submission, reused on retry | PASS |
| Double submission sends one request | PASS (web and mobile) |
| Only UNAUTHENTICATED ends the session; 403 and 404 never do | PASS |
| Members PERMISSION_DENIED shown as "not available", distinct from empty | PASS |
| Client bundles free of server secrets | PASS (`client-bundle-check`, gitleaks on source) |
| Dependency boundaries, including new client rules | PASS (probe imports rejected) |
| `pnpm verify` | exit 0 |
| `pnpm test:integration` | exit 0 |
| Expo Android export and web production build | PASS |

## Web onboarding architecture

- `src/app/page.tsx` stays a server component that reads the public config. It renders `AppShell` with
  `OnboardingApp` first, then the existing environment and API health panels. There are no route handlers and no
  server actions; everything after the page load happens in the browser against the Tali API.
- `src/onboarding/onboarding-app.tsx` (`"use client"`) creates one `SessionStore` per page instance and switches
  on the session phase. No new routes were added: a reload returns to `/` signed out.
- Small components in `src/onboarding/`: `local-sign-in-form`, `registration-form`, `business-picker`,
  `create-business-form`, `business-overview`, `members-list`, plus the shared `text-field`, `failure-alert` and
  `screen-heading` (heading focus and loading status).
- Non-UI modules in `src/lib/`: `api-client/tali-api-client.ts`, `api-client/failure-messages.ts`,
  `auth/session-store.ts`, `auth/session-context.tsx`, `auth/local-sign-in.ts` and
  `onboarding/create-business-defaults.ts`.

## Mobile onboarding architecture

- Expo Router is unchanged apart from `app/_layout.tsx`, which wraps the stack in `SessionRoot` so one in-memory
  store lives for the life of the JavaScript runtime. `app/index.tsx` renders `OnboardingApp` above the existing API
  health panel.
- Modules follow the existing mobile layout (`src/api`, `src/ids`): `src/api/tali-api-client.ts`,
  `src/api/failure-messages.ts`, `src/auth/session-store.ts`, `src/auth/session-context.tsx`,
  `src/auth/local-sign-in.ts`, and `src/onboarding/` (`ui.tsx`, `sign-in-screens.tsx`, `business-screens.tsx`,
  `onboarding-app.tsx`, `create-business-defaults.ts`, `role-label.ts`).
- There is no members UI on mobile. No native modules were added and SecureStore is not used.
- The session store and API client are intentionally duplicated between the two apps: the brief keeps state
  inside each app, `packages/shared` stays wire contracts only, and there is no `packages/ui`.

## Auth and session state model

`SessionStore` is a framework-free class. React reads it through `useSyncExternalStore`.

- Private fields: the bearer token (`#token`), the current CreateBusiness attempt (command plus idempotency key), an
  in-flight flag and an epoch counter.
- Public snapshot (frozen, and **never contains the token**): `phase`, `user`, `businesses`,
  `businessesNextCursor`, `selectedBusinessId`, `pending`, `error {action, failure}` and `notice`.
- Phases: `signedOut`, `signingIn`, `needsRegistration`, `loadingBusinesses`, `choosingBusiness`,
  `businessSelected` and `error`.
- After local sign-in the store calls `GET /v1/me`:
  - `USER_NOT_REGISTERED` goes to registration and keeps the token;
  - `USER_DISABLED` drops the token and shows "Account unavailable";
  - `UNAUTHENTICATED` (from any call) drops everything and returns to sign-in with "Your session has ended. Sign in
    again.";
  - `PERMISSION_DENIED` and `NOT_FOUND` never end the session.
- Every reset increments the epoch. A response that arrives after sign-out or a new sign-in is discarded, so a late
  reply cannot repopulate a cleared session.
- The store makes no authorization, tenancy, status, currency or time-zone decisions. It only routes on the codes
  the server returns.

### Tokens and the selected business stay in memory

The token, user, businesses and selected business ID exist only in the store instance. No code path writes to
`localStorage`, `sessionStorage`, cookies, IndexedDB, AsyncStorage, SecureStore, SQLite or files. A reload (web) or
app restart (mobile) starts signed out. The token is sent only in the `Authorization: Bearer` header. It never goes
into a URL, route, rendered output, log or error message.

## Local sign-in client gating

`isLocalSignInAvailable(config)` returns `config.env === "local"` using the existing `@tali/config/public` value
(`NEXT_PUBLIC_TALI_ENV` / `EXPO_PUBLIC_TALI_ENV`). No new flag, `NODE_ENV` check or hostname heuristic was added. In
any other environment the app shows "Sign-in is not available in this environment yet." The server still enforces
the real gate: `/__local/sign-in` exists only when `TALI_ENV=local` with the local identity provider (Slice 3).

The sign-in screen is marked as development-only: its heading is "Local development sign-in" and it shows a
development-only notice. It asks only for a local subject, validated with `LocalSignInRequestSchema`. It asks for no
password or other credential.

## Registration UX

"Set up your profile" asks only for "Your name" (`displayName`). Local checks come from the shared request schema.
Field errors returned in a `VALIDATION_FAILED` envelope are shown next to the field. A 200 or 201 moves on to loading
businesses.

## Business list and picker

- `GET /v1/me/businesses` is called with the exact pagination contract (`limit`, `after`). "Show more businesses"
  follows `nextCursor`.
- With no businesses, the create form opens headed "Create your first business". With one or more, "Choose a
  business" lists one button per server-returned business (name, currency, time zone, role). There is no manual
  ID entry.
- `selectBusiness(id)` accepts only an ID that is in the loaded list. The selection is held in memory. "Switch
  business" returns to the picker, and "Create another business" opens the form from the picker.

## CreateBusiness UX

- Fields: "Business name" and "Time zone". The currency is shown, not chosen (see below). The request body is
  exactly `{ name, currencyCode, timeZone }` and is parsed with `CreateBusinessRequestSchema` before sending.
- While submitting, the button reads "Creating business…" and is disabled (and `busy` on mobile).
- On 201 the store refreshes the business list, merges the created summary if the refreshed page does not yet
  include it, selects the new business and shows its overview.

### Client idempotency behaviour

- One UUIDv7 key per logical submission (`newUuidV7`; Web Crypto on web, `expo-crypto` on mobile), sent in the
  `Idempotency-Key` header.
- The same key is reused while the request is in flight and on retry after a network failure, timeout,
  `IDEMPOTENCY_IN_PROGRESS`, `CONCURRENT_MODIFICATION`, `DEPENDENCY_UNAVAILABLE`, `RATE_LIMITED` or a 5xx response.
  The retry button reads "Try again with the same details", with the hint that this will not create a second
  business.
- A new key is generated only when the trimmed command changes (a material edit), after success, after
  `IDEMPOTENCY_KEY_REUSED`, or after sign-out.
- Presses while a submission is in flight are ignored in the store (`#createInFlight`), and the button is disabled.
- The key is never rendered or logged.

## Currency UX and source

No endpoint lists currencies, and adding one would be a backend expansion. Currency is therefore shown as the fixed
pilot value, "Currency: NGN", with the hint "The private pilot supports NGN only. A business keeps its currency
once created." The source is
the APPROVED private-pilot market in `docs/product/mvp-scope.md` (Nigeria, NGN). It is the single constant
`PILOT_CURRENCY_CODES = ["NGN"]` in each app's `create-business-defaults.ts`. There is no currency catalogue on the
client and no currency logic. The server validates `currencyCode` against its reference table. See the deviations
section.

## Time-zone UX

The field is prefilled with the device's IANA zone from `Intl.DateTimeFormat().resolvedOptions().timeZone`, but only
when that value looks like an IANA name. Offset-like values (`UTC+1`, `GMT-05`, `Etc/GMT+1`) are never offered or
converted. The user may edit the field (hint: "for example Africa/Lagos"). The client does not copy the IANA
dataset. The server validates the name with the kernel `parseTimeZoneId`, and its field error is shown beside the
input.

## Business overview

Every selection loads `GET /v1/businesses/:id` and then pages `GET /v1/businesses/:id/locations` (limit 100, at most
10 pages) to find the ACTIVE default location. The screen shows the name (as the heading), currency, time zone,
default location and the user's role. If no default location is returned, it shows a retryable generic message.
There are no metrics, charts or placeholder numbers.

If the selected business answers `NOT_FOUND`, the selection is cleared and the list is reloaded. The user sees
"That business is no longer available to you." and nothing that reveals whether the business exists or why.

## Web members list

After the overview loads, the web app calls `GET /v1/businesses/:id/members` and shows a table (name, role, status)
with "Show more members" pagination. The states are kept distinct:

- `PERMISSION_DENIED` shows "The members list is not available with your access." (`members-not-available`);
- an empty page shows "No members to show.";
- other failures show an alert with retry.

There are no role, suspension or invitation controls.

## Loading and error handling

- Every network step has a `role="status"` loading message, and submit buttons are disabled in flight.
- `describeFailure` maps each code to plain text plus a "retryable" flag. Network failures ("Tali could not be
  reached…") are distinct from API errors. Unknown codes map to a generic message. The UI never shows stack traces,
  Prisma or SQLSTATE text, jose errors, raw bodies or server messages.
- A response that does not match the shared schema becomes `invalid-response` (generic, retryable), never a partial
  render.

## Logout behaviour

"Sign out" resets the store: token, user, businesses, cursor, selection, CreateBusiness attempt and key are dropped,
the epoch advances, and the app shows sign-in with "You have signed out." The server keeps no session: the local
token simply stops being sent.

## API client design

Each app has one `TaliApiClient`:

- It uses the public `apiBaseUrl` only; no URLs are hardcoded in components.
- Every request sends `accept` and a fresh `x-correlation-id`, uses `credentials: "omit"` (and `cache: "no-store"`
  on web), and times out after 5 s for GET and 15 s for mutations.
- `authorization: Bearer` is attached only when a token is passed. `content-type` is set only when there is a body.
- Request bodies are built from `@tali/shared` types. Responses are checked for the expected status and parsed with
  the shared schemas.
- Errors are parsed from `{ error: { code, message, details } }`, keeping status, code, message and correlation ID.
  Validation field names are reduced to safe identifiers.
- A thrown fetch becomes `unavailable` (network or timeout). The client never retries by itself, so it can never
  resend with a new key.
- Methods: `getReadiness`, `localSignIn`, `getCurrentUser`, `registerCurrentUser`, `listMyBusinesses`,
  `createBusiness`, `getBusiness`, `listLocations`, `listMembers`.

## Test results

### Web unit tests (Vitest + React Testing Library, jsdom)

`@tali/web` has 6 files and 67 tests, all passing:

- `api-client`, `session-store` (31 tests together);
- `onboarding` (20 tests);
- `client-safety` (4 tests);
- the existing `shell` and `ids` suites.

The session-store and component tests cover:

- sign-in, registration, `USER_DISABLED` and rate-limit failure, with retry;
- picker selection limited to loaded IDs, and pagination;
- the overview, including the missing default location;
- `NOT_FOUND` reload with generic wording, members `PERMISSION_DENIED` versus empty, and 401 invalidation;
- malformed responses;
- idempotency: a UUIDv7 key, reuse on network and transient errors, a new key after an edit or after
  `IDEMPOTENCY_KEY_REUSED`, and a single request on double click;
- sign-out clearing, stale-response drop, and a new store starting signed out;
- gating in `local`, `test`, `development`, `staging` and `production`;
- server field errors, focus movement, and no token or key in the DOM or URL.

### Mobile unit tests (jest-expo, React Native Testing Library)

The `mobile` project has 8 suites and 74 tests, all passing. `pnpm verify` runs 180 mobile tests in 13 suites,
including the kernel-under-Expo-Babel project. The new `session-store` suite mirrors the web store tests. The new
`onboarding` suite covers:

- gating;
- subject validation;
- sign-in through registration, create, overview and sign-out, with no Members UI;
- the picker, `NOT_FOUND` and 401;
- double press sending one POST with the busy state;
- a network retry using the same key;
- a restarted app starting signed out.

`api-client` and `client-safety` were extended.

### Playwright (real API, Chromium)

9 of 9 pass. The run covers the existing health and UUIDv7 specs plus the new `e2e/onboarding.spec.ts`, which runs
against the compiled API and a production web build on the disposable test database. It uses a unique subject per
run and the `Africa/Lagos` time zone. The spec proves:

- sign-in, registration, time-zone prefill and CreateBusiness;
- the request carries a UUIDv7 `Idempotency-Key`, the bearer token and exactly `{name, currencyCode, timeZone}`, and
  receives 201;
- the overview shows NGN, Africa/Lagos and Owner, and the members table shows the owner as Active;
- there are no cookies, `localStorage`, `sessionStorage` or `document.cookie` entries, and no token in the URL or
  page;
- sign-out works;
- a returning user picks the business, and a reload loses the session;
- a 401 from the API ends the session with the safe message.

`playwright.config.ts` now starts the API with `TALI_ENV=local` and `IDENTITY_PROVIDER=local`, and the web app with
`NEXT_PUBLIC_TALI_ENV=local`, because local sign-in exists only there. Storage and queue stay in memory. The health
spec now expects the environment label `local`. The CI step name was updated.

## Accessibility checks

- Web:
  - each screen has an `h2` heading that takes focus when the phase changes (`tabIndex=-1`);
  - loading uses `role="status"` with `aria-live="polite"`, and failures use `role="alert"`;
  - every input has a `<label>`, with `aria-describedby` for hints and errors and `aria-invalid`, and error text
    begins with "Error:";
  - the session bar is a labelled `nav`, and the members table uses `th scope="col"`.
- Mobile:
  - headings use `accessibilityRole="header"`, and buttons have `accessibilityRole="button"`, a label and
    `accessibilityState {disabled, busy}`;
  - loading is a live region, and failures are `alert` with an assertive live region;
  - inputs are labelled.
- Tests query by role and accessible name throughout (RTL, RNTL and Playwright). This proves the names exist. It is
  not a full screen-reader audit.

## Persistence-negative tests

- Web `client-safety`: `src/` contains no `localStorage`, `sessionStorage`, `indexedDB`, `cookieStore`,
  `document.cookie` or `set-cookie`. There are no imports of jose, Amplify, Cognito, AWS SDK, `node:*`, backend
  packages or `@tali/config/server`.
- Web onboarding component test: after the full flow, storage and cookies are empty and the token is absent from the
  DOM and URL.
- Playwright: the same checks in a real browser, plus a reload losing the session.
- Mobile `client-safety`:
  - `package.json` declares no AsyncStorage, SecureStore, SQLite, MMKV, Keychain or `expo-file-system`, and none
    resolve from the app;
  - `src/` and `app/` never mention them, `localStorage` or `sessionStorage`;
  - jose, Amplify and Cognito SDKs do not resolve, and no forbidden import appears.
- Mobile onboarding test: a new store (app restart) starts signed out.

## Client-bundle secret scan

`node tooling/client-bundle-check/src/cli.mjs` built the web app and ran the Expo Android export. It reported clean
for all three targets, with 28 forbidden needles each:

- web static output: 33 files;
- Android export: 29 files;
- embedded public app config: 1 file.

Gitleaks (Docker, `dir` mode) found no leaks in `apps/web/{src,test,e2e}`, `apps/mobile/{src,app,test}`, `tooling`
or `.github`. A whole-tree scan flagged only:

- Next.js per-build preview and encryption keys in the git-ignored `apps/web/.next` output (server-side build
  artifacts, not client source);
- the phrase "OIDC/JWT tokens" in the unchanged, accepted ADR-001 (false positive).

## Dependency-boundary results

- `pnpm run boundaries`: no violations (402 modules, 1476 dependencies).
- New rules:
  - dependency-cruiser `clients-no-direct-identity-sdk` (web and mobile cannot reach jose, Amplify or the Cognito
    SDK);
  - dependency-cruiser `client-runtime-no-node-builtins` (no Node.js core modules from `apps/web/src`,
    `apps/mobile/src` or `apps/mobile/app`);
  - ESLint `CLIENT_RUNTIME_BANS` now also bans Amplify and Cognito SDKs and Node.js built-ins.
- Existing rules were not weakened.
- Probe: a temporary file importing `@tali/application`, `@tali/database`, `@tali/integrations`,
  `@tali/config/server`, `@aws-sdk/client-s3`, `aws-amplify`, `jose`, `node:crypto` and `fs` was placed in each of
  `apps/web/src` and `apps/mobile/src`. ESLint reported 18 errors (9 per app) and dependency-cruiser reported 18
  violations. The probes were then deleted.

## Verification

| Check | Result |
| --- | --- |
| text integrity, format, build, lint, typecheck, boundaries, all unit tests (`pnpm verify`) | exit 0 |
| domain 143, application 213, API 48, web 67, mobile 180 tests (plus shared, config, database, integrations, worker) | PASS |
| `pnpm test:integration` (database 194, API 74 + 1 skipped, worker 9 + 1 skipped) | exit 0 |
| Playwright | 9/9 PASS |
| Expo Android export, web production build, client-bundle check | PASS |
| gitleaks on source | no leaks |

### Web Vitest worker-start failure recurred once

The first `pnpm verify` run failed only in `@tali/web#test`. Every web test file failed before running with
`[vitest-pool]: Failed to start forks worker ... Caused by: [vitest-pool-runner]: Timeout waiting for worker to
respond`. This included the unchanged `shell.test.tsx` and `ids.test.ts`, while Turbo was running other packages'
tests in parallel. No test ran, so no assertion failed. An immediate rerun without changes exited 0 (web: 6 files,
67 tests). This matches the host-saturation failure analysed in `docs/audits/build-1-slice-3.md`. As instructed, the
web Vitest config was not changed.

### Jest worker exit notice

Some full mobile Jest runs print "A worker process has failed to exit gracefully". The suite still passes and exits
0. The new code clears its request timers in `finally`, and every deferred test reply is resolved. The notice
appeared in one of four identical runs and has not been traced to a Slice 4 file.

## Deviations from ADR-002/004/005/006 and Plan 003

- **Currency is shown as the pilot value, not "chosen from the server's list"** (Plan 003 section 7). No
  currency-list endpoint exists, and the brief forbids backend expansion. NGN comes from the APPROVED mvp-scope
  pilot market as a single display constant. The server still validates it. Replace this with a server list when
  such an endpoint is approved. No ADR is affected.
- **Mobile modules live in `src/auth` and `src/api`, not `src/lib/auth`** (Plan 003 section 7), matching the
  existing mobile layout. Web uses `src/lib/auth` as planned.
- **Invitations are not in the web or mobile flow** (Plan 003 section 7 lists them as P1). They belong to Slice 5.
- **Playwright now runs the API and web in `local` mode** instead of `test` mode, because local sign-in is legitimately
  available only there (ADR-005, Slice 3 gating). The database is still the disposable test database.
- **New boundary rules** (listed above) tighten ADR-002 section 6 and do not change it.
- No deviation from ADR-002, ADR-004, ADR-005 or ADR-006.

## Residual risks

- If a CreateBusiness succeeds but its response is lost, and the user then *edits* the details before retrying, the
  edited submission gets a new key and can create a second business. An unedited retry reuses the key and is safe.
  The form tells the user that retrying unchanged details does not create a duplicate.
- The session is lost on every reload or app restart. This is intended for Build 1 and is not a defect.
- The session store and API client are duplicated in both apps. Changes must be made twice until a shared,
  client-only package is approved.

## Anything blocking Slice 5 or Slice 6

Nothing in Slice 4 blocks Slice 5. Slice 6 (Cognito) remains blocked on ADR-003, as before. Slice 5 will need to
decide how mobile device credentials are stored (for example secure storage), which is a reviewed dependency;
Slice 4 deliberately adds none.
