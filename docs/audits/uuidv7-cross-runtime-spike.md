# UUIDv7 cross-runtime spike

- Date: 2026-09-28 (Wave C; the Node.js part started in Wave B)
- Scope: ADR-002 section 14 (UUID strategy) and section 10 check 2; plan
  `docs/plans/002-wave-c-compatibility-checks.md` section 2. This file is the
  implementation note section 14 requires before a production `IdGenerator` adapter is used.
- Candidate: `uuid@14.0.2`, function `v7()` called with no options.
- Runtimes: Node.js 24.21.0; Chromium (Playwright 1.63.0 headless shell) running the
  Next.js 16.3.6 production build; Hermes (React Native 0.86.3, Expo SDK 57) in an
  Android release build on the `Pixel6aAPI30` emulator (API 30, x86_64).

## Result: PASS, one implementation for all three runtimes

The same library, the same function and the same options generate IDs on all three
runtimes, so identity semantics do not differ between server, browser and device. ADR-002
does not need to change.

| Check (ADR-002 section 14) | Node.js | Browser (Next.js) | Expo / Hermes release |
| --- | --- | --- | --- |
| Version 7 and RFC variant bits | PASS | PASS | PASS |
| Canonical lowercase | PASS | PASS | PASS |
| Unique under bulk generation (10,000 in the browser and on device, contract suite on Node.js) | PASS | PASS | PASS |
| Strictly increasing for sequential calls in one process | PASS | PASS | PASS |
| Randomness only from `crypto.getRandomValues` (calls counted during generation) | 1,000 calls for 1,000 IDs, 0 `Math.random` | 10,000 calls for 10,000 IDs, 0 `Math.random` | 10,000 calls for 10,000 IDs, 0 `Math.random` |
| Fails loudly without a secure source | throws | refuses (reported on the page) | `SecureRandomUnavailableError` (Jest; see below) |
| `describeIdGeneratorContract` (`@tali/application/testing/contracts`) | PASS | n/a (see limitations) | n/a (see limitations) |

## How randomness is supplied on each runtime

`uuid@14` reads the **global** `crypto.getRandomValues` (both its `dist/rng.js` browser
build and its `dist-node/rng.js` Node build contain only
`return crypto.getRandomValues(rnds8);`). A search of the whole installed package finds no
`Math.random`.

- **Node.js 24:** global Web Crypto. Package export condition `node` (`dist-node`).
- **Browser:** the browser's Web Crypto. Next.js resolves the `default` condition (`dist`).
- **Hermes:** Hermes has no Web Crypto. `apps/mobile/src/ids/secure-random.ts`
  (`installSecureRandom`, called once in `app/_layout.tsx`) installs `expo-crypto`'s
  native `getRandomValues` (Android `SecureRandom`) as `globalThis.crypto.getRandomValues`,
  **only when the runtime has none**, and never installs a non-cryptographic source. It
  accepts only integer typed arrays, as Web Crypto does. Metro resolves the `default`
  condition (`dist`). The device report shows `randomSource: "expo-crypto"`.

## Evidence

- **Node.js:** `apps/api/test/compat/uuidv7-node.test.ts` (4 tests): the contract suite
  with `newId: (entity) => parseId(entity, v7())`, 1,000 IDs with call counting, and a
  test that stubs `crypto` to `undefined` and expects generation to throw.
- **Browser:** `apps/web/e2e/uuidv7-browser.spec.ts` drives the non-production
  `/diagnostics/runtime` page of the production build. It expects
  `randomSourceCalls: { getRandomValues: 10000, mathRandom: 0 }`, `passed: true`, and a
  refusal when `crypto` is removed. Counting wraps both functions only while IDs are
  generated. Across the whole page, React DOM itself calls `Math.random` twice for
  internal property names (`__reactFiber$...`); those calls are outside generation and
  unrelated to IDs.
- **Expo / Hermes:** the device run described in `bigint-hermes-compatibility.md`. The
  `uuidV7` section of the logged report:

  ```json
  { "status": "complete", "randomSource": "expo-crypto",
    "checks": { "count": 10000, "allUuidV7": true, "allRfcVariant": true, "allCanonical": true,
                "unique": true, "strictlyIncreasing": true,
                "randomSourceCalls": { "getRandomValues": 10000, "mathRandom": 0 }, "passed": true } }
  ```

- **Mobile Jest:** `apps/mobile/test/ids.test.ts` covers the install rules (keeps a
  platform implementation, installs once, rejects float arrays), refusal with no source
  (`SecureRandomUnavailableError`), and 10,000 IDs through the expo-crypto path. The
  native module is stood in for by Node's Web Crypto in Jest.

## Package review (plan 002 section 2, item 4)

- MIT licence, no runtime dependencies, no install scripts, about 28 KB of JavaScript in
  `dist`. Widely used and actively maintained.
- Pinned exactly (`14.0.2`) through `saveExact`.

## Limitations

- **Monotonic state is per process.** `v7()` keeps a module-level sequence so sequential
  IDs in one process are strictly increasing. Ordering across devices or processes is only
  approximate (millisecond timestamp), as ADR-002 section 14 already states. Timestamps in
  IDs are never business time.
- **Contract suite on client runtimes.** `describeIdGeneratorContract` is a Vitest suite in
  `@tali/application`, which clients must not import. The browser and device checks
  therefore run an equivalent check list (`checkIdGenerator` in each client's
  `src/ids/id-checks.ts`: version, variant, canonical form, 10,000 unique, strictly
  increasing, secure-source-only) rather than the suite itself.
- **The refusal path on Hermes** was tested in Jest, not on the device, because the release
  build always has `expo-crypto` installed. The code path is the same function.
- **No production `IdGenerator` adapter yet.** This spike selects the implementation. The
  server adapter is written when the first module needs identifiers (Build 1).
