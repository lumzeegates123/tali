# Foundation Wave C: web and mobile clients, compatibility checks

- Date: 2026-09-28
- Scope: `docs/plans/002-wave-c-compatibility-checks.md` and the approved Wave C request: the
  Next.js web shell, the Expo Android shell, client configuration and secret isolation, the
  bigint/Hermes and UUIDv7 spikes, web end-to-end testing, boundary enforcement for clients and
  CI. No business features, authentication, Cognito, offline storage or AWS resources.
- Detailed reports: `bigint-hermes-compatibility.md` and `uuidv7-cross-runtime-spike.md` (this
  folder).

## Summary

| Area | Result |
| --- | --- |
| Next.js in the monorepo | PASS |
| Expo / React Native Android in the monorepo (pnpm, Metro) | PASS, with one narrow `packageExtensions` entry |
| Clients import only client-safe packages | PASS (ESLint, dependency-cruiser, resolution test, probes) |
| Both clients call the API health endpoint | PASS (Playwright; Android release build on an emulator) |
| bigint Money on Hermes | PASS (39 cases byte-identical to Node.js on the device) |
| UUIDv7 in Node.js, browser and Hermes | PASS (one library, `uuid@14.0.2` `v7()`) |
| Web end-to-end testing | PASS (Playwright 6/6 against the compiled API and PostgreSQL) |
| Client-bundle secret check | PASS, and proven to catch three kinds of deliberate leak |
| Complete foundation verification | PASS (see counts below) |

## Versions

Next.js 16.3.6 (App Router, Turbopack build), React 19.2.3, Vitest 5.0.2 with jsdom 30.1.1 and
React Testing Library 16.3.3, Playwright 1.63.0 (Chromium headless shell). Expo SDK 57.0.25,
React Native 0.86.3 (Hermes), expo-router 57.0.23, expo-crypto 57.0.3, jest-expo 57.0.5 on
Jest 29.7.0, React Native Testing Library 14.0.1. `uuid` 14.0.2. Node.js 24.21.0, pnpm 11.28.0,
TypeScript 6.0.3.

## Next.js (`apps/web`)

- App Router, strict TypeScript (`tooling/typescript/nextjs.json`). Pages: `/` (shell, environment
  panel, API health) and `/diagnostics/runtime` (UUIDv7 checks; returns 404 in production).
- The environment panel shows environment, API base URL and whether Cognito client settings are
  configured. It is hidden in production. A configuration problem lists the offending keys only,
  never values.
- `src/lib/api-client/tali-api-client.ts`: typed client over the shared `ReadinessResponseSchema`
  and `ErrorEnvelopeSchema` from `@tali/shared` (no schema duplicated in the clients). The base URL
  comes from `@tali/config/public`; every request sends a fresh `x-correlation-id` (Web Crypto
  `randomUUID`), reads the echoed ID, and maps outcomes to `ready`, `not-ready` (503 contract
  response), `api-error` (error envelope), `invalid-response` and `unavailable` (network or
  timeout). The health component renders loading, ready, not ready and unavailable/error states.
- No sign-in, no business screens, no route handlers or server actions: the web app is not a second
  backend.
- API change: CORS now exposes `x-correlation-id` so the browser can read it
  (`apps/api/src/bootstrap.ts`), covered by a new integration test (allowed origin can send and
  read it; an unlisted origin is not granted).

## Expo / Metro (`apps/mobile`)

- Expo Router with `app/_layout.tsx`, `app/index.tsx` (shell and API health) and
  `app/diagnostics.tsx` (runtime report; unavailable in production). Android package
  `com.tali.mobile`, scheme `tali`.
- `app.config.ts` runs the build-time guard (`@tali/config/public-build`) and allows cleartext HTTP
  only for `local` and `test` builds (via `expo-build-properties`); deployed environments require
  https.
- **pnpm and Metro.** The simplest configuration works: pnpm's default isolated layout, no hoisting
  settings, no `metro.config.js`. `expo export --platform android` bundles 1,343 modules to Hermes
  bytecode, and the Gradle release build succeeds.
- **One concrete failure and its narrow fix.** `expo-router` depends on
  `react-native-drawer-layout`, which declares `react-native-reanimated` and
  `react-native-gesture-handler` as required peers. With pnpm's peer auto-install they were
  installed at versions incompatible with Expo SDK 57 (reanimated 4.7 with worklets 0.13), breaking
  installation under `strictPeerDependencies`. The app uses no drawer navigator.
  `pnpm-workspace.yaml` marks exactly those two peers of that one package optional
  (`packageExtensions`). No hoisting, no `node-linker` change.
- `react-dom` is pinned to the React version in the mobile package because Expo Router's web
  support peers on it; `test-renderer` 1.2.0 is pinned for React Native Testing Library 14.
- **Local native build note (not a repository change).** On Windows, the Android SDK's default
  CMake 3.22.1 failed with `ninja: error: manifest 'build.ninja' still dirty after 100 tries` in
  `react-native-screens` and `expo-modules-core`. Installing SDK CMake 3.31.6 and pointing the
  generated project at it (`cmake.dir` in `apps/mobile/android/local.properties`, which is
  gitignored) fixed it. CI does not run a native build.

## Web testing

- Vitest + React Testing Library (`apps/web/test`, 20 tests): API client mapping (ready, not ready,
  error envelope, invalid response, network failure, timeout, correlation IDs), the shell and health
  states, UUIDv7 checks, and client safety (declared dependencies, no non-public `process.env`
  reads).
- Playwright (`apps/web/e2e`, 6 tests) starts the compiled API against the test database and a
  production build of the web app on dedicated ports: ready with the echoed correlation ID;
  unavailable; not ready when the API reports the database down (API response intercepted);
  recovery; browser UUIDv7 generation; refusal without Web Crypto.

## Mobile testing

Jest with jest-expo and React Native Testing Library, 11 suites, 138 tests, in two projects:

- `mobile`: API client (6), shell and health states (9), configuration (5), UUIDv7 and secure
  random installation, kernel compatibility golden file, and client safety.
- `kernel-expo-babel`: the unchanged `@tali/domain` kernel suites run through the jest-expo Babel
  preset (Metro's transform). `vitest` imports map to a three-name shim.

Findings:

- `pnpm exec` sets `NODE_PATH` to pnpm's hoisted store directory and Jest's resolver follows it,
  so Jest could "resolve" backend packages that Metro cannot. The client-safety test therefore
  checks resolution in a separate Node.js process without `NODE_PATH`.
- React Native's Babel transform emits sloppy-mode modules under Jest; see
  `bigint-hermes-compatibility.md` (one kernel test adjusted).
- React Native Testing Library 14's `render` and `fireEvent` are asynchronous.
- No mobile end-to-end tool (Maestro/Detox) was chosen, per ADR-002 section 17.

## bigint / Hermes

PASS. Hermes release build on an Android 11 (API 30) x86_64 emulator: `typeof 1n === "bigint"`,
and 39 Money, parsing, rounding, allocation, mixed-currency, wire and business-date cases produce
output byte-identical to Node.js 24. No floating-point money anywhere. Details and the reproduce
procedure: `bigint-hermes-compatibility.md`.

## UUIDv7

PASS with one implementation: `uuid@14.0.2` `v7()` on Node.js, in the browser and on Hermes. On
Hermes, `expo-crypto`'s native generator is installed as `crypto.getRandomValues` only when the
runtime has none. 10,000 IDs on the device and in the browser: correct version and variant,
canonical, unique, strictly increasing, 10,000 `getRandomValues` calls and zero `Math.random`
calls. Generation throws without a secure source. ADR-002 is unchanged. Details:
`uuidv7-cross-runtime-spike.md`.

## Client configuration and secret isolation

Layers, from primary to defence in depth:

1. **Configuration split.** `@tali/config/public` (bundled into clients) reads only the explicit
   `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` keys it knows and no longer imports server variable names. The
   check that rejects secret-looking public variables moved to a new build-time entry point,
   `@tali/config/public-build`, used only by `next.config.ts` and `app.config.ts`, where the whole
   environment is visible. `server-keys.ts` gained the tooling-only database URLs.
2. **Import boundaries.** ESLint and dependency-cruiser forbid clients from importing
   `@tali/application`, `database`, `integrations`, `ai`, `api`, `worker`, `@tali/config/server`,
   any `@tali/domain` path other than `kernel`, Prisma, `pg`, `postgres`, NestJS and AWS SDKs, and
   forbid client runtime code (`apps/web/src`, `apps/mobile/src`, `apps/mobile/app`) from importing
   `@tali/config/public-build`. dependency-cruiser also stops public config from reaching server
   config.
3. **Resolution.** The clients declare only `@tali/config`, `@tali/domain`, `@tali/shared` (and
   `@tali/tsconfig`); client-safety tests prove backend packages do not resolve from either app.
4. **Build guards.** A public variable whose name looks secret or matches a server variable fails
   the web build and the Expo config.
5. **Client-bundle check** (`tooling/client-bundle-check`): builds the web app and exports the
   Android bundle with every forbidden server variable set to a unique canary value, resolves the
   public Expo app config, then scans the browser-delivered web output (static chunks and
   prerendered HTML/RSC), the Android export (including Hermes bytecode) and the public app config
   for 28 needles (server variable names, placeholder credentials, canaries) in UTF-8 and UTF-16LE.
   Result: clean (web 32 files, Android export 29 files, app config 1 file).

**Negative controls (all temporary, all reverted):**

- Server variable passed through Next's `env` option and rendered: caught in the prerendered HTML
  and RSC payloads.
- Server variable placed in the Expo config's `extra`: **not caught by the first version of the
  check**, because `expo export` does not write the app config. The check now also scans the
  resolved public app config, which native builds and update manifests embed, and catches it.
- Placeholder credential rendered by a mobile screen: caught inside the Hermes bytecode.

## Dependency-boundary verification

Temporary probe files in `apps/web/src`, `apps/mobile/src` and `apps/mobile/app` each imported
`@tali/application`, `@tali/config/server`, `@tali/config/public-build`, `@tali/domain`,
`@tali/database`, `@prisma/client`, `pg`, `@nestjs/core` and `@aws-sdk/client-s3`.

- ESLint: 30 errors, every import in every file (Prisma is reported by two rules).
- dependency-cruiser: 27 violations, every import in every file:
  `clients-only-client-safe-packages` (12), `client-runtime-not-to-public-build` (3) and
  `not-to-unresolvable` (12; the npm packages are not installed for the clients, so they cannot
  even resolve).

The probes were deleted; both tools are clean again.

## Complete verification (2026-09-28, Windows 11, local Docker PostgreSQL 18.6)

| Step | Result |
| --- | --- |
| Text integrity (UTF-8, no BOM, no null bytes) | 282 files, pass |
| Format (Prettier) | pass |
| Build (turbo) | 8/8 tasks |
| Lint (ESLint, zero warnings) | pass |
| Typecheck (turbo) | 16/16 tasks |
| Dependency boundaries | no violations |
| Unit tests (turbo) | 387 tests: domain 110, application 38, config 24, shared 7, database 5, api 18 (includes 4 Node.js UUIDv7), worker 11, web 20, mobile 138, text-integrity 12, client-bundle-check 4 |
| Migrations | `migrate deploy`, status up to date (2 migrations), drift check ok |
| verify-schema | pass (`foundation_spike` and `test_fixtures` absent) |
| Integration tests | database 82; api 24 (+1 skipped); worker 9 (+1 skipped) |
| Playwright | 6/6 |
| Mobile Android export | 1,343 modules, Hermes bytecode |
| Hermes release build on emulator | kernel report matches golden; UUIDv7 checks pass; health ready and unavailable states shown |
| Client-bundle check | clean (3 targets) |
| Secret scan (gitleaks 8.30.1) | No actual secret. `gitleaks git` (the repository-history check CI uses, and the authoritative one) applies the existing ADR-001 allowlist correctly. A Windows `gitleaks dir` run reported the allowlisted ADR-001 line because that mode did not apply the path-based exception consistently (path representation). An earlier draft of this audit copied that secret-looking ADR-001 wording into this file, which is not allowlisted, and CI flagged it; the wording has been removed |
| Prisma / `pg` outside `packages/database` | none |
| NestJS outside `apps/api`, `apps/worker` | none |
| AWS SDK, CDK, `infrastructure/` | none |
| Business tables | none (no Prisma models) |

The two skipped integration tests are the SIGTERM graceful-shutdown tests, skipped on Windows
since Wave B; they run on Linux CI.

## CI changes (`.github/workflows/ci.yml`)

- `checks` (existing) now also runs web and mobile lint, typecheck and unit tests, including the
  UUIDv7 tests, through turbo.
- New `web-e2e`: PostgreSQL service, role bootstrap, build, `migrate deploy`, Playwright Chromium
  headless shell, Playwright smoke run.
- New `client-bundles`: builds the client-safe packages, then runs the client-bundle check (web
  build, Expo Android export, public app config, scan).
- Not added: deployment, AWS OIDC or other cloud credentials, EAS builds, store publishing, an
  emulator/device job.

## Deviations from ADR-002 and plan 002

1. **New `@tali/config/public-build` entry point** (ADR-002 section 18 names `./server` and
   `./public`). It holds build-time checks that need server variable names, so that
   `./public`, which is bundled, no longer carries them. Clients' runtime code cannot import it.
2. **Kernel suites "unchanged" (plan 002 check 1.2).** One assertion in
   `packages/domain/src/kernel/money.test.ts` was relaxed: a write to a frozen Money must leave the
   value unchanged, and may throw `TypeError` (strict mode) or be ignored (sloppy mode under Jest).
3. **"Under jest-expo with the Hermes engine" (plan 002 check 1.2).** jest-expo executes on
   Node.js; it does not run Hermes. The suites prove Metro's Babel transform; engine behaviour is
   proven by the on-device run (plan 002 check 1.3), which is the ADR-002 section 10 requirement.
4. **Contract suite on client runtimes (plan 002 check 2.3).** `describeIdGeneratorContract` lives
   in `@tali/application`, which clients must not import; the browser and device run an equivalent
   check list instead.

None of these changes an ADR decision.

## Known limitations

- The on-device Hermes check is manual (emulator, API 30, x86_64 only); CI does not boot an
  emulator. A physical device and iOS are not covered.
- The web and mobile API clients are near-identical copies. `@tali/shared` holds wire contracts
  only, so there is no shared client package; revisit when a third consumer or `@tali/ui` appears.
- The monotonic UUIDv7 sequence is per process; cross-device ordering is approximate by design.
- The client-bundle check is a string scan and is defence in depth; the configuration split and
  boundaries are the primary protection.
- Local environment constraints during this wave: very low free disk space and memory, and an
  unresponsive Docker CLI (the containers kept serving). These did not change any result but slowed
  native builds.

## Blocking Foundation completion

Nothing in Wave C. Before relying on it in Build 1: commit the Wave C changes and confirm the new
CI jobs (`web-e2e`, `client-bundles`) pass on GitHub's Linux runners, which have not run yet.
