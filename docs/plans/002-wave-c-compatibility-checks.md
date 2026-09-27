# Wave C compatibility checks (mobile and web runtimes)

Status: **REQUIRED, NOT YET RUN.** Created in Wave A. These checks cannot run until the Expo and Next.js shells
exist (Wave C). Nothing here has passed yet, and no result may be claimed until the checks are executed on the
named runtimes.

Authority: ADR-002 section 10 (mobile compatibility acceptance checks) and section 14 (UUID strategy). This file
records how the checks will be executed; it does not change either decision.

## 1. bigint Money under Expo / Hermes

**Requirement.** `@tali/domain/kernel` must behave identically on Hermes (Android release build, then iOS later)
and on Node.js 24.

**Checks (all must pass on a Hermes release build on a real Android device or emulator):**

1. `typeof 1n === "bigint"` and bigint literals compile through Metro/Babel without transformation to `number`.
2. The full kernel unit suite (`packages/domain/src/kernel/*.test.ts`) passes under `jest-expo` with the Hermes
   engine, unchanged. The suites cover arithmetic beyond `Number.MAX_SAFE_INTEGER`, all rounding modes,
   largest-remainder allocation, strict parsing and deterministic decimal formatting.
3. The same Money operations run on-device (not only in Jest) in a debug screen or instrumentation test, and the
   results match Node.js output byte for byte (compare `toMinorUnitsString()` and `toDecimalString()` values).
4. `BigInt(string)` parsing and `bigint.toString()` behave identically for values up to the BIGINT range.
5. `Money.toJSON()` refuses implicit serialization on Hermes (no silent `number` conversion).
6. `BusinessDate.fromInstant` and `parseTimeZoneId` work on Hermes: `Intl.DateTimeFormat` with `timeZone`
   (e.g. `Africa/Lagos`) returns the correct calendar date. If Hermes Intl support is insufficient, record the gap;
   the fallback (e.g. a server-provided business date or an Intl polyfill) needs review before offline capture.

**If any check fails**, report it with evidence. Per ADR-002 section 10 the failure must be resolved (for example a
different engine setting or library) before Build 1; it is never worked around silently.

## 2. UUIDv7 implementation spike

**Wave A decision:** no UUIDv7 library was selected. The Wave A kernel only parses and validates identifiers
(`parseUuid`, `parseId`, `isUuidV7`); generation sits behind the `IdGenerator` port, and tests use the
deterministic `SequentialIdGenerator` fake. Selecting a library in Wave A would have been unverifiable without the
web and mobile shells.

**Spike (Wave B for Node.js, Wave C for browser and Expo).** Evaluate a candidate library or a small in-house
generator over the platform crypto APIs. Accept it only if every item holds on Node.js 24, a Next.js browser bundle
and an Expo/Hermes release build:

1. Randomness comes only from a cryptographically secure source: Web Crypto `crypto.getRandomValues`, Node.js
   `crypto`, or `expo-crypto`. Code review confirms there is no `Math.random` or other insecure fallback anywhere in
   the dependency.
2. When no secure source is available, generation throws; it never degrades silently.
3. The implementation passes `describeIdGeneratorContract` from `@tali/application/testing/contracts` on each
   runtime: version 7 and RFC variant bits, canonical lowercase form, uniqueness under bulk generation (at least
   10,000 IDs) and strictly increasing order for sequential calls within one process.
4. The package is small, maintained, has no install scripts and has a license compatible with the project.

The outcome (library or in-house, with evidence per runtime) is recorded as an implementation note against
ADR-002 section 14 before any production `IdGenerator` adapter is used.
